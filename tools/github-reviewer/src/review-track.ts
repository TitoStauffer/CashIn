/**
 * Classifies how much review a change needs, from the changed-file list the trusted jobs read from
 * the GitHub API. The Pull Request body never takes part: it is untrusted content.
 *
 * `full` runs every stage, as before. `light` skips QA, which is the only stage that calls a model on
 * the serialized self-hosted runner. The Quality Gate Coordinator keeps running on both tracks: it is
 * deterministic, costs no model call, and its published report is what the readiness gate reads to
 * confirm the track instead of accepting a missing report.
 *
 * The rule is an allowlist of inert paths, not a denylist of sensitive ones. The first implementation
 * listed what demands the full track — `apps/api/src/`, `apps/web/src/`, and later the privileged
 * automation — and the Code Review of PR #91 proved that shape unsafe: `apps/api/migrations/**`, the
 * application manifests, the Dockerfiles and `compose.yaml` all change runtime and all sat outside the
 * list, so a migration or a production dependency bump would have reached merge without QA. Listing
 * what is harmless inverts the failure: a path nobody classified yet, including a directory that does
 * not exist today, demands the full track by omission instead of escaping QA by omission.
 */
export type ReviewTrack = 'light' | 'full';

/**
 * A changed file only allows the light track when it is documentation or a test.
 *
 * - `*.md` anywhere: `AGENTS.md`, the knowledge vault, every README, the Pull Request template. These
 *   are the deliveries the light track exists for — DEV-115 and DEV-119 changed `AGENTS.md` alone and
 *   each consumed a full round of the serialized runner.
 * - `docs/knowledge/context-map.json`: the only non-Markdown file under `docs/`, read by the vault
 *   loader to pick notes. It steers review context, never product behaviour.
 * - `*.test.*` anywhere: a regression proves behaviour, it does not ship it.
 *
 * Everything else is full-track, deliberately including fixtures, shared test helpers, the Vitest
 * setup, lockfiles, `tsconfig`, the Jira dispatcher and `.claude/settings.json`. Being strict costs a
 * round; being permissive costs a missing QA on a change that reaches users.
 */
const LIGHT_TRACK_EXACT = ['docs/knowledge/context-map.json'] as const;
const MARKDOWN_FILE = /\.md$/i;
const TEST_FILE = /\.test\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

function normalize(path: string): string | undefined {
  if (typeof path !== 'string') return undefined;
  const normalized = path.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  // A traversal segment, an absolute path or an empty entry is not a path this rule can reason about.
  if (!normalized || normalized.includes('..') || normalized.startsWith('/')) return undefined;
  return normalized;
}

export function isRuntimeAffectingPath(path: string): boolean {
  const normalized = normalize(path);
  if (normalized === undefined) return true;
  if (LIGHT_TRACK_EXACT.includes(normalized as (typeof LIGHT_TRACK_EXACT)[number])) return false;
  return !MARKDOWN_FILE.test(normalized) && !TEST_FILE.test(normalized);
}

export function classifyReviewTrack(changedFiles: readonly string[] | undefined): ReviewTrack {
  // An empty or unusable list is not evidence of a documentation change; it is absence of evidence.
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return 'full';
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

/**
 * The job-output key that carries the track from the privileged stage to the workflow conditions.
 * It lives here, beside the rule, because the producer (`agent-stage-cli.ts`) and the consumer
 * (`agent-orchestration.yml`) are in different languages and nothing else ties the two spellings
 * together: renaming it on one side alone leaves the output empty, which fails closed but strands
 * every Pull Request until someone diagnoses it.
 */
export const REVIEW_TRACK_OUTPUT = 'review_track';

/** How the light track is defined, for the reports that have to state the rule they applied. */
export const LIGHT_TRACK_RULE = 'arquivos `*.md`, arquivos de teste `*.test.{ts,tsx,js,jsx,mjs,cjs}` e `docs/knowledge/context-map.json`';
