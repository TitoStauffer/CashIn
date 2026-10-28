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

export interface RecoveryArtifactSelection {
  artifactName: string;
  artifactId: number;
  runAttempt: number;
}

export async function loadAndValidateRecoverySource(input: {
  fetchImpl: typeof fetch;
  repository: string;
  token: string;
  sourceRunId: number;
  stage: AgentStage;
}): Promise<RecoveryArtifactSelection> {
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
}): RecoveryArtifactSelection {
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

  const expectedArtifact = `${source.artifact}-${sourceRunId}`;
  const successfulJobs = evidence.jobs
    .filter((job) => job.name === source.job && job.run_id === sourceRunId)
    .filter((job) => {
      const upload = records(job.steps).find((step) => step.name === source.uploadStep);
      return job.status === 'completed' && upload?.status === 'completed' && upload.conclusion === 'success';
    });
  if (successfulJobs.length === 0) throw new Error('Recovery source stage did not produce a successful artifact upload.');
  const latestAttempt = Math.max(...successfulJobs.map((job) => numberValue(job.run_attempt)));
  const latestJobs = successfulJobs.filter((job) => numberValue(job.run_attempt) === latestAttempt);
  if (latestAttempt < 1 || latestJobs.length !== 1) throw new Error('Recovery source has ambiguous stage jobs for its latest successful attempt.');
  const latestJob = latestJobs[0];

  const candidates = evidence.artifacts
    .filter((artifact) => artifact.name === expectedArtifact)
    .filter((artifact) => artifact.expired === false
      && numberValue(artifact.id) > 0
      && numberValue(artifact.size_in_bytes) > 0
      && record(artifact.workflow_run)?.id === sourceRunId)
    .map((artifact) => {
      const createdAt = timestamp(artifact.created_at);
      const startedAt = timestamp(latestJob.started_at);
      const completedAt = timestamp(latestJob.completed_at);
      if (![createdAt, startedAt, completedAt].every(Number.isFinite) || startedAt > completedAt) return undefined;
      if (createdAt < startedAt || createdAt > completedAt) return undefined;
      return { artifactName: expectedArtifact, artifactId: numberValue(artifact.id), runAttempt: latestAttempt };
    })
    .filter((candidate): candidate is RecoveryArtifactSelection => Boolean(candidate));

  if (candidates.length === 0) throw new Error('Recovery artifact provenance is invalid, ambiguous, or expired.');
  if (candidates.length !== 1) throw new Error('Recovery artifact provenance is ambiguous for the latest successful attempt.');
  return candidates[0];
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

function timestamp(value: unknown): number {
  if (typeof value !== 'string') return Number.NaN;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
