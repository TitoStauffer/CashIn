import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mergeReadinessWorkflow = await readFile(new URL('../../../.github/workflows/merge-readiness.yml', import.meta.url), 'utf8');
const reviewSignalWorkflow = await readFile(new URL('../../../.github/workflows/pr-review-signal.yml', import.meta.url), 'utf8');
const titleWorkflow = await readFile(new URL('../../../.github/workflows/pr-title.yml', import.meta.url), 'utf8');
const ciWorkflow = await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8');
const orchestrationWorkflow = await readFile(new URL('../../../.github/workflows/agent-orchestration.yml', import.meta.url), 'utf8');
const recoveryWorkflow = await readFile(new URL('../../../.github/workflows/agent-report-recovery.yml', import.meta.url), 'utf8');

function assertOrchestrationCheckoutsOmitRef(workflow) {
  assert.equal([...workflow.matchAll(/uses:\s*actions\/checkout@/g)].length, 6);
  assert.doesNotMatch(workflow, /^\s+ref\s*:/m);
}

test('serializes merge-readiness publications for the same pull request', () => {
  const concurrencyGroup = mergeReadinessWorkflow.match(/^\s+group:\s*(.+)$/m)?.[1] ?? '';

  assert.match(concurrencyGroup, /github\.event\.pull_request\.number/);
  assert.match(concurrencyGroup, /github\.event\.issue\.number/);
  assert.match(concurrencyGroup, /github\.event\.workflow_run\.pull_requests\[0\]\.number/);
  assert.match(concurrencyGroup, /inputs\.pr_number/);
  assert.match(mergeReadinessWorkflow, /^\s+cancel-in-progress:\s*false\s*$/m);
});

test('sequences PR metadata, implementation checks, SonarQube and agent orchestration', () => {
  assert.match(ciWorkflow, /^  pr-title:\s*$/m);
  assert.match(ciWorkflow, /^  automation-tools:\s*\r?\n(?:\s+#.*\r?\n)*\s+name: GitHub Reviewer\s*\r?\n\s+needs: pr-title/m);
  assert.match(ciWorkflow, /^  api:\s*\n\s+name: API\s*\n\s+needs: pr-title/m);
  assert.match(ciWorkflow, /^  web:\s*\n\s+name: Web\s*\n\s+needs: pr-title/m);
  assert.match(ciWorkflow, /^  sonarqube:[\s\S]*?^\s+needs: \[api, web, automation-tools\]\s*$/m);
  assert.match(orchestrationWorkflow, /^\s+workflows: \[CI\]\s*$/m);
  assert.doesNotMatch(orchestrationWorkflow, /workflows: \[[^\]]*PR title/);
  assert.doesNotMatch(orchestrationWorkflow, /workflow_run\.actor\.login != vars\.CASHIN_APP_BOT_LOGIN/);
  assert.match(orchestrationWorkflow, /^\s+cancel-in-progress:\s*false\s*$/m);
  assert.match(ciWorkflow, /types:\s*\[opened, reopened, synchronize, ready_for_review\]/);
  assert.doesNotMatch(ciWorkflow, /types:\s*\[[^\]]*edited/);
  assert.match(titleWorkflow, /pull_request_target:/);
  assert.match(titleWorkflow, /types:\s*\[edited\]/);
  assert.match(titleWorkflow, /github\.actor != vars\.CASHIN_APP_BOT_LOGIN/);
  assert.match(titleWorkflow, /actions:\s*write/);
  assert.match(titleWorkflow, /statuses:\s*write/);
  assert.match(titleWorkflow, /statuses\/\$\{HEAD_SHA\}/);
  assert.match(titleWorkflow, /context='PR title'/);
  assert.match(titleWorkflow, /node dist\/ci-recovery-cli\.js/);
  assert.match(titleWorkflow, /ref:\s*master/);
  assert.match(titleWorkflow, /persist-credentials:\s*false/);
  assert.match(ciWorkflow, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/pulls\/\$\{PR_NUMBER\}"/);
  assert.match(mergeReadinessWorkflow, /workflows:\s*\[CI, PR Review Signal\]/);
  assert.doesNotMatch(mergeReadinessWorkflow, /workflows:\s*\[[^\]]*PR title/);
  assert.doesNotMatch(mergeReadinessWorkflow, /pull_request_target:/);
  assert.match(mergeReadinessWorkflow, /### Codex — Quality Gate Coordinator/);
  assert.doesNotMatch(mergeReadinessWorkflow, /### Codex — QA Agent|### Code Review —|### Code Review -/);
});

test('formal review relay listens to review changes and has no permissions or privileged steps', () => {
  assert.match(reviewSignalWorkflow, /pull_request_review:\s*\n\s+types:\s*\[submitted, edited, dismissed\]/);
  assert.match(reviewSignalWorkflow, /^permissions:\s*\{\}\s*$/m);
  assert.match(reviewSignalWorkflow, /^\s+permissions:\s*\{\}\s*$/m);
  assert.doesNotMatch(reviewSignalWorkflow, /uses:\s*actions\/checkout|secrets\./);
});

test('recovers only an existing agent artifact without calling Codex', () => {
  assert.match(recoveryWorkflow, /workflow_dispatch:/);
  assert.match(recoveryWorkflow, /node dist\/agent-recovery-cli\.js/);
  assert.match(recoveryWorkflow, /run-id:\s*\$\{\{ inputs\.source_run_id \}\}/);
  assert.match(recoveryWorkflow, /artifact-ids:\s*\$\{\{ steps\.source\.outputs\.artifact_id \}\}/);
  assert.match(recoveryWorkflow, /merge-multiple:\s*true/);
  assert.match(recoveryWorkflow, /node dist\/agent-publish-cli\.js/);
  assert.ok(recoveryWorkflow.indexOf('node dist/agent-recovery-cli.js') < recoveryWorkflow.indexOf('uses: actions/download-artifact@'));
  assert.match(recoveryWorkflow, /ref:\s*master/);
  assert.match(recoveryWorkflow, /persist-credentials:\s*false/);
  assert.doesNotMatch(recoveryWorkflow, /agent-stage-cli|codex\s+exec|runs-on:\s*\[self-hosted/);
  assert.doesNotMatch(recoveryWorkflow, /git\s+(?:commit|push)|contents:\s*write/);
});

// DEV-116: the light track skips QA, the only model stage on the serialized self-hosted runner. Every
// condition below has to fail closed, because the consequence of a wrong one is a merge without QA.
test('skips QA only on a confirmed light track and keeps the Coordinator on both', () => {
  // The repository stores workflows with CRLF, so every line break here has to allow the carriage
  // return: a bare \n silently matches nothing and the assertions below would never run.
  const condition = (job, terminator) => orchestrationWorkflow
    .match(new RegExp(`^  ${job}:[\\s\\S]*?^\\s+if: >-\\r?\\n([\\s\\S]*?)^\\s+${terminator}`, 'm'))?.[1] ?? '';
  const qaCondition = condition('qa', 'runs-on:');
  const gateCondition = condition('quality-gate', 'runs-on:');
  const finalCondition = condition('final-status', 'run: exit 1');
  // Guards against the silent-empty-match trap above.
  for (const [name, value] of [['qa', qaCondition], ['quality-gate', gateCondition], ['final-status', finalCondition]]) {
    assert.ok(value.trim().length > 0, `condição do job ${name} não foi localizada no workflow`);
  }

  // The track is produced by the trusted CLI as a job output, never read from the PR body.
  assert.match(orchestrationWorkflow, /^\s+review_track: \$\{\{ steps\.stage\.outputs\.review_track \}\}\s*$/m);
  assert.doesNotMatch(orchestrationWorkflow, /review_track:\s*\$\{\{\s*github\.event[^}]*body/);

  // QA is skipped only when the track is a confirmed 'light'; anything else runs it.
  assert.match(qaCondition, /needs\.code-review\.outputs\.review_track != 'light'/);
  assert.doesNotMatch(qaCondition, /review_track == 'full'/);

  // The Coordinator runs on both tracks, so it needs !cancelled() to survive a skipped need, and on the
  // light track it demands that QA was genuinely skipped rather than failed.
  assert.match(gateCondition, /!cancelled\(\)/);
  assert.match(gateCondition, /review_track == 'light' && needs\.qa\.result == 'skipped'/);
  assert.match(gateCondition, /review_track == 'full' && needs\.publish-qa\.result == 'success' && needs\.qa\.outputs\.decision == 'APPROVED'/);

  // The QA artifact only exists on the full track.
  assert.match(orchestrationWorkflow, /^\s+- name: Download QA result\s*\n\s+if: needs\.code-review\.outputs\.review_track == 'full'\s*$/m);

  // Final confirmation: QA required when full, genuinely skipped when light, and an absent or unknown
  // track fails closed instead of reading as "not full".
  assert.match(finalCondition, /review_track == 'full' &&\s*\n?\s*\(needs\.qa\.outputs\.decision != 'APPROVED'/);
  assert.match(finalCondition, /review_track == 'light' &&\s*\n?\s*\(needs\.qa\.result != 'skipped'/);
  assert.match(finalCondition, /review_track != 'full' &&\s*\n?\s*needs\.code-review\.outputs\.review_track != 'light'/);
  assert.match(finalCondition, /needs\.quality-gate\.outputs\.decision != 'APPROVED'/);
});

test('pins orchestration runtime and isolates deterministic consolidation from Codex', () => {
  assertOrchestrationCheckoutsOmitRef(orchestrationWorkflow);
  const workflowWithExplicitRef = orchestrationWorkflow.replace(/^\s+token:/m, '          ref: master\n          token:');
  assert.throws(() => assertOrchestrationCheckoutsOmitRef(workflowWithExplicitRef), { name: 'AssertionError' });
  assert.doesNotMatch(orchestrationWorkflow, /github\.workflow_sha/);
  const coordinator = orchestrationWorkflow.split('  quality-gate:')[1].split('  publish-quality-gate:')[0];
  assert.match(coordinator, /runs-on: ubuntu-24.04/);
  assert.doesNotMatch(coordinator, /self-hosted|secrets\./);
  assert.match(orchestrationWorkflow, /retry_inconclusive:[\s\S]*?default: false/);
  assert.equal([...orchestrationWorkflow.matchAll(/cache-dependency-path:\s*tools\/github-reviewer\/package-lock\.json/g)].length, 6);
  assert.match(orchestrationWorkflow, /Fail when Code Review produced no structured result/);
  assert.match(orchestrationWorkflow, /Fail when QA produced no structured result/);
  assert.match(orchestrationWorkflow, /Fail when Quality Gate produced no structured result/);
  assert.equal([...orchestrationWorkflow.matchAll(/steps\.stage\.outcome == 'failure'[\s\S]*?steps\.stage\.outputs\.decision == ''/g)].length, 3);
});
