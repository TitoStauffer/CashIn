import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import {
  assertClaudePromptWithinBudget,
  claudeFailureDetail,
  createClaudeArgs,
  MAX_CLAUDE_PROMPT_BYTES,
  parseClaudeOutput,
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

function envelope(overrides = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ignored free text',
    structured_output: { stage: 'codeReview', decision: 'APPROVED', commitSha: SHA, reportMarkdown: '### Code Review — APPROVED', evidence },
    ...overrides,
  });
}

test('Claude runs without tools or MCP servers and validates output against the shared schema', () => {
  const args = createClaudeArgs();
  assert.deepEqual(args.slice(0, 3), ['-p', '--output-format', 'json']);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.ok(args.includes('--strict-mcp-config'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.deepEqual(JSON.parse(args[args.indexOf('--json-schema') + 1]), CODEX_OUTPUT_SCHEMA);
  assert.equal(args.some((arg) => /dangerously|bypass|allowedTools/i.test(arg)), false);
});

test('Claude prompt budget allows PRs above the Codex budget but still fails closed', () => {
  assert.equal(MAX_CLAUDE_PROMPT_BYTES, 2_000_000);
  assert.doesNotThrow(() => assertClaudePromptWithinBudget('x'.repeat(847_419)));
  assert.throws(() => assertClaudePromptWithinBudget('x'.repeat(MAX_CLAUDE_PROMPT_BYTES + 1)), /prompt budget/);
});

test('reads only the schema-validated structured output from a successful Claude result', () => {
  const result = parseClaudeOutput(envelope());
  assert.equal(result.decision, 'APPROVED');
  assert.equal(result.commitSha, SHA);
  assert.throws(() => parseClaudeOutput('not json'), /malformed JSON/);
  assert.throws(() => parseClaudeOutput(envelope({ is_error: true })), /did not complete/);
  assert.throws(() => parseClaudeOutput(envelope({ subtype: 'error_max_turns' })), /did not complete/);
  assert.throws(() => parseClaudeOutput(envelope({ structured_output: undefined })), /invalid structured result/);
  assert.throws(
    () => parseClaudeOutput(envelope({ structured_output: { stage: 'codeReview', decision: 'APPROVED', commitSha: 'short', reportMarkdown: 'x', evidence } })),
    /invalid structured result/,
  );
});

test('Claude failure diagnostics never echo model output or stderr content', () => {
  assert.equal(claudeFailureDetail(envelope({ is_error: true, subtype: 'error_during_execution', api_error_status: 429 }), ''), 'error_during_execution (HTTP 429)');
  assert.equal(claudeFailureDetail('free text with repository content', 'stderr with secrets'), 'Claude Code CLI reported an execution error.');
  assert.equal(claudeFailureDetail(envelope(), ''), '');
});

test('resolves the native Claude binary on Windows instead of the npm .cmd shim', () => {
  const root = mkdtempSync(join(tmpdir(), 'claude-resolve-'));
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
