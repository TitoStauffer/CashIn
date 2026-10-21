import { createGitHubInstallationSession, getRepositoryPath, requestGitHubApi, type GitHubApiClientOptions } from './github-api-client.js';

const REQUIRED_QUALITY_CHECKS = ['API', 'Web', 'SonarQube', 'SonarCloud Code Analysis'];
const GRAPHQL_REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        nodes { isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

export type MergeReadinessStatus = 'READY_TO_MERGE' | 'BLOCKED' | 'INCONCLUSIVE';

export interface MergeReadinessResult {
  status: MergeReadinessStatus;
  pullRequest: { number: number; url?: string; title?: string; baseBranch?: string; headSha?: string };
  evaluatedAt: string;
  evidence: Record<string, unknown>;
  reasons: string[];
  limitations: string[];
}

export interface MergeReadinessOptions extends GitHubApiClientOptions {
  pullRequestNumber: number;
  requiredBaseBranch?: string;
  now?: () => Date;
}

export async function evaluateMergeReadiness(options: MergeReadinessOptions): Promise<MergeReadinessResult> {
  const now = options.now ?? (() => new Date());
  const reasons: string[] = [];
  const limitations: string[] = [];
  const evidence: Record<string, unknown> = {};
  const prEvidence: MergeReadinessResult['pullRequest'] = { number: options.pullRequestNumber };
  const result = (status: MergeReadinessStatus): MergeReadinessResult => ({
    status,
    pullRequest: prEvidence,
    evaluatedAt: now().toISOString(),
    evidence,
    reasons,
    limitations,
  });

  if (!Number.isSafeInteger(options.pullRequestNumber) || options.pullRequestNumber < 1) {
    reasons.push('Número de Pull Request inválido.');
    return result('BLOCKED');
  }

  let session;
  try {
    session = await createGitHubInstallationSession(options, true);
  } catch (error) {
    limitations.push(describeFailure('Autenticação do GitHub App', error));
    return result('INCONCLUSIVE');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const repositoryPath = getRepositoryPath(options.owner, options.repository);
  const token = session.installationToken;
  let initialPullRequest: Record<string, unknown>;
  try {
    initialPullRequest = await requestGitHubApi(fetchImpl, `${repositoryPath}/pulls/${options.pullRequestNumber}`, token);
  } catch (error) {
    limitations.push(describeFailure('Leitura do Pull Request', error));
    return result('INCONCLUSIVE');
  }

  const head = asRecord(initialPullRequest.head);
  const base = asRecord(initialPullRequest.base);
  const headSha = stringValue(head?.sha);
  const baseBranch = stringValue(base?.ref);
  prEvidence.url = stringValue(initialPullRequest.html_url);
  prEvidence.title = stringValue(initialPullRequest.title);
  prEvidence.baseBranch = baseBranch;
  prEvidence.headSha = headSha;
  evidence.app = session.appSlug;
  evidence.pullRequestState = initialPullRequest.state;

  if (initialPullRequest.state !== 'open') reasons.push('O Pull Request não está aberto.');
  if (!headSha || !/^[a-f0-9]{40}$/i.test(headSha)) {
    reasons.push('O GitHub não retornou um HEAD SHA completo e válido.');
    return result('BLOCKED');
  }
  if (!baseBranch) {
    limitations.push('Não foi possível identificar a branch base do Pull Request.');
    return result('INCONCLUSIVE');
  }
  if (options.requiredBaseBranch && baseBranch !== options.requiredBaseBranch) {
    reasons.push(`O Pull Request deve ter como destino a branch ${options.requiredBaseBranch}.`);
    return result('BLOCKED');
  }
  const mergeableState = stringValue(initialPullRequest.mergeable_state);
  if (initialPullRequest.mergeable === false || mergeableState === 'dirty') {
    reasons.push('O Pull Request possui conflitos com a branch base.');
  } else if (initialPullRequest.mergeable === null || mergeableState === 'unknown') {
    limitations.push('O GitHub ainda não informou se o Pull Request pode ser integrado.');
  } else if (initialPullRequest.mergeable !== true || mergeableState !== 'clean') {
    reasons.push(`O Pull Request não está em estado integrável do GitHub (${mergeableState ?? 'desconhecido'}).`);
  }

  const settled = await Promise.allSettled([
    listCheckRuns(fetchImpl, repositoryPath, headSha, token),
    listCommitStatuses(fetchImpl, repositoryPath, headSha, token),
    listPullRequestReviews(fetchImpl, repositoryPath, options.pullRequestNumber, token),
    listIssueComments(fetchImpl, repositoryPath, options.pullRequestNumber, token),
    listReviewThreads(fetchImpl, options.owner, options.repository, options.pullRequestNumber, token),
    readBranchProtection(fetchImpl, repositoryPath, baseBranch, token),
    listRepositoryRulesets(fetchImpl, repositoryPath, token),
    requestGitHubApi(fetchImpl, repositoryPath, token),
  ]);
  const [checkRuns, commitStatuses, reviews, comments, reviewThreads, protection, rulesets, repository] = settled;
  const datasets = [checkRuns, commitStatuses, reviews, comments, reviewThreads, protection, rulesets, repository] as const;
  const labels = ['Checks do commit', 'Status contexts', 'Revisões formais', 'Relatórios do PR', 'Threads de revisão', 'Branch protection', 'Rulesets', 'Configuração do repositório'];
  datasets.forEach((entry, index) => {
    if (entry.status === 'rejected') limitations.push(describeFailure(labels[index], entry.reason));
  });
  if (datasets.some((entry) => entry.status === 'rejected')) {
    const partial: Record<string, unknown> = {};
    if (checkRuns.status === 'fulfilled') partial.checkRuns = summarizeCheckRuns(checkRuns.value, headSha);
    if (commitStatuses.status === 'fulfilled') partial.commitStatuses = commitStatuses.value.map((status) => ({ context: status.context, state: status.state, sha: status.sha }));
    if (reviews.status === 'fulfilled') partial.formalReviews = reviews.value.map((review) => ({ reviewer: review.user?.login, state: review.state, commitSha: review.commit_id, submittedAt: review.submitted_at }));
    if (comments.status === 'fulfilled') partial.reportCommentCount = comments.value.length;
    if (reviewThreads.status === 'fulfilled') partial.reviewThreads = { total: reviewThreads.value.length, unresolved: reviewThreads.value.filter((resolved) => !resolved).length };
    if (protection.status === 'fulfilled') partial.branchProtection = protection.value ? summarizeProtection(protection.value) : null;
    if (rulesets.status === 'fulfilled') partial.rulesets = rulesets.value.map((ruleset) => ({ id: ruleset.id, name: ruleset.name, enforcement: ruleset.enforcement, target: ruleset.target }));
    if (repository.status === 'fulfilled') partial.defaultBranch = repository.value.default_branch;
    evidence.available = partial;
    return result('INCONCLUSIVE');
  }

  const runs = (checkRuns as PromiseFulfilledResult<CheckRun[]>).value;
  const statuses = (commitStatuses as PromiseFulfilledResult<CommitStatus[]>).value;
  const reviewList = (reviews as PromiseFulfilledResult<Review[]>).value;
  const reportComments = (comments as PromiseFulfilledResult<IssueComment[]>).value;
  const threads = (reviewThreads as PromiseFulfilledResult<boolean[]>).value;
  const branchRules = (protection as PromiseFulfilledResult<BranchProtection | null>).value;
  const rulesetList = (rulesets as PromiseFulfilledResult<Ruleset[]>).value;
  const defaultBranch = stringValue((repository as PromiseFulfilledResult<Record<string, unknown>>).value.default_branch);
  if (!defaultBranch) {
    limitations.push('O GitHub não retornou a branch padrão para interpretar rulesets.');
    return result('INCONCLUSIVE');
  }

  evidence.checkRuns = summarizeCheckRuns(runs, headSha);
  evidence.commitStatuses = statuses.map((status) => ({ context: status.context, state: status.state, sha: status.sha }));
  evidence.reviewThreads = { total: threads.length, unresolved: threads.filter((resolved) => !resolved).length };
  evidence.branchProtection = branchRules ? summarizeProtection(branchRules) : null;
  evidence.rulesets = rulesetList.map((ruleset) => ({ id: ruleset.id, name: ruleset.name, enforcement: ruleset.enforcement, target: ruleset.target }));

  const applicableRulesets = rulesetList.filter((ruleset) => rulesetAppliesToBranch(ruleset, baseBranch, defaultBranch));
  const requiredContexts = collectRequiredContexts(branchRules, applicableRulesets, baseBranch, defaultBranch)
    .filter((requirement) => requirement.context !== 'Merge Readiness');
  const requiredReviewCount = getRequiredReviewCount(branchRules, applicableRulesets);
  evidence.requiredChecks = requiredContexts;
  evidence.requiredApprovals = requiredReviewCount;

  if (!branchRules && applicableRulesets.length === 0) reasons.push('Não foi encontrada branch protection nem ruleset aplicável à branch base.');
  if (!hasConfiguredReviewProtection(branchRules, applicableRulesets, baseBranch, defaultBranch)) reasons.push('Não foi confirmada uma regra de proteção que exija aprovação formal de Pull Request.');
  if (!hasConfiguredCheckProtection(branchRules, applicableRulesets, baseBranch, defaultBranch)) reasons.push('Não foi confirmada uma regra de proteção para checks obrigatórios.');

  const requiredCheckCandidates: RequiredCheck[] = [
    ...REQUIRED_QUALITY_CHECKS.map((context) => ({ context })),
    ...requiredContexts,
  ];
  const requiredChecks = [...new Map(requiredCheckCandidates.map((requirement) => [`${requirement.context}:${requirement.appId ?? ''}`, requirement])).values()];
  const checkResults = evaluateRequiredChecks(requiredChecks, runs, statuses, headSha);
  evidence.requiredCheckResults = checkResults;
  for (const check of checkResults) {
    if (check.state !== 'SUCCESS') reasons.push(`Check obrigatório ${check.name}: ${check.state}.`);
  }

  const authorLogin = stringValue(asRecord(initialPullRequest.user)?.login);
  const appLogins = new Set([session.appSlug, session.appSlug ? `${session.appSlug}[bot]` : undefined].filter((login): login is string => Boolean(login)));
  const codeReview = findCodeReview(reviewList, appLogins, headSha);
  evidence.codeReview = codeReview.evidence;
  if (codeReview.status !== 'APPROVED') reasons.push(codeReview.reason);
  const validApprovalCount = countCurrentApprovals(reviewList, headSha, authorLogin);
  evidence.currentHeadApprovalCount = validApprovalCount;
  if (validApprovalCount < requiredReviewCount) {
    reasons.push(`A branch exige ${requiredReviewCount} aprovação(ões) no HEAD atual; foram encontradas ${validApprovalCount}.`);
  }

  const qa = findStructuredReport(reportComments, appLogins, 'qa', headSha);
  const qualityGate = findStructuredReport(reportComments, appLogins, 'qualityGate', headSha);
  evidence.reports = { qa: qa.evidence, qualityGate: qualityGate.evidence };
  if (qa.status !== 'APPROVED') reasons.push(qa.reason);
  if (qualityGate.status !== 'APPROVED') reasons.push(qualityGate.reason);
  if (threads.some((resolved) => !resolved)) reasons.push('Há conversas de revisão não resolvidas.');

  let finalPullRequest: Record<string, unknown>;
  try {
    finalPullRequest = await requestGitHubApi(fetchImpl, `${repositoryPath}/pulls/${options.pullRequestNumber}`, token);
  } catch (error) {
    limitations.push(describeFailure('Confirmação do HEAD ao final da avaliação', error));
    return result('INCONCLUSIVE');
  }
  const finalHeadSha = stringValue(asRecord(finalPullRequest.head)?.sha);
  evidence.finalHeadSha = finalHeadSha;
  if (finalHeadSha !== headSha) reasons.push('O HEAD SHA mudou durante a avaliação; as evidências coletadas estão desatualizadas.');

  if (limitations.length > 0) return result('INCONCLUSIVE');
  return result(reasons.length > 0 ? 'BLOCKED' : 'READY_TO_MERGE');
}

interface CheckRun { name?: string; head_sha?: string; status?: string; conclusion?: string; app?: { slug?: string; id?: number }; }
interface CommitStatus { context?: string; state?: string; sha?: string; }
interface Review { user?: { login?: string }; state?: string; commit_id?: string; submitted_at?: string | null; body?: string; }
interface IssueComment { user?: { login?: string }; body?: string; updated_at?: string; created_at?: string; }
interface BranchProtection { required_status_checks?: { contexts?: string[]; checks?: Array<{ context?: string; app_id?: number | null }> }; required_pull_request_reviews?: { required_approving_review_count?: number; dismiss_stale_reviews?: boolean } | null; }
interface Ruleset { id?: number; name?: string; enforcement?: string; target?: string; conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }; rules?: Array<{ type?: string; parameters?: { required_status_checks?: Array<{ context?: string; integration_id?: number | null }>; required_approving_review_count?: number } }>; }
interface RequiredCheck { context: string; appId?: number; }

async function listCheckRuns(fetchImpl: typeof fetch, repositoryPath: string, sha: string, token: string): Promise<CheckRun[]> {
  const result: CheckRun[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await requestGitHubApi(fetchImpl, `${repositoryPath}/commits/${sha}/check-runs?per_page=100&page=${page}`, token);
    const runs = Array.isArray(response.check_runs) ? response.check_runs as CheckRun[] : [];
    result.push(...runs);
    if (runs.length < 100) return result;
  }
  throw new Error('Check-run pagination exceeded the supported page limit.');
}

async function listCommitStatuses(fetchImpl: typeof fetch, repositoryPath: string, sha: string, token: string): Promise<CommitStatus[]> {
  const result: CommitStatus[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await requestGitHubApi(fetchImpl, `${repositoryPath}/commits/${sha}/status?per_page=100&page=${page}`, token);
    const statuses = Array.isArray(response.statuses) ? response.statuses as CommitStatus[] : [];
    result.push(...statuses);
    if (statuses.length < 100) return result;
  }
  throw new Error('Commit-status pagination exceeded the supported page limit.');
}

async function listPullRequestReviews(fetchImpl: typeof fetch, repositoryPath: string, number: number, token: string): Promise<Review[]> {
  return listRestPages<Review>(fetchImpl, `${repositoryPath}/pulls/${number}/reviews`, token);
}

async function listIssueComments(fetchImpl: typeof fetch, repositoryPath: string, number: number, token: string): Promise<IssueComment[]> {
  return listRestPages<IssueComment>(fetchImpl, `${repositoryPath}/issues/${number}/comments`, token);
}

async function listRestPages<T>(fetchImpl: typeof fetch, path: string, token: string): Promise<T[]> {
  const result: T[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await requestGitHubApi(fetchImpl, `${path}?per_page=100&page=${page}`, token);
    if (!Array.isArray(response)) throw new Error('GitHub returned an invalid paginated response.');
    result.push(...response as T[]);
    if (response.length < 100) return result;
  }
  throw new Error('GitHub pagination exceeded the supported page limit.');
}

async function listReviewThreads(fetchImpl: typeof fetch, owner: string, repository: string, number: number, token: string): Promise<boolean[]> {
  const threads: boolean[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const response = await requestGitHubApi(fetchImpl, '/graphql', token, {
      method: 'POST',
      body: JSON.stringify({ query: GRAPHQL_REVIEW_THREADS_QUERY, variables: { owner, name: repository, number, after } }),
    });
    const data = asRecord(response.data);
    if (Array.isArray(response.errors) && response.errors.length > 0) throw new Error('GitHub GraphQL could not read review threads.');
    const pullRequest = asRecord(asRecord(data?.repository)?.pullRequest);
    const reviewThreads = asRecord(pullRequest?.reviewThreads);
    if (!Array.isArray(reviewThreads?.nodes)) throw new Error('GitHub GraphQL returned no review-thread data.');
    for (const node of reviewThreads.nodes) {
      const resolved = asRecord(node)?.isResolved;
      if (typeof resolved !== 'boolean') throw new Error('GitHub returned an invalid review-thread state.');
      threads.push(resolved);
    }
    const pageInfo = asRecord(reviewThreads.pageInfo);
    if (pageInfo?.hasNextPage !== true) return threads;
    after = stringValue(pageInfo.endCursor) ?? null;
    if (!after) throw new Error('GitHub returned an invalid review-thread cursor.');
  }
  throw new Error('Review-thread pagination exceeded the supported page limit.');
}

async function readBranchProtection(fetchImpl: typeof fetch, repositoryPath: string, branch: string, token: string): Promise<BranchProtection | null> {
  try {
    return await requestGitHubApi(fetchImpl, `${repositoryPath}/branches/${encodeURIComponent(branch)}/protection`, token) as BranchProtection;
  } catch (error) {
    if (asRecord(error)?.status === 404) return null;
    throw error;
  }
}

async function listRepositoryRulesets(fetchImpl: typeof fetch, repositoryPath: string, token: string): Promise<Ruleset[]> {
  const rulesets: Ruleset[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const response = await requestGitHubApi<unknown[]>(fetchImpl, `${repositoryPath}/rulesets?includes_parents=true&per_page=100&page=${page}`, token);
    if (!Array.isArray(response)) throw new Error('GitHub returned an invalid ruleset response.');
    rulesets.push(...response as Ruleset[]);
    if (response.length < 100) return rulesets;
  }
  throw new Error('Ruleset pagination exceeded the supported page limit.');
}

function evaluateRequiredChecks(requirements: RequiredCheck[], runs: CheckRun[], statuses: CommitStatus[], sha: string): Array<{ name: string; appId?: number; state: string; evidence: unknown }> {
  return [...requirements].sort((left, right) => left.context.localeCompare(right.context) || (left.appId ?? 0) - (right.appId ?? 0)).map((requirement) => {
    const { context: name, appId } = requirement;
    const allNamedRuns = runs.filter((run) => run.name === name);
    const matchingRuns = allNamedRuns.filter((run) => appId === undefined || run.app?.id === appId);
    const matchingStatuses = statuses.filter((status) => status.context === name);
    const currentRuns = matchingRuns.filter((run) => run.head_sha === sha);
    if (allNamedRuns.length > 0 && matchingRuns.length === 0) return { name, appId, state: 'WRONG_APP', evidence: summarizeCheckRuns(allNamedRuns, sha) };
    if (matchingRuns.length > 0 && currentRuns.length === 0) return { name, appId, state: 'STALE', evidence: summarizeCheckRuns(matchingRuns, sha) };
    if (currentRuns.some((run) => run.status !== 'completed')) return { name, state: 'PENDING', evidence: summarizeCheckRuns(currentRuns, sha) };
    if (currentRuns.some((run) => run.conclusion !== 'success')) return { name, state: 'FAILED', evidence: summarizeCheckRuns(currentRuns, sha) };
    if (appId === undefined && matchingStatuses.some((status) => status.sha && status.sha !== sha)) return { name, state: 'STALE', evidence: matchingStatuses };
    if (appId === undefined && matchingStatuses.some((status) => status.state !== 'success')) return { name, state: 'FAILED', evidence: matchingStatuses };
    if (currentRuns.length === 0 && (appId !== undefined || matchingStatuses.length === 0)) return { name, appId, state: 'MISSING', evidence: null };
    return { name, appId, state: 'SUCCESS', evidence: summarizeCheckRuns(currentRuns, sha) };
  });
}

function summarizeCheckRuns(runs: CheckRun[], sha: string): Array<Record<string, unknown>> {
  return runs.map((run) => ({ name: run.name, headSha: run.head_sha, currentHead: run.head_sha === sha, status: run.status, conclusion: run.conclusion, app: run.app?.slug, appId: run.app?.id }));
}

function findCodeReview(reviews: Review[], appLogins: Set<string>, sha: string): { status: string; reason: string; evidence: Record<string, unknown> } {
  const appReviews = reviews.filter((review) => appLogins.has(review.user?.login ?? '') && /Code Review\s*[—-]/i.test(review.body ?? ''));
  const chronological = [...appReviews].sort((left, right) => (left.submitted_at ?? '').localeCompare(right.submitted_at ?? ''));
  const latest = chronological.at(-1);
  const laterRejection = reviews.some((review) => review.state === 'CHANGES_REQUESTED'
    && (review.submitted_at ?? '') > (latest?.submitted_at ?? '')
    && review.commit_id === sha);
  const evidence = latest ? { reviewer: latest.user?.login, state: latest.state, commitSha: latest.commit_id, submittedAt: latest.submitted_at } : { state: 'MISSING' };
  if (!latest) return { status: 'MISSING', reason: 'Revisão formal do Code Review Agent não encontrada.', evidence };
  if (laterRejection) return { status: 'REJECTED', reason: 'Uma revisão posterior solicitou alterações no HEAD atual.', evidence };
  if (latest.state !== 'APPROVED') return { status: latest.state ?? 'UNKNOWN', reason: `A revisão formal mais recente do Code Review não está aprovada (${latest.state ?? 'sem estado'}).`, evidence };
  if (latest.commit_id !== sha) return { status: 'STALE', reason: 'A aprovação formal do Code Review pertence a um SHA desatualizado.', evidence };
  return { status: 'APPROVED', reason: '', evidence };
}

function countCurrentApprovals(reviews: Review[], sha: string, authorLogin?: string): number {
  const latestByReviewer = new Map<string, Review>();
  for (const review of [...reviews].sort((left, right) => (left.submitted_at ?? '').localeCompare(right.submitted_at ?? ''))) {
    const login = review.user?.login;
    if (login) latestByReviewer.set(login, review);
  }
  return [...latestByReviewer.entries()].filter(([login, review]) => login !== authorLogin && review.state === 'APPROVED' && review.commit_id === sha).length;
}

function findStructuredReport(comments: IssueComment[], appLogins: Set<string>, agent: 'qa' | 'qualityGate', sha: string): { status: string; reason: string; evidence: Record<string, unknown> } {
  const signature = agent === 'qa' ? '### Codex — QA Agent' : '### Codex — Quality Gate Coordinator';
  const matching = comments.filter((comment) => appLogins.has(comment.user?.login ?? '') && (comment.body ?? '').includes(signature))
    .sort((left, right) => (left.updated_at ?? left.created_at ?? '').localeCompare(right.updated_at ?? right.created_at ?? ''));
  const latest = matching.at(-1);
  if (!latest) return { status: 'MISSING', reason: `Relatório estruturado do ${agent === 'qa' ? 'QA' : 'Quality Gate Coordinator'} ausente.`, evidence: { status: 'MISSING' } };
  const body = latest.body ?? '';
  const status = body.match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1]?.trim();
  const reportedSha = body.match(/^\*\*Commit:\*\*\s*`([a-f0-9]{40})`$/im)?.[1];
  const evidenceHeading = agent === 'qa'
    ? /(?:^\*\*Verificações de QA:\*\*\s*$|^\*\*Evidências:\*\*\s*$|^## Evidências\s*$)/im
    : /(?:^\*\*Checks verificados:\*\*\s*$|^\*\*Evidências:\*\*\s*$|^## Evidências\s*$)/im;
  const headingMatch = evidenceHeading.exec(body);
  const evidenceText = headingMatch ? body.slice(headingMatch.index + headingMatch[0].length).split(/\n\s*\n/)[0] : '';
  const hasEvidence = /^\s*[-*]\s+\S/m.test(evidenceText);
  const reportEvidence = { author: latest.user?.login, status: status ?? 'MISSING', commitSha: reportedSha ?? 'MISSING', hasStructuredEvidence: hasEvidence, updatedAt: latest.updated_at ?? latest.created_at };
  if (reportedSha !== sha) return { status: 'STALE', reason: `Relatório de ${agent === 'qa' ? 'QA' : 'Quality Gate'} ausente ou associado a outro SHA.`, evidence: reportEvidence };
  if (status !== 'APPROVED') return { status: status ?? 'MISSING', reason: `Relatório de ${agent === 'qa' ? 'QA' : 'Quality Gate'} não está aprovado.`, evidence: reportEvidence };
  if (!hasEvidence) return { status: 'UNSTRUCTURED', reason: `Relatório de ${agent === 'qa' ? 'QA' : 'Quality Gate'} não contém evidências estruturadas.`, evidence: reportEvidence };
  return { status: 'APPROVED', reason: '', evidence: reportEvidence };
}

function collectRequiredContexts(protection: BranchProtection | null, rulesets: Ruleset[], baseBranch: string, defaultBranch: string): RequiredCheck[] {
  const contexts = new Map<string, RequiredCheck>();
  const add = (context: string | undefined, appId?: number | null): void => {
    if (!context) return;
    const requirement: RequiredCheck = { context, ...(typeof appId === 'number' ? { appId } : {}) };
    contexts.set(`${context}:${requirement.appId ?? ''}`, requirement);
  };
  for (const context of protection?.required_status_checks?.contexts ?? []) add(context);
  for (const check of protection?.required_status_checks?.checks ?? []) add(check.context, check.app_id);
  for (const ruleset of rulesets) {
    if (ruleset.enforcement !== 'active' || !rulesetAppliesToBranch(ruleset, baseBranch, defaultBranch)) continue;
    for (const rule of ruleset.rules ?? []) {
      if (rule.type === 'required_status_checks') {
        for (const check of rule.parameters?.required_status_checks ?? []) add(check.context, check.integration_id);
      }
    }
  }
  return [...contexts.values()].sort((left, right) => left.context.localeCompare(right.context));
}

function getRequiredReviewCount(protection: BranchProtection | null, rulesets: Ruleset[]): number {
  const counts = [protection?.required_pull_request_reviews?.required_approving_review_count ?? 0];
  for (const ruleset of rulesets) {
    if (ruleset.enforcement !== 'active') continue;
    for (const rule of ruleset.rules ?? []) if (rule.type === 'pull_request') counts.push(rule.parameters?.required_approving_review_count ?? 0);
  }
  return Math.max(...counts);
}

function hasConfiguredReviewProtection(protection: BranchProtection | null, rulesets: Ruleset[], baseBranch: string, defaultBranch: string): boolean {
  if ((protection?.required_pull_request_reviews?.required_approving_review_count ?? 0) > 0) return true;
  return rulesets.some((ruleset) => ruleset.enforcement === 'active' && rulesetAppliesToBranch(ruleset, baseBranch, defaultBranch) && ruleset.rules?.some((rule) => rule.type === 'pull_request'));
}

function hasConfiguredCheckProtection(protection: BranchProtection | null, rulesets: Ruleset[], baseBranch: string, defaultBranch: string): boolean {
  if ((protection?.required_status_checks?.contexts?.length ?? 0) > 0 || (protection?.required_status_checks?.checks?.length ?? 0) > 0) return true;
  return rulesets.some((ruleset) => ruleset.enforcement === 'active' && rulesetAppliesToBranch(ruleset, baseBranch, defaultBranch) && ruleset.rules?.some((rule) => rule.type === 'required_status_checks' && (rule.parameters?.required_status_checks?.length ?? 0) > 0));
}

function rulesetAppliesToBranch(ruleset: Ruleset, branch: string, defaultBranch: string): boolean {
  if (ruleset.target !== 'branch') return false;
  const includes = ruleset.conditions?.ref_name?.include ?? [];
  const excludes = ruleset.conditions?.ref_name?.exclude ?? [];
  const ref = `refs/heads/${branch}`;
  const matches = (pattern: string): boolean => (pattern === '~DEFAULT_BRANCH' && branch === defaultBranch)
    || pattern === ref || (pattern.endsWith('*') && ref.startsWith(pattern.slice(0, -1)));
  return (includes.length === 0 || includes.some(matches)) && !excludes.some(matches);
}

function summarizeProtection(protection: BranchProtection): Record<string, unknown> {
  return {
    requiredChecks: protection.required_status_checks?.contexts ?? protection.required_status_checks?.checks?.map((check) => ({ context: check.context, appId: check.app_id })) ?? [],
    requiredApprovingReviewCount: protection.required_pull_request_reviews?.required_approving_review_count ?? 0,
    dismissStaleReviews: protection.required_pull_request_reviews?.dismiss_stale_reviews ?? null,
  };
}

function describeFailure(label: string, error: unknown): string {
  const status = asRecord(error)?.status;
  const statusDetail = typeof status === 'number' ? ` (HTTP ${status})` : '';
  return `${label} indisponível${statusDetail}; não foi possível confirmar as evidências.`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
