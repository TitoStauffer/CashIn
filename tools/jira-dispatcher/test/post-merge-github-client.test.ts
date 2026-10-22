import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubReadClient, GitHubReadError } from "../src/post-merge/github-client.js";

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function fakeFetch(responses: Response[]) {
  const calls: Array<{ url: string; authorization?: string; body?: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      authorization: new Headers(init.headers).get("authorization") ?? undefined,
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const next = responses.shift();
    if (!next) throw new Error("No mocked GitHub response remains.");
    return next;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("GitHubReadClient", () => {
  it("does not retry authentication errors or include its token in error text", async () => {
    const token = "ghp-test-secret-0123456789";
    const { calls, fetchImpl } = fakeFetch([response(401, { message: "Bad credentials" })]);
    const client = new GitHubReadClient(token, fetchImpl);
    await assert.rejects(() => client.getPullRequest("TitoStauffer", "CashIn", 123), (error: unknown) => {
      assert.ok(error instanceof GitHubReadError);
      assert.equal(error.status, 401);
      assert.doesNotMatch(error.message, /ghp-test-secret/);
      return true;
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.authorization, `Bearer ${token}`);
  });

  it("retries a rate-limited read and returns the successful result", async () => {
    const { calls, fetchImpl } = fakeFetch([
      response(429, {}, { "retry-after": "0.001" }),
      response(200, { check_runs: [{ name: "API", head_sha: "a".repeat(40), status: "completed", conclusion: "success" }] }),
    ]);
    const client = new GitHubReadClient("token", fetchImpl);
    const result = await client.listCheckRuns("TitoStauffer", "CashIn", "a".repeat(40));
    assert.equal(result[0]!.name, "API");
    assert.equal(calls.length, 2);
  });

  it("paginates GraphQL review threads and counts unresolved conversations", async () => {
    const { calls, fetchImpl } = fakeFetch([
      response(200, { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: true }, { isResolved: false }], pageInfo: { hasNextPage: true, endCursor: "cursor-1" } } } } } }),
      response(200, { data: { repository: { pullRequest: { reviewThreads: { nodes: [{ isResolved: false }], pageInfo: { hasNextPage: false, endCursor: null } } } } } }),
    ]);
    const client = new GitHubReadClient("token", fetchImpl);
    assert.equal(await client.listUnresolvedReviewThreads("TitoStauffer", "CashIn", 123), 2);
    assert.equal(calls.length, 2);
    assert.match(calls[1]!.body ?? "", /cursor-1/);
  });
});
