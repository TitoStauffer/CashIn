import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// DEV-66: the pull request owner is assigned by a trusted workflow. These tests run the real script against
// a fake `gh` on PATH, so the idempotency and failure handling are exercised, not just read.
const run = promisify(execFile);
const script = fileURLToPath(new URL('../../../.github/scripts/assign-pr-owner.sh', import.meta.url));
// Line endings are normalized: a Windows checkout with core.autocrlf turns the workflow into CRLF.
const workflow = (await readFile(new URL('../../../.github/workflows/pr-assignee.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

const FAKE_GH = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_GH_LOG"
if [[ "$*" == *"--method POST"* ]]; then
  if [[ -n "\${FAKE_POST_FAIL:-}" ]]; then echo "HTTP 403: Resource not accessible by integration" >&2; exit 1; fi
  printf '%s\\n' "$FAKE_UPDATED"
else
  if [[ -n "\${FAKE_GET_FAIL:-}" ]]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi
  printf '%s\\n' "$FAKE_CURRENT"
fi
`;

async function assign(scenario) {
  const dir = await mkdtemp(join(tmpdir(), 'pr-assignee-'));
  try {
    const gh = join(dir, 'gh');
    await writeFile(gh, FAKE_GH);
    await chmod(gh, 0o755);
    const log = join(dir, 'gh.log');
    const summary = join(dir, 'summary.md');
    await writeFile(log, '');
    await writeFile(summary, '');
    const { stdout } = await run('bash', [script], {
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env.PATH}`,
        REPOSITORY: 'TitoStauffer/CashIn', PR_NUMBER: '42', ASSIGNEE: 'TitoStauffer',
        GITHUB_STEP_SUMMARY: summary, FAKE_GH_LOG: log,
        FAKE_CURRENT: '', FAKE_UPDATED: '', ...scenario,
      },
    });
    const calls = (await readFile(log, 'utf8')).split(/\r?\n/).filter(Boolean);
    return { stdout, calls, posts: calls.filter((call) => call.includes('--method POST')), summary: await readFile(summary, 'utf8') };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('assigns the owner to a pull request that has no assignee', async () => {
  const result = await assign({ FAKE_CURRENT: '', FAKE_UPDATED: 'TitoStauffer' });
  assert.equal(result.posts.length, 1);
  assert.match(result.posts[0], /repos\/TitoStauffer\/CashIn\/issues\/42\/assignees/);
  assert.match(result.posts[0], /assignees\[\]=TitoStauffer/);
  assert.match(result.stdout, /TitoStauffer atribuído ao PR #42/);
  assert.doesNotMatch(result.stdout, /::warning/);
});

test('is idempotent: an owner already assigned, in any casing, is not written again', async () => {
  for (const current of ['TitoStauffer', 'titostauffer', 'someone TitoStauffer']) {
    const result = await assign({ FAKE_CURRENT: current });
    assert.equal(result.posts.length, 0, `no write expected when assignees are "${current}"`);
    assert.match(result.stdout, /já é responsável/);
  }
});

test('keeps other assignees and adds the owner next to them', async () => {
  const result = await assign({ FAKE_CURRENT: 'someone', FAKE_UPDATED: 'someone TitoStauffer' });
  assert.equal(result.posts.length, 1);
  assert.doesNotMatch(result.stdout, /::warning/);
});

test('reports API failures as a warning without failing the job or claiming the assignment', async () => {
  const cases = [
    ['reading the assignees fails', { FAKE_GET_FAIL: '1' }, 0, /Não foi possível ler os responsáveis/],
    ['the write is refused', { FAKE_POST_FAIL: '1' }, 1, /A API recusou a atribuição/],
    ['the API ignores the user', { FAKE_UPDATED: '' }, 1, /respondeu sem TitoStauffer/],
  ];
  for (const [name, scenario, posts, message] of cases) {
    const result = await assign(scenario);
    assert.equal(result.posts.length, posts, `${name}: write attempts`);
    assert.match(result.stdout, /::warning title=Responsável não atribuído::/, `${name}: warning annotation`);
    assert.match(result.stdout, message, `${name}: message`);
    assert.match(result.summary, message, `${name}: job summary`);
    assert.doesNotMatch(result.stdout, /atribuído ao PR #42\.$/m, `${name}: must not claim success`);
  }
});

test('the workflow runs only trusted code with the narrowest token it needs', () => {
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /types: \[opened, reopened\]/);
  assert.match(workflow, /^permissions: \{\}$/m);
  assert.match(workflow, /permissions:\n\s+contents: read\n(\s+#.*\n)*\s+issues: write\n/);
  assert.doesNotMatch(workflow, /pull-requests: write|contents: write/);
  // The checkout must be the default branch, sparse, without persisted credentials, and never the PR head.
  assert.match(workflow, /ref: \$\{\{ github\.event\.repository\.default_branch \}\}/);
  assert.match(workflow, /sparse-checkout: \.github\/scripts/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /github\.event\.pull_request\.head\.(sha|ref)/);
  assert.match(workflow, /run: bash \.github\/scripts\/assign-pr-owner\.sh/);
  assert.match(workflow, /ASSIGNEE: TitoStauffer/);
});
