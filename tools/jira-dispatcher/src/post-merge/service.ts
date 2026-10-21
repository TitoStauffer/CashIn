import { createHash } from "node:crypto";
import type { JiraApi, JiraIssue, JiraStatus } from "../jira/client.js";
import { adfToText } from "../jira/adf.js";
import { formatJiraTimestamp } from "../time.js";
import type {
  GitHubCheckRun,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubReadApi,
  GitHubReview,
} from "./github-client.js";

export const DEFAULT_REQUIRED_CHECKS = ["API", "Web", "PR title", "SonarQube", "SonarCloud Code Analysis"] as const;
export const POST_MERGE_PROPERTY_PREFIX = "cashin.post-merge";

export interface PostMergeDependencies {
  github: GitHubReadApi;
  jira: JiraApi;
  repositoryOwner: string;
  repositoryName: string;
  reportingAppLogin: string;
  requiredChecks?: readonly string[];
  timeZone?: string;
  now?: () => Date;
}

export type PostMergeResult =
  | { status: "SKIPPED"; reason: string }
  | {
      status: "COMPLETED";
      issueKey: string;
      pullRequestNumber: number;
      headSha: string;
      mergeSha: string;
      idempotencyKey: string;
      alreadyCompleted?: boolean;
    }
  | { status: "BLOCKED"; reason: string; issueKey?: string; pullRequestNumber?: number };

export class PostMergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostMergeError";
  }
}

interface PullRequestEvent {
  action?: unknown;
  repository?: { full_name?: unknown };
  pull_request?: {
    number?: unknown;
    title?: unknown;
    state?: unknown;
    merged?: unknown;
    merged_at?: unknown;
    merge_commit_sha?: unknown;
    html_url?: unknown;
    head?: { ref?: unknown; sha?: unknown };
    base?: { ref?: unknown; sha?: unknown };
  };
}

/** Processes only a closed, merged PR whose target is master. All writes happen after evidence validation. */
export async function processPostMergeEvent(eventValue: unknown, dependencies: PostMergeDependencies): Promise<PostMergeResult> {
  const event = asRecord(eventValue) as PullRequestEvent | undefined;
  if (event?.action !== "closed") return { status: "SKIPPED", reason: "Evento não é pull_request.closed." };
  const eventPr = asRecord(event.pull_request) as PullRequestEvent["pull_request"] | undefined;
  if (!eventPr) return { status: "BLOCKED", reason: "Payload não contém um Pull Request válido." };
  if (eventPr.merged !== true) return { status: "SKIPPED", reason: "O Pull Request foi fechado sem merge." };
  if (eventPr.base?.ref !== "master") return { status: "SKIPPED", reason: "O Pull Request não foi integrado à master." };

  const owner = dependencies.repositoryOwner;
  const repository = dependencies.repositoryName;
  const repoFullName = `${owner}/${repository}`;
  if (stringValue(asRecord(event.repository)?.full_name)?.toLowerCase() !== repoFullName.toLowerCase()) {
    return { status: "BLOCKED", reason: "O repositório do evento não corresponde à configuração da automação." };
  }

  const number = positiveInteger(eventPr.number);
  if (!number) return { status: "BLOCKED", reason: "Número de Pull Request inválido no evento." };
  const title = stringValue(eventPr.title);
  const headRef = stringValue(eventPr.head?.ref);
  const eventHeadSha = fullSha(eventPr.head?.sha);
  const eventMergeSha = fullSha(eventPr.merge_commit_sha);
  const mergedAt = stringValue(eventPr.merged_at);
  const url = stringValue(eventPr.html_url);
  if (!title || !headRef || !eventHeadSha || !eventMergeSha || !mergedAt || !url) {
    return { status: "BLOCKED", reason: "O evento não contém título, branch, SHAs, data de merge e URL válidos." };
  }
  const issueKey = extractIssueKey(title, headRef);
  if (!issueKey) return { status: "BLOCKED", reason: "A chave Jira está ausente, ambígua ou divergente entre o título e a branch." };

  const pullRequest = await dependencies.github.getPullRequest(owner, repository, number);
  if (!isSameMergedPullRequest(pullRequest, number, eventHeadSha, eventMergeSha)) {
    return { status: "BLOCKED", reason: "Os dados atuais do GitHub não confirmam o mesmo merge e HEAD do evento.", issueKey, pullRequestNumber: number };
  }

  const botLogin = dependencies.reportingAppLogin.trim().toLowerCase();
  if (!botLogin) throw new PostMergeError("GITHUB_APP_BOT_LOGIN não configurado.");
  const evidence = await readAndValidateEvidence(dependencies.github, owner, repository, pullRequest, botLogin, dependencies.requiredChecks ?? DEFAULT_REQUIRED_CHECKS);
  if (evidence.reason) return { status: "BLOCKED", reason: evidence.reason, issueKey, pullRequestNumber: number };

  const finalPullRequest = await dependencies.github.getPullRequest(owner, repository, number);
  if (!isSameMergedPullRequest(finalPullRequest, number, eventHeadSha, eventMergeSha)) {
    return { status: "BLOCKED", reason: "O HEAD ou os dados do merge mudaram durante a validação.", issueKey, pullRequestNumber: number };
  }

  const issue = await dependencies.jira.getIssue(issueKey, ["key", "project", "issuetype", "status"]);
  const issueValidation = validateIssue(issue, issueKey);
  if (issueValidation) return { status: "BLOCKED", reason: issueValidation, issueKey, pullRequestNumber: number };

  const idempotencyKey = `cashin-post-merge:${createHash("sha256").update(`${repoFullName}#${number}@${eventMergeSha}`).digest("hex")}`;
  const propertyKey = `${POST_MERGE_PROPERTY_PREFIX}.${idempotencyKey.split(":")[1]}`;
  const prior = await dependencies.jira.getIssueProperty(issueKey, propertyKey);
  const priorRecord = asRecord(prior);
  if (priorRecord?.status === "completed" && isDone(issue.fields.status)) {
    return { status: "COMPLETED", issueKey, pullRequestNumber: number, headSha: eventHeadSha, mergeSha: eventMergeSha, idempotencyKey, alreadyCompleted: true };
  }

  let currentIssue = issue;
  if (!isDone(currentIssue.fields.status)) {
    const transitions = await dependencies.jira.getTransitions(issueKey);
    const doneTransitions = transitions.filter((transition) => isDone(transition.to));
    const transition = selectDoneTransition(doneTransitions);
    if (!transition) throw new PostMergeError("Não existe uma transição única e disponível para Done nesta issue.");
    try {
      await dependencies.jira.transitionIssue(issueKey, transition.id);
    } catch (error) {
      currentIssue = await dependencies.jira.getIssue(issueKey, ["key", "project", "issuetype", "status"]);
      if (!isDone(currentIssue.fields.status)) throw error;
    }
    currentIssue = await dependencies.jira.getIssue(issueKey, ["key", "project", "issuetype", "status"]);
    if (!isDone(currentIssue.fields.status)) throw new PostMergeError("A transição do Jira não deixou a issue em Done.");
  }

  const marker = `Identificador da automação: ${idempotencyKey}`;
  const comments = await dependencies.jira.listComments(issueKey);
  const markerExists = comments.some((comment) => adfToText(comment.body).includes(marker));
  if (!markerExists) {
    const timestamp = formatJiraTimestamp(new Date(mergedAt), dependencies.timeZone ?? "America/Sao_Paulo");
    const comment = [
      `Merge concluído em ${timestamp}.`,
      `Pull Request: #${number} — ${url}`,
      `Branch: ${headRef} → master.`,
      `Commit de merge: \`${eventMergeSha}\`.`,
      `Validações: checks obrigatórios, Code Review formal, QA e Quality Gate aprovados para \`${eventHeadSha}\`.`,
      marker,
    ].join("\n\n");
    try {
      await dependencies.jira.addComment(issueKey, comment);
    } catch (error) {
      const commentsAfterError = await dependencies.jira.listComments(issueKey);
      if (!commentsAfterError.some((item) => adfToText(item.body).includes(marker))) throw error;
    }
    const commentsAfterWrite = await dependencies.jira.listComments(issueKey);
    if (!commentsAfterWrite.some((item) => adfToText(item.body).includes(marker))) {
      throw new PostMergeError("O Jira não confirmou o comentário de encerramento.");
    }
  }

  await dependencies.jira.setIssueProperty(issueKey, propertyKey, {
    status: "completed",
    repository: repoFullName,
    pullRequestNumber: number,
    headSha: eventHeadSha,
    mergeSha: eventMergeSha,
    issueKey,
    completedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
  });

  return { status: "COMPLETED", issueKey, pullRequestNumber: number, headSha: eventHeadSha, mergeSha: eventMergeSha, idempotencyKey };
}

export function extractIssueKey(title: string, branch: string): string | undefined {
  const titleKeys = keysIn(title);
  const branchKeys = keysIn(branch);
  if (titleKeys.length > 1 || branchKeys.length > 1) return undefined;
  if (titleKeys[0] && branchKeys[0] && titleKeys[0] !== branchKeys[0]) return undefined;
  const key = titleKeys[0] ?? branchKeys[0];
  return key && /^DEV-[1-9]\d+$/.test(key) ? key : undefined;
}

function keysIn(value: string): string[] {
  return [...new Set((value.match(/(?<![A-Z0-9])DEV-\d+(?![A-Z0-9])/gi) ?? []).map((match) => match.toUpperCase()))];
}

function validateIssue(issue: JiraIssue, expectedKey: string): string | undefined {
  if (issue.key.toUpperCase() !== expectedKey) return "O Jira retornou uma issue diferente da chave associada ao PR.";
  if (issue.fields.project?.key !== "DEV") return "A issue associada não pertence ao projeto DEV.";
  if (["epic", "epico"].includes(normalizeStatus(issue.fields.issuetype?.name ?? ""))) {
    return "Issues do tipo Epic nunca são encerradas por esta automação.";
  }
  if (!issue.fields.status) return "O Jira não retornou o status atual da issue.";
  return undefined;
}

function isSameMergedPullRequest(pr: GitHubPullRequest, number: number, headSha: string, mergeSha: string): boolean {
  return pr.number === number
    && pr.state === "closed"
    && pr.merged === true
    && pr.base.ref === "master"
    && pr.head.sha.toLowerCase() === headSha.toLowerCase()
    && pr.merge_commit_sha?.toLowerCase() === mergeSha.toLowerCase();
}

async function readAndValidateEvidence(
  github: GitHubReadApi,
  owner: string,
  repository: string,
  pr: GitHubPullRequest,
  botLogin: string,
  requiredChecks: readonly string[],
): Promise<{ reason?: string }> {
  const sha = pr.head.sha;
  const [checkRuns, reviews, comments, unresolvedThreads] = await Promise.all([
    github.listCheckRuns(owner, repository, sha),
    github.listReviews(owner, repository, pr.number),
    github.listIssueComments(owner, repository, pr.number),
    github.listUnresolvedReviewThreads(owner, repository, pr.number),
  ]);

  const missingChecks: string[] = [];
  const failedChecks: string[] = [];
  for (const name of requiredChecks) {
    const runs = checkRuns.filter((run) => run.name === name && run.head_sha.toLowerCase() === sha.toLowerCase())
      .sort((left, right) => (right.completed_at ?? right.started_at ?? "").localeCompare(left.completed_at ?? left.started_at ?? ""));
    if (runs.some((run) => run.status !== "completed" && !run.completed_at && !run.started_at)) {
      failedChecks.push(`${name} pendente sem timestamp verificável`);
      continue;
    }
    const latest = runs[0];
    if (!latest) {
      missingChecks.push(name);
      continue;
    }
    const expectedApp = name === "SonarCloud Code Analysis" ? "sonarqubecloud" : "github-actions";
    if (latest.app?.slug !== expectedApp) {
      failedChecks.push(`${name} publicado por uma integração inesperada`);
    } else if (latest.status !== "completed") {
      failedChecks.push(`${name} pendente`);
    } else if (latest.conclusion !== "success") {
      failedChecks.push(`${name} ${latest.conclusion ?? "sem conclusão"}`);
    }
  }
  if (missingChecks.length || failedChecks.length) {
    const parts = [
      missingChecks.length ? `checks ausentes para o HEAD atual: ${missingChecks.join(", ")}` : "",
      failedChecks.length ? `checks não aprovados: ${failedChecks.join(", ")}` : "",
    ].filter(Boolean);
    return { reason: parts.join("; ") };
  }

  const appReviews = reviews.filter((review) => review.user?.login?.toLowerCase() === botLogin)
    .sort((left, right) => (left.submitted_at ?? "").localeCompare(right.submitted_at ?? ""));
  const latestAppReview = appReviews.at(-1);
  if (!latestAppReview || latestAppReview.state !== "APPROVED" || latestAppReview.commit_id.toLowerCase() !== sha.toLowerCase()) {
    return { reason: "Aprovação formal do Code Review ausente, desatualizada ou não aprovada para o HEAD atual." };
  }
  const laterRejection = reviews.some((review) => review.state === "CHANGES_REQUESTED"
    && review.commit_id.toLowerCase() === sha.toLowerCase()
    && (review.submitted_at ?? "") > (latestAppReview.submitted_at ?? ""));
  if (laterRejection) return { reason: "Há solicitação de mudanças posterior à aprovação formal no HEAD atual." };

  const qa = findLatestStructuredReport(comments, botLogin, "### Codex — QA Agent", sha, ["**Verificações de QA:**", "**Evidências:**", "## Evidências"]);
  if (!qa) return { reason: "Relatório aprovado de QA com evidências para o HEAD atual não foi encontrado." };
  const qualityGate = findLatestStructuredReport(comments, botLogin, "### Codex — Quality Gate Coordinator", sha, ["**Checks verificados:**", "**Evidências:**", "## Evidências"]);
  if (!qualityGate) return { reason: "Relatório aprovado do Quality Gate Coordinator com evidências para o HEAD atual não foi encontrado." };
  if (unresolvedThreads > 0) return { reason: `Existem ${unresolvedThreads} conversas de revisão não resolvidas.` };
  return {};
}

function findLatestStructuredReport(
  comments: GitHubIssueComment[],
  botLogin: string,
  signature: string,
  sha: string,
  evidenceHeadings: string[],
): boolean {
  const matching = comments.filter((comment) => comment.user?.login?.toLowerCase() === botLogin && (comment.body ?? "").includes(signature))
    .sort((left, right) => (left.updated_at ?? left.created_at ?? "").localeCompare(right.updated_at ?? right.created_at ?? ""));
  const latest = matching.at(-1);
  if (!latest?.body) return false;
  const status = latest.body.match(/^\*\*Status:\*\*\s*(.+)$/m)?.[1]?.trim();
  const commitSha = latest.body.match(/^\*\*Commit:\*\*\s*`([a-f0-9]{40})`$/im)?.[1];
  if (status !== "APPROVED" || commitSha?.toLowerCase() !== sha.toLowerCase()) return false;
  const heading = evidenceHeadings.map(escapeRegExp).join("|");
  const evidenceMatch = new RegExp(`(?:^${heading})\\s*$`, "im").exec(latest.body);
  if (!evidenceMatch) return false;
  const evidence = latest.body.slice(evidenceMatch.index + evidenceMatch[0].length).split(/\n\s*\n/)[0] ?? "";
  return /^\s*[-*]\s+\S/m.test(evidence);
}

function selectDoneTransition<T extends { to: JiraStatus }>(transitions: T[]): T | undefined {
  if (transitions.length === 1) return transitions[0];
  const preferred = transitions.filter((transition) => normalizeStatus(transition.to.name) === "done");
  return preferred.length === 1 ? preferred[0] : undefined;
}

function isDone(status: JiraStatus | undefined): boolean {
  return ["done", "concluido"].includes(normalizeStatus(status?.name ?? ""));
}

function normalizeStatus(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function fullSha(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-f0-9]{40}$/i.test(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
