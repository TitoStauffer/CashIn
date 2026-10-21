import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JiraApi, JiraComment, JiraIssue, JiraTransition } from "../src/jira/client.js";
import { adfToText, textToAdf } from "../src/jira/adf.js";
import { DEFAULT_REQUIRED_CHECKS, extractIssueKey, processPostMergeEvent } from "../src/post-merge/service.js";
import type {
  GitHubCheckRun,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubReadApi,
  GitHubReview,
} from "../src/post-merge/github-client.js";

const HEAD_SHA = "a".repeat(40);
const MERGE_SHA = "b".repeat(40);
const APP_LOGIN = "cashin-devagents[bot]";
const REPOSITORY = "TitoStauffer/CashIn";

class FakeJira implements JiraApi {
  issue: JiraIssue = makeIssue();
  transitions: JiraTransition[] = [{ id: "done-1", name: "Complete", to: { id: "done", name: "Concluído", statusCategory: { key: "done" } } }];
  comments: JiraComment[] = [];
  properties = new Map<string, unknown>();
  calls: string[] = [];
  transitionSideEffectThenThrow = false;
  commentSideEffectThenThrow = false;
  propertySideEffectThenThrow = false;

  async myself() { return { accountId: "unused" }; }
  async searchIssues() { return []; }
  async getIssue(key: string): Promise<JiraIssue> { this.calls.push(`getIssue:${key}`); return structuredClone(this.issue); }
  async getTransitions(key: string): Promise<JiraTransition[]> { this.calls.push(`getTransitions:${key}`); return this.transitions; }
  async transitionIssue(key: string): Promise<void> {
    this.calls.push(`transition:${key}`);
    this.issue.fields.status = { id: "done", name: "Concluído", statusCategory: { key: "done" } };
    if (this.transitionSideEffectThenThrow) throw new Error("write timed out");
  }
  async addComment(key: string, text: string): Promise<void> {
    this.calls.push(`addComment:${key}`);
    this.comments.push({ id: String(this.comments.length + 1), body: textToAdf(text) });
    if (this.commentSideEffectThenThrow) throw new Error("write timed out");
  }
  async listComments(key: string): Promise<JiraComment[]> { this.calls.push(`listComments:${key}`); return structuredClone(this.comments); }
  async setIssueProperty(key: string, propertyKey: string, value: unknown): Promise<void> {
    this.calls.push(`setProperty:${key}`);
    this.properties.set(propertyKey, value);
    if (this.propertySideEffectThenThrow) {
      this.propertySideEffectThenThrow = false;
      throw new Error("write timed out");
    }
  }
  async getIssueProperty(key: string, propertyKey: string): Promise<unknown> { this.calls.push(`getProperty:${key}`); return this.properties.get(propertyKey); }
  async listFields() { return []; }
  async listLinkTypes() { return []; }
}

class FakeGitHub implements GitHubReadApi {
  pullRequest = makePullRequest();
  checkRuns: GitHubCheckRun[] = DEFAULT_REQUIRED_CHECKS.map((name) => ({
    name,
    head_sha: HEAD_SHA,
    app: { slug: name === "SonarCloud Code Analysis" ? "sonarqubecloud" : "github-actions" },
    status: "completed",
    conclusion: "success",
  }));
  reviews: GitHubReview[] = [{ user: { login: APP_LOGIN }, state: "APPROVED", commit_id: HEAD_SHA, submitted_at: "2026-10-21T12:00:00Z" }];
  comments: GitHubIssueComment[] = [
    makeReport("### Codex — QA Agent", "Verificações de QA"),
    makeReport("### Codex — Quality Gate Coordinator", "Checks verificados"),
  ];
  unresolvedThreads = 0;
  calls: string[] = [];
  onGetPullRequest?: () => void;

  async getPullRequest(_owner: string, _repo: string, number: number): Promise<GitHubPullRequest> {
    this.calls.push(`getPullRequest:${number}`);
    this.onGetPullRequest?.();
    return structuredClone(this.pullRequest);
  }
  async listCheckRuns(): Promise<GitHubCheckRun[]> { this.calls.push("checkRuns"); return this.checkRuns; }
  async listReviews(): Promise<GitHubReview[]> { this.calls.push("reviews"); return this.reviews; }
  async listIssueComments(): Promise<GitHubIssueComment[]> { this.calls.push("prComments"); return this.comments; }
  async listUnresolvedReviewThreads(): Promise<number> { this.calls.push("reviewThreads"); return this.unresolvedThreads; }
}

function makeIssue(status = { id: "in-progress", name: "Em andamento", statusCategory: { key: "indeterminate" } }): JiraIssue {
  return {
    id: "10042",
    key: "DEV-42",
    fields: {
      status,
      project: { key: "DEV" },
      issuetype: { name: "Tarefa" },
    },
  };
}

function makePullRequest(): GitHubPullRequest {
  return {
    number: 123,
    title: "[DEV-42] - Automação pós-merge",
    state: "closed",
    merged: true,
    merged_at: "2026-10-21T17:00:00Z",
    merge_commit_sha: MERGE_SHA,
    html_url: "https://github.com/TitoStauffer/CashIn/pull/123",
    head: { ref: "feature/DEV-42-post-merge-jira", sha: HEAD_SHA },
    base: { ref: "master", sha: MERGE_SHA },
  };
}

function makeReport(signature: string, heading: string): GitHubIssueComment {
  return {
    user: { login: APP_LOGIN },
    created_at: "2026-10-21T12:01:00Z",
    body: `${signature}\n\n**Status:** APPROVED\n\n**Commit:** \`${HEAD_SHA}\`\n\n**${heading}:**\n- Evidência validada para o SHA atual.`,
  };
}

function makeEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    action: "closed",
    repository: { full_name: REPOSITORY },
    pull_request: {
      number: 123,
      title: "[DEV-42] - Automação pós-merge",
      state: "closed",
      merged: true,
      merged_at: "2026-10-21T17:00:00Z",
      merge_commit_sha: MERGE_SHA,
      html_url: "https://github.com/TitoStauffer/CashIn/pull/123",
      head: { ref: "feature/DEV-42-post-merge-jira", sha: HEAD_SHA },
      base: { ref: "master", sha: MERGE_SHA },
      ...overrides,
    },
  };
}

function setup() {
  const jira = new FakeJira();
  const github = new FakeGitHub();
  const dependencies = {
    jira,
    github,
    repositoryOwner: "TitoStauffer",
    repositoryName: "CashIn",
    reportingAppLogin: APP_LOGIN,
    now: () => new Date("2026-10-21T18:00:00Z"),
  };
  return { jira, github, dependencies };
}

describe("extractIssueKey", () => {
  it("accepts a matching key in title and branch or in either source", () => {
    assert.equal(extractIssueKey("[DEV-42] tarefa", "feature/DEV-42-tarefa"), "DEV-42");
    assert.equal(extractIssueKey("tarefa", "feature/DEV-42-tarefa"), "DEV-42");
    assert.equal(extractIssueKey("[DEV-42] tarefa", "feature/tarefa"), "DEV-42");
  });

  it("rejects missing, ambiguous, or divergent keys", () => {
    assert.equal(extractIssueKey("tarefa", "feature/tarefa"), undefined);
    assert.equal(extractIssueKey("[DEV-42] DEV-43", "feature/DEV-42-tarefa"), undefined);
    assert.equal(extractIssueKey("[DEV-42] tarefa", "feature/DEV-43-tarefa"), undefined);
    assert.equal(extractIssueKey("[OTHER-42] tarefa", "feature/OTHER-42-tarefa"), undefined);
  });
});

describe("processPostMergeEvent", () => {
  it("completes a merged master PR only after validating all current-SHA evidence", async () => {
    const { jira, dependencies } = setup();
    const result = await processPostMergeEvent(makeEvent(), dependencies);
    assert.equal(result.status, "COMPLETED");
    assert.equal(jira.issue.fields.status?.statusCategory?.key, "done");
    assert.equal(jira.comments.length, 1);
    const commentText = adfToText(jira.comments[0]!.body);
    assert.match(commentText, /Commit de merge/);
    assert.match(commentText, /America\/Sao_Paulo/);
    assert.equal([...jira.properties.values()].length, 1);
  });

  it("does not change Jira for a PR closed without merge or to a different branch", async () => {
    const noMerge = setup();
    assert.equal((await processPostMergeEvent(makeEvent({ merged: false }), noMerge.dependencies)).status, "SKIPPED");
    assert.equal(noMerge.jira.calls.length, 0);

    const otherBranch = setup();
    assert.equal((await processPostMergeEvent(makeEvent({ base: { ref: "develop", sha: MERGE_SHA } }), otherBranch.dependencies)).status, "SKIPPED");
    assert.equal(otherBranch.jira.calls.length, 0);
  });

  it("rejects keys that are ambiguous or inconsistent before any Jira write", async () => {
    const { jira, dependencies } = setup();
    const result = await processPostMergeEvent(makeEvent({ title: "[DEV-42] DEV-43", head: { ref: "feature/DEV-42-tarefa", sha: HEAD_SHA } }), dependencies);
    assert.equal(result.status, "BLOCKED");
    assert.equal(jira.calls.length, 0);
  });

  it("rejects an Epic and a ticket outside the expected project", async () => {
    const epic = setup();
    epic.jira.issue.fields.issuetype = { name: "Épico" };
    assert.equal((await processPostMergeEvent(makeEvent(), epic.dependencies)).status, "BLOCKED");
    assert.equal(epic.jira.calls.some((call) => call.startsWith("transition:")), false);

    const otherProject = setup();
    otherProject.jira.issue.fields.project = { key: "OTHER" };
    assert.equal((await processPostMergeEvent(makeEvent(), otherProject.dependencies)).status, "BLOCKED");
    assert.equal(otherProject.jira.calls.some((call) => call.startsWith("transition:")), false);
  });

  it("blocks a missing or failed required check", async () => {
    const missing = setup();
    missing.github.checkRuns = missing.github.checkRuns.filter((run) => run.name !== "Web");
    assert.equal((await processPostMergeEvent(makeEvent(), missing.dependencies)).status, "BLOCKED");
    assert.equal(missing.jira.calls.some((call) => call.startsWith("transition:")), false);

    const failed = setup();
    failed.github.checkRuns[0]!.conclusion = "failure";
    assert.equal((await processPostMergeEvent(makeEvent(), failed.dependencies)).status, "BLOCKED");
  });

  it("blocks a passing check supplied by an unexpected GitHub App", async () => {
    const { github, dependencies } = setup();
    github.checkRuns[0]!.app = { slug: "untrusted-check-publisher" };
    const result = await processPostMergeEvent(makeEvent(), dependencies);
    assert.equal(result.status, "BLOCKED");
    assert.match(result.reason, /integração inesperada/);
  });

  it("blocks stale formal review, missing QA/QG reports, and unresolved review threads", async () => {
    const staleReview = setup();
    staleReview.github.reviews[0]!.commit_id = "c".repeat(40);
    assert.equal((await processPostMergeEvent(makeEvent(), staleReview.dependencies)).status, "BLOCKED");

    const missingQa = setup();
    missingQa.github.comments = missingQa.github.comments.filter((comment) => !comment.body?.includes("QA Agent"));
    assert.equal((await processPostMergeEvent(makeEvent(), missingQa.dependencies)).status, "BLOCKED");

    const missingQualityGate = setup();
    missingQualityGate.github.comments = missingQualityGate.github.comments.filter((comment) => !comment.body?.includes("Quality Gate Coordinator"));
    assert.equal((await processPostMergeEvent(makeEvent(), missingQualityGate.dependencies)).status, "BLOCKED");

    const unresolved = setup();
    unresolved.github.unresolvedThreads = 1;
    assert.equal((await processPostMergeEvent(makeEvent(), unresolved.dependencies)).status, "BLOCKED");
  });

  it("blocks a later review rejection and a PR whose HEAD changes during evaluation", async () => {
    const rejected = setup();
    rejected.github.reviews.push({ user: { login: "reviewer" }, state: "CHANGES_REQUESTED", commit_id: HEAD_SHA, submitted_at: "2026-10-21T12:02:00Z" });
    assert.equal((await processPostMergeEvent(makeEvent(), rejected.dependencies)).status, "BLOCKED");

    const changed = setup();
    let reads = 0;
    changed.github.onGetPullRequest = () => {
      reads += 1;
      if (reads === 2) changed.github.pullRequest.head.sha = "c".repeat(40);
    };
    assert.equal((await processPostMergeEvent(makeEvent(), changed.dependencies)).status, "BLOCKED");
    assert.equal(changed.jira.calls.length, 0);
  });

  it("recovers a transition timeout after Jira reached Done and a comment timeout after it was stored", async () => {
    const { jira, dependencies } = setup();
    jira.transitionSideEffectThenThrow = true;
    jira.commentSideEffectThenThrow = true;
    const result = await processPostMergeEvent(makeEvent(), dependencies);
    assert.equal(result.status, "COMPLETED");
    assert.equal(jira.comments.length, 1);
    assert.equal(jira.calls.filter((call) => call.startsWith("transition:")).length, 1);
  });

  it("is idempotent when the same event is delivered again", async () => {
    const { jira, dependencies } = setup();
    const first = await processPostMergeEvent(makeEvent(), dependencies);
    const second = await processPostMergeEvent(makeEvent(), dependencies);
    assert.equal(first.status, "COMPLETED");
    assert.equal(second.status, "COMPLETED");
    assert.equal((second as { alreadyCompleted?: boolean }).alreadyCompleted, true);
    assert.equal(jira.comments.length, 1);
    assert.equal(jira.calls.filter((call) => call.startsWith("transition:")).length, 1);
  });

  it("finishes a prior partial run without repeating an existing completion comment", async () => {
    const { jira, dependencies } = setup();
    jira.propertySideEffectThenThrow = true;
    await assert.rejects(() => processPostMergeEvent(makeEvent(), dependencies), /write timed out/);
    const second = await processPostMergeEvent(makeEvent(), dependencies);
    assert.equal(second.status, "COMPLETED");
    assert.equal(jira.comments.length, 1);
    assert.equal(jira.calls.filter((call) => call.startsWith("transition:")).length, 1);
  });

  it("requires an unambiguous available transition to Done", async () => {
    const { jira, dependencies } = setup();
    jira.transitions = [];
    await assert.rejects(() => processPostMergeEvent(makeEvent(), dependencies), /transição única/);
  });
});
