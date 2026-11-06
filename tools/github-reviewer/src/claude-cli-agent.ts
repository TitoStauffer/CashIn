import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from 'node:child_process';
import type { AgentStage, AgentStageResult, OrchestrationContext } from './agent-orchestrator.js';
import { extractAcceptanceCriteria, failClosedIncompleteResult, isAgentEvaluationEvidence } from './agent-result-validation.js';
import { buildPrompt, CODEX_OUTPUT_SCHEMA, type AgentEvidenceInput } from './codex-cli-agent.js';

// The Claude models used by Claude Code expose a 1M-token window; this byte budget keeps the
// prompt far below it while allowing PRs that exceed the Codex budget.
export const MAX_CLAUDE_PROMPT_BYTES = 2_000_000;
const MAX_STREAM_LINE_BYTES = 8_000_000;

// Replaces Claude Code's default system prompt, which describes generic tools and environment
// features that are not available in this session.
export const CLAUDE_SYSTEM_PROMPT = [
  'You are a deterministic pull request quality agent.',
  'You have no tools: you cannot run commands, read or write files, browse, or call external services.',
  'Work only from the text supplied in the user message and return the structured result requested there.',
].join(' ');

// Parity with Codex --ignore-user-config: only the (empty) project scope is loaded, user and
// plugin hooks never run, auto-memory is off and no CLAUDE.md or rules file is read.
export const CLAUDE_ISOLATION_SETTINGS = {
  disableAllHooks: true,
  autoMemoryEnabled: false,
  claudeMdExcludes: ['**/CLAUDE.md', '**/CLAUDE.local.md', '**/.claude/rules/**'],
} as const;

interface ClaudeAgentResult {
  stage: AgentStage;
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'INCONCLUSIVE';
  commitSha: string;
  reportMarkdown: string;
  evidence: AgentStageResult['evidence'];
}

// Facts observed in the CLI event stream; only these are retained, never model text.
export interface ClaudeStreamObservation {
  init?: { tools: unknown; mcpServers: unknown };
  hookEvents: number;
  result?: Record<string, unknown>;
}

export async function executeClaudeAgent(
  stage: AgentStage,
  context: OrchestrationContext,
  signal: AbortSignal,
  evidence: AgentEvidenceInput,
): Promise<AgentStageResult> {
  const prompt = buildPrompt(stage, context, evidence);
  assertClaudePromptWithinBudget(prompt);
  // An empty temporary directory keeps project instructions, settings and hooks out of the session.
  const workDirectory = await mkdtemp(join(tmpdir(), 'cashin-claude-agent-'));
  try {
    const observation = await runClaude(prompt, workDirectory, signal);
    const parsed = parseClaudeObservation(observation);
    if (parsed.stage !== stage || parsed.commitSha.toLowerCase() !== context.commitSha.toLowerCase()) {
      throw new Error('Claude result does not match the requested stage and current SHA.');
    }
    return failClosedIncompleteResult(parsed, {
      stage,
      commitSha: context.commitSha,
      changedFiles: evidence.changedFiles ?? [],
      acceptanceCriteria: extractAcceptanceCriteria(evidence.pullRequest.body),
    });
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

export function assertClaudePromptWithinBudget(prompt: string): void {
  const bytes = Buffer.byteLength(prompt, 'utf8');
  if (bytes > MAX_CLAUDE_PROMPT_BYTES) {
    throw new Error(`Claude review context exceeds the supported prompt budget (${bytes}/${MAX_CLAUDE_PROMPT_BYTES} bytes).`);
  }
}

// No tools, no MCP servers, no user/plugin configuration, no persisted session, and the output
// validated against the same schema used for Codex. The stream is checked at runtime
// (assertIsolatedSession) instead of trusting these flags alone.
export function createClaudeArgs(): string[] {
  return [
    '-p',
    '--output-format', 'stream-json',
    '--verbose',
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--setting-sources', 'project',
    '--settings', JSON.stringify(CLAUDE_ISOLATION_SETTINGS),
    '--system-prompt', CLAUDE_SYSTEM_PROMPT,
    '--json-schema', JSON.stringify(CODEX_OUTPUT_SCHEMA),
  ];
}

export function resolveClaudeExecutable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  const configured = env.CLAUDE_EXECUTABLE?.trim();
  if (configured) return configured;
  if (platform !== 'win32') return 'claude';
  // On Windows the npm shim is a .cmd file, which cannot be spawned without a shell; use the
  // native binary the shim points to.
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)) {
    const native = join(directory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(native)) return native;
    const direct = join(directory, 'claude.exe');
    if (existsSync(direct)) return direct;
  }
  throw new Error('Claude Code CLI was not found. Install it or set CLAUDE_EXECUTABLE.');
}

export class ClaudeStreamReader {
  private buffer = '';
  readonly observation: ClaudeStreamObservation = { hookEvents: 0 };

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      this.consume(this.buffer.slice(0, newline));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > MAX_STREAM_LINE_BYTES) throw new Error('Claude Code CLI produced an oversized stream event.');
  }

  end(): ClaudeStreamObservation {
    if (this.buffer.trim()) this.consume(this.buffer);
    this.buffer = '';
    return this.observation;
  }

  private consume(line: string): void {
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (event.type === 'system' && event.subtype === 'init') {
      this.observation.init = { tools: event.tools, mcpServers: event.mcp_servers };
    } else if (event.type === 'system' && typeof event.subtype === 'string' && event.subtype.startsWith('hook_')) {
      this.observation.hookEvents += 1;
    } else if (event.type === 'result') {
      this.observation.result = event;
    }
  }
}

// --json-schema is implemented by a CLI-internal tool that only returns the structured result;
// it grants no shell, file, network or MCP access. Any other tool is rejected.
export const CLAUDE_ALLOWED_SESSION_TOOLS: readonly string[] = ['StructuredOutput'];

// Fails closed unless the CLI reported a session with no tools beyond the structured-output
// mechanism, zero MCP servers and no hooks.
export function assertIsolatedSession(observation: ClaudeStreamObservation): void {
  const init = observation.init;
  if (!init) throw new Error('Claude Code CLI did not report its session configuration.');
  if (!Array.isArray(init.tools) || init.tools.some((tool) => !CLAUDE_ALLOWED_SESSION_TOOLS.includes(String(tool)))) {
    throw new Error('Claude session started with tools available; refusing to use its result.');
  }
  if (!Array.isArray(init.mcpServers) || init.mcpServers.length > 0) {
    throw new Error('Claude session started with MCP servers available; refusing to use its result.');
  }
  if (observation.hookEvents > 0) {
    throw new Error('Claude session executed hooks; refusing to use its result.');
  }
}

function runClaude(prompt: string, workDirectory: string, signal: AbortSignal): Promise<ClaudeStreamObservation> {
  const executable = resolveClaudeExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, createClaudeArgs(), {
      cwd: workDirectory,
      env: claudeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const reader = new ClaudeStreamReader();
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, value?: ClaudeStreamObservation) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value ?? reader.observation);
    };
    const abort = () => {
      child.kill();
      finish(new Error('Claude execution was cancelled.'));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(new Error('Could not start the Claude Code CLI.')));
    child.stdout?.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk.toString('utf8'));
      } catch (error) {
        child.kill();
        finish(error instanceof Error ? error : new Error('Claude Code CLI stream could not be read.'));
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000);
    });
    child.once('close', (code) => {
      const observation = reader.end();
      if (code !== 0) {
        const detail = claudeFailureDetail(observation, stderr);
        return finish(new Error(`Claude Code CLI exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : '.'}`));
      }
      finish(undefined, observation);
    });
    child.stdin.end(prompt, 'utf8');
  });
}

// Only structured error fields are surfaced; model output and stderr content are never echoed.
export function claudeFailureDetail(observation: ClaudeStreamObservation, stderr: string): string {
  const result = observation.result;
  if (result?.is_error === true) {
    const status = typeof result.api_error_status === 'number' ? ` (HTTP ${result.api_error_status})` : '';
    const subtype = typeof result.subtype === 'string' ? result.subtype : 'error';
    const terminal = typeof result.terminal_reason === 'string' ? `, ${result.terminal_reason}` : '';
    return `${subtype}${status}${terminal}`.slice(0, 200);
  }
  return stderr.trim() ? 'Claude Code CLI reported an execution error.' : '';
}

export function parseClaudeObservation(observation: ClaudeStreamObservation): ClaudeAgentResult {
  assertIsolatedSession(observation);
  const envelope = observation.result;
  if (!envelope || envelope.is_error === true || envelope.subtype !== 'success') {
    throw new Error('Claude Code CLI did not complete successfully.');
  }
  const result = envelope.structured_output;
  if (!isRecord(result)
    || !['codeReview', 'qa', 'qualityGate'].includes(String(result.stage))
    || !['APPROVED', 'CHANGES_REQUESTED', 'INCONCLUSIVE'].includes(String(result.decision))
    || typeof result.commitSha !== 'string'
    || !/^[a-f0-9]{40}$/i.test(result.commitSha)
    || typeof result.reportMarkdown !== 'string'
    || !result.reportMarkdown.trim()
    || !isAgentEvaluationEvidence(result.evidence)) {
    throw new Error('Claude returned an invalid structured result.');
  }
  return result as unknown as ClaudeAgentResult;
}

function claudeEnvironment(): NodeJS.ProcessEnv {
  // Credentials for Claude Code live under the user profile; GitHub tokens are never forwarded.
  const allowed = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME',
    'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'CLAUDE_CONFIG_DIR',
  ];
  const environment: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return environment;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
