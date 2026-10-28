import { readFile } from 'node:fs/promises';
import { extractAcceptanceCriteria, isAgentStageResult, validateAgentResultCompleteness } from './agent-result-validation.js';

try {
  const stage = required('AGENT_STAGE');
  if (stage !== 'codeReview' && stage !== 'qa' && stage !== 'qualityGate') throw new Error('AGENT_STAGE is invalid.');
  const expectedCommitSha = required('EXPECTED_COMMIT_SHA');
  if (!/^[a-f0-9]{40}$/i.test(expectedCommitSha)) throw new Error('EXPECTED_COMMIT_SHA must be a full commit SHA.');
  const parsed: unknown = JSON.parse(await readFile(required('AGENT_RESULT_PATH'), 'utf8'));
  if (!isAgentStageResult(parsed)) throw new Error('Agent result has an invalid or incomplete envelope.');
  const result = parsed;
  const changedFiles = (await readFile(required('CHANGED_FILES_PATH'), 'utf8')).split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  const pullRequestBody = await readFile(required('PR_BODY_PATH'), 'utf8');
  const reasons = validateAgentResultCompleteness(result, {
    stage,
    commitSha: expectedCommitSha,
    changedFiles,
    acceptanceCriteria: extractAcceptanceCriteria(pullRequestBody),
  });
  if (reasons.length) throw new Error(`Preflight rejected the agent result:\n${reasons.map((reason) => `- ${reason}`).join('\n')}`);
  process.stdout.write(`Preflight approved ${stage} evidence for ${result.commitSha}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Agent preflight failed.'}\n`);
  process.exitCode = 1;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
