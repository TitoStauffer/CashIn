import { appendFile } from 'node:fs/promises';
import { loadAndValidateRecoverySource, parseAgentStage } from './agent-recovery-validation.js';

try {
  const sourceRunId = Number(required('SOURCE_RUN_ID'));
  if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 1) throw new Error('SOURCE_RUN_ID must be a positive integer.');
  const artifact = await loadAndValidateRecoverySource({
    fetchImpl: fetch,
    repository: required('GITHUB_REPOSITORY'),
    token: required('GITHUB_TOKEN'),
    sourceRunId,
    stage: parseAgentStage(required('AGENT_STAGE')),
  });
  const output = process.env.GITHUB_OUTPUT;
  if (output) await appendFile(output, `artifact_name=${artifact.artifactName}\nartifact_id=${artifact.artifactId}\n`, 'utf8');
  process.stdout.write(`Trusted orchestration artifact provenance validated for run attempt ${artifact.runAttempt}.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Could not validate recovery source.'}\n`);
  process.exitCode = 1;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}.`);
  return value;
}
