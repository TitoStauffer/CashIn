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
const MAX_CAPTURED_STDOUT = 4_000_000;

interface ClaudeAgentResult {
  stage: AgentStage;
  decision: 'APPROVED' | 'CHANGES_REQUESTED' | 'INCONCLUSIVE';
  commitSha: string;
  reportMarkdown: string;
  evidence: AgentStageResult['evidence'];
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
    const output = await runClaude(prompt, workDirectory, signal);
    const parsed = parseClaudeOutput(output);
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

// No tools (so PR-controlled text cannot run commands or read runner files), no MCP servers,
// no persisted session, and the output validated against the same schema used for Codex.
export function createClaudeArgs(): string[] {
  return [
    '-p',
    '--output-format', 'json',
    '--tools', '',
    '--strict-mcp-config',
    '--no-session-persistence',
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

function runClaude(prompt: string, workDirectory: string, signal: AbortSignal): Promise<string> {
  const executable = resolveClaudeExecutable();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, createClaudeArgs(), {
      cwd: workDirectory,
      env: claudeEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value ?? '');
    };
    const abort = () => {
      child.kill();
      finish(new Error('Claude execution was cancelled.'));
    };
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    child.once('error', () => finish(new Error('Could not start the Claude Code CLI.')));
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-MAX_CAPTURED_STDOUT);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000);
    });
    child.once('close', (code) => {
      if (code !== 0) {
        const detail = claudeFailureDetail(stdout, stderr);
        return finish(new Error(`Claude Code CLI exited with code ${code ?? 'unknown'}${detail ? `: ${detail}` : '.'}`));
      }
      finish(undefined, stdout);
    });
    child.stdin.end(prompt, 'utf8');
  });
}

// Only structured error fields are surfaced; model output and stderr content are never echoed.
export function claudeFailureDetail(stdout: string, stderr: string): string {
  try {
    const envelope = JSON.parse(stdout.trim()) as Record<string, unknown>;
    if (envelope.is_error === true) {
      const status = typeof envelope.api_error_status === 'number' ? ` (HTTP ${envelope.api_error_status})` : '';
      const subtype = typeof envelope.subtype === 'string' ? envelope.subtype : 'error';
      return `${subtype}${status}`.slice(0, 200);
    }
  } catch {
    // Fall through to the generic stderr message.
  }
  return stderr.trim() ? 'Claude Code CLI reported an execution error.' : '';
}

export function parseClaudeOutput(stdout: string): ClaudeAgentResult {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    throw new Error('Claude Code CLI returned malformed JSON.');
  }
  if (!isRecord(envelope) || envelope.is_error === true || envelope.subtype !== 'success') {
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
