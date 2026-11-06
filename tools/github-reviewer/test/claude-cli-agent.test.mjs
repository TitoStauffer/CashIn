import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import {
  assertClaudePromptWithinBudget,
  assertIsolatedSession,
  CLAUDE_ISOLATION_SETTINGS,
  CLAUDE_SYSTEM_PROMPT,
  ClaudeStreamReader,
  claudeFailureDetail,
  createClaudeArgs,
  MAX_CLAUDE_PROMPT_BYTES,
  parseClaudeObservation,
  resolveClaudeExecutable,
} from '../dist/claude-cli-agent.js';
import { CODEX_OUTPUT_SCHEMA } from '../dist/codex-cli-agent.js';
import { resolveAgentRuntime } from '../dist/agent-runtime.js';

const SHA = 'a'.repeat(40);
const evidence = {
  reviewComplete: true,
  changedFilesReviewed: ['src/a.ts'],
  riskAreas: [],
  findings: [],
  acceptanceCriteria: [],
};
const initEvent = (overrides = {}) => ({ type: 'system', subtype: 'init', tools: [], mcp_servers: [], ...overrides });
const resultEvent = (overrides = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ignored free text',
  structured_output: { stage: 'codeReview', decision: 'APPROVED', commitSha: SHA, reportMarkdown: '### Code Review — APPROVED', evidence },
  ...overrides,
});

function observe(...events) {
  const reader = new ClaudeStreamReader();
  const stream = events.map((event) => typeof event === 'string' ? event : JSON.stringify(event)).join('\n');
  // Split arbitrarily to prove events spanning chunks are reassembled.
  const middle = Math.floor(stream.length / 2);
  reader.push(stream.slice(0, middle));
  reader.push(stream.slice(middle));
  return reader.end();
}

function valueAfter(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test('Claude runs isolated: no tools, MCP, hooks, memory, CLAUDE.md or default system prompt', () => {
  const args = createClaudeArgs();
  assert.deepEqual(args.slice(0, 4), ['-p', '--output-format', 'stream-json', '--verbose']);
  assert.equal(valueAfter(args, '--tools'), '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(valueAfter(args, '--setting-sources'), 'project');
  assert.deepEqual(JSON.parse(valueAfter(args, '--settings')), CLAUDE_ISOLATION_SETTINGS);
  assert.equal(CLAUDE_ISOLATION_SETTINGS.disableAllHooks, true);
  assert.equal(CLAUDE_ISOLATION_SETTINGS.autoMemoryEnabled, false);
  assert.ok(CLAUDE_ISOLATION_SETTINGS.claudeMdExcludes.includes('**/CLAUDE.md'));
  assert.equal(valueAfter(args, '--system-prompt'), CLAUDE_SYSTEM_PROMPT);
  assert.match(CLAUDE_SYSTEM_PROMPT, /no tools/);
  assert.deepEqual(JSON.parse(valueAfter(args, '--json-schema')), CODEX_OUTPUT_SCHEMA);
  assert.equal(args.some((arg) => /dangerously|bypass|allowedTools|--bare/i.test(arg)), false);
});

test('the session is accepted only when the CLI reports zero tools, zero MCP servers and no hooks', () => {
  assert.doesNotThrow(() => assertIsolatedSession(observe(initEvent(), resultEvent())));
  // The structured-output mechanism registered by --json-schema is the only tolerated tool.
  assert.doesNotThrow(() => assertIsolatedSession(observe(initEvent({ tools: ['StructuredOutput'] }), resultEvent())));
  assert.throws(() => assertIsolatedSession(observe(initEvent({ tools: ['StructuredOutput', 'Bash'] }), resultEvent())), /tools available/);
  assert.throws(() => assertIsolatedSession(observe(resultEvent())), /did not report its session configuration/);
  assert.throws(() => assertIsolatedSession(observe(initEvent({ tools: ['Bash'] }), resultEvent())), /tools available/);
  assert.throws(() => assertIsolatedSession(observe(initEvent({ tools: undefined }), resultEvent())), /tools available/);
  assert.throws(() => assertIsolatedSession(observe(initEvent({ mcp_servers: [{ name: 'gmail' }] }), resultEvent())), /MCP servers/);
  assert.throws(
    () => assertIsolatedSession(observe({ type: 'system', subtype: 'hook_response', hook_name: 'SessionStart:startup' }, initEvent(), resultEvent())),
    /executed hooks/,
  );
});

test('reads only the schema-validated structured output from an isolated successful session', () => {
  const result = parseClaudeObservation(observe(initEvent(), 'not json progress line', { type: 'assistant', message: 'model text' }, resultEvent()));
  assert.equal(result.decision, 'APPROVED');
  assert.equal(result.commitSha, SHA);
  assert.throws(() => parseClaudeObservation(observe(initEvent({ tools: ['Read'] }), resultEvent())), /tools available/);
  assert.throws(() => parseClaudeObservation(observe(initEvent())), /did not complete/);
  assert.throws(() => parseClaudeObservation(observe(initEvent(), resultEvent({ is_error: true }))), /did not complete/);
  assert.throws(() => parseClaudeObservation(observe(initEvent(), resultEvent({ subtype: 'error_max_turns' }))), /did not complete/);
  assert.throws(() => parseClaudeObservation(observe(initEvent(), resultEvent({ structured_output: undefined }))), /invalid structured result/);
  assert.throws(
    () => parseClaudeObservation(observe(initEvent(), resultEvent({ structured_output: { stage: 'codeReview', decision: 'APPROVED', commitSha: 'short', reportMarkdown: 'x', evidence } }))),
    /invalid structured result/,
  );
});

test('Claude prompt budget allows PRs above the Codex budget but still fails closed', () => {
  assert.equal(MAX_CLAUDE_PROMPT_BYTES, 2_000_000);
  assert.doesNotThrow(() => assertClaudePromptWithinBudget('x'.repeat(847_419)));
  assert.throws(() => assertClaudePromptWithinBudget('x'.repeat(MAX_CLAUDE_PROMPT_BYTES + 1)), /prompt budget/);
});

test('Claude failure diagnostics expose only structured fields, never model output or stderr content', () => {
  const failed = observe(initEvent(), resultEvent({ is_error: true, subtype: 'error_during_execution', api_error_status: 429, terminal_reason: 'api_error', result: 'secret model text' }));
  assert.equal(claudeFailureDetail(failed, 'stderr with secrets'), 'error_during_execution (HTTP 429), api_error');
  assert.equal(claudeFailureDetail(observe(initEvent()), 'stderr with secrets'), 'Claude Code CLI reported an execution error.');
  assert.equal(claudeFailureDetail(observe(initEvent(), resultEvent()), ''), '');
});

test('resolves the native Claude binary on Windows instead of the npm .cmd shim', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'claude-resolve-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const shimDirectory = join(root, 'nodejs');
  const native = join(shimDirectory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin');
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, 'claude.exe'), '');
  writeFileSync(join(shimDirectory, 'claude.cmd'), '');
  assert.equal(resolveClaudeExecutable({ PATH: [join(root, 'empty'), shimDirectory].join(delimiter) }, 'win32'), join(native, 'claude.exe'));
  assert.equal(resolveClaudeExecutable({ CLAUDE_EXECUTABLE: 'C:\\custom\\claude.exe', PATH: shimDirectory }, 'win32'), 'C:\\custom\\claude.exe');
  assert.equal(resolveClaudeExecutable({ PATH: '' }, 'linux'), 'claude');
  assert.throws(() => resolveClaudeExecutable({ PATH: join(root, 'empty') }, 'win32'), /not found/);
});

test('Claude Code is the default agent runtime and Codex stays available explicitly', () => {
  assert.equal(resolveAgentRuntime(undefined), 'claude');
  assert.equal(resolveAgentRuntime(' Claude '), 'claude');
  assert.equal(resolveAgentRuntime('codex'), 'codex');
  assert.throws(() => resolveAgentRuntime('gpt'), /AGENT_RUNTIME/);
});
