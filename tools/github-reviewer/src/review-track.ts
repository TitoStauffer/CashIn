/**
 * Classifies how much review a change needs, from the changed-file list the trusted jobs read from
 * the GitHub API. The Pull Request body never takes part: it is untrusted content.
 *
 * `full` runs every stage, as before. `light` skips QA, which is the only stage that calls a model on
 * the serialized self-hosted runner. The Quality Gate Coordinator keeps running on both tracks: it is
 * deterministic, costs no model call, and its published report is what the readiness gate reads to
 * confirm the track instead of accepting a missing report.
 *
 * The classification fails closed. Anything that is not provably a test file under a runtime directory
 * demands the full track, and an unusable file list demands it too.
 */
export type ReviewTrack = 'light' | 'full';

/**
 * Directories whose non-test contents demand the full track.
 *
 * The first two are the product runtime: what reaches users. The last two are the privileged automation
 * that decides whether a change is ready to merge — the workflows and the orchestration/readiness code
 * they run. DEV-116 asks for the light track to be chosen from the product runtime alone, and names as
 * a point of attention that the change to this very automation "pede o trilho completo — e é bom que
 * peça". It does not, under the product-only rule: a Pull Request that rewrites the readiness evaluator
 * touches no `apps/*` file, so it would review itself on the cheaper track. These two prefixes are what
 * makes that point of attention true.
 */
const RUNTIME_PREFIXES = [
  'apps/api/src/',
  'apps/web/src/',
  '.github/workflows/',
  'tools/github-reviewer/src/',
] as const;

/**
 * Only the `*.test.*` suffix counts as a test file. Fixtures, shared test helpers and the Vitest setup
 * live under the same directories and are deliberately left out: admitting them would widen the light
 * track, and a malformed fixture changes what an integration test proves. Being strict here only costs
 * a full round.
 */
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/i;

export function isRuntimeAffectingPath(path: string): boolean {
  if (typeof path !== 'string') return true;
  const normalized = path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized || normalized.includes('..')) return true;
  if (!RUNTIME_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return !TEST_FILE.test(normalized);
}

export function classifyReviewTrack(changedFiles: readonly string[] | undefined): ReviewTrack {
  // An empty or unusable list is not evidence of a documentation change; it is absence of evidence.
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return 'full';
  if (changedFiles.some((path) => typeof path !== 'string' || path.trim().length === 0)) return 'full';
  return changedFiles.some(isRuntimeAffectingPath) ? 'full' : 'light';
}

export function isReviewTrack(value: unknown): value is ReviewTrack {
  return value === 'light' || value === 'full';
}

/** The paths that forced the full track, for reports that must say why a track was chosen. */
export function runtimeAffectingPaths(changedFiles: readonly string[] | undefined): string[] {
  if (!Array.isArray(changedFiles)) return [];
  return changedFiles.filter((path) => typeof path === 'string' && isRuntimeAffectingPath(path));
}
