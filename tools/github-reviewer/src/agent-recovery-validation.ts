import type { AgentStage } from './agent-orchestrator.js';
import { requestGitHubApi } from './github-api-client.js';

const TRUSTED_WORKFLOW_PATH = '.github/workflows/agent-orchestration.yml';

const STAGE_SOURCE = {
  codeReview: { job: 'Codex Code Review', uploadStep: 'Upload Code Review result', artifact: 'codex-code-review' },
  qa: { job: 'Codex QA', uploadStep: 'Upload QA result', artifact: 'codex-qa' },
  qualityGate: { job: 'Codex Quality Gate Coordinator', uploadStep: 'Upload Quality Gate result', artifact: 'codex-quality-gate' },
} as const satisfies Record<AgentStage, { job: string; uploadStep: string; artifact: string }>;

export interface RecoverySourceEvidence {
  run: Record<string, unknown>;
  jobs: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
}

export async function loadAndValidateRecoverySource(input: {
  fetchImpl: typeof fetch;
  repository: string;
  token: string;
  sourceRunId: number;
  stage: AgentStage;
}): Promise<string> {
  const path = `/repos/${input.repository}/actions/runs/${input.sourceRunId}`;
  const [run, jobsPayload, artifactsPayload] = await Promise.all([
    requestGitHubApi<Record<string, unknown>>(input.fetchImpl, path, input.token, { maxResponseBytes: 200_000 }),
    requestGitHubApi<Record<string, unknown>>(input.fetchImpl, `${path}/jobs?filter=all&per_page=100`, input.token, { maxResponseBytes: 1_000_000 }),
    requestGitHubApi<Record<string, unknown>>(input.fetchImpl, `${path}/artifacts?per_page=100`, input.token, { maxResponseBytes: 1_000_000 }),
  ]);
  const jobs = records(jobsPayload.jobs);
  const artifacts = records(artifactsPayload.artifacts);
  if (numberValue(jobsPayload.total_count) !== jobs.length || numberValue(artifactsPayload.total_count) !== artifacts.length) {
    throw new Error('Recovery source evidence exceeds the supported single-page boundary.');
  }
  return validateRecoverySource({
    repository: input.repository,
    sourceRunId: input.sourceRunId,
    stage: input.stage,
    evidence: { run, jobs, artifacts },
  });
}

export function validateRecoverySource(input: {
  repository: string;
  sourceRunId: number;
  stage: AgentStage;
  evidence: RecoverySourceEvidence;
}): string {
  const { repository, sourceRunId, stage, evidence } = input;
  const source = STAGE_SOURCE[stage];
  const runRepository = record(evidence.run.repository);
  const headRepository = record(evidence.run.head_repository);
  if (evidence.run.id !== sourceRunId
    || evidence.run.path !== TRUSTED_WORKFLOW_PATH
    || !['workflow_run', 'workflow_dispatch'].includes(String(evidence.run.event))
    || evidence.run.status !== 'completed'
    || evidence.run.head_branch !== 'master'
    || runRepository?.full_name !== repository
    || headRepository?.full_name !== repository) {
    throw new Error('Recovery source is not a completed trusted orchestration run on master.');
  }

  const matchingJobs = evidence.jobs.filter((job) => job.name === source.job && job.run_id === sourceRunId);
  if (matchingJobs.length !== 1) throw new Error('Recovery source does not contain exactly one trusted stage job.');
  const job = matchingJobs[0];
  const upload = records(job.steps).find((step) => step.name === source.uploadStep);
  if (job.status !== 'completed' || !upload || upload.status !== 'completed' || upload.conclusion !== 'success') {
    throw new Error('Recovery source stage did not produce a successful artifact upload.');
  }

  const expectedArtifact = `${source.artifact}-${sourceRunId}`;
  const matchingArtifacts = evidence.artifacts.filter((artifact) => artifact.name === expectedArtifact);
  if (matchingArtifacts.length !== 1) throw new Error('Recovery source does not contain exactly one expected stage artifact.');
  const artifact = matchingArtifacts[0];
  if (artifact.expired !== false
    || numberValue(artifact.size_in_bytes) < 1
    || record(artifact.workflow_run)?.id !== sourceRunId) {
    throw new Error('Recovery artifact provenance is invalid or expired.');
  }
  return expectedArtifact;
}

export function parseAgentStage(value: string): AgentStage {
  if (value === 'codeReview' || value === 'qa' || value === 'qualityGate') return value;
  throw new Error('AGENT_STAGE must be codeReview, qa, or qualityGate.');
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || !value.every((item) => record(item))) throw new Error('GitHub returned invalid recovery source evidence.');
  return value as Array<Record<string, unknown>>;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : -1;
}
