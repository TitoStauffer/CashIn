import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JiraClient, JiraHttpError } from "../src/jira/client.js";
import { adfToText, fieldValues } from "../src/jira/adf.js";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function fakeFetch(responses: (() => Response)[]) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: init.body as string | undefined });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    return next();
  }) as unknown as typeof fetch;
  return { calls, impl };
}

const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const credentials = { email: "me@example.com", apiToken: "ATATT-not-a-real-token-1234567890" };

describe("JiraClient", () => {
  it("authenticates with Basic auth and searches with the enhanced JQL endpoint", async () => {
    const { calls, impl } = fakeFetch([json(200, { issues: [{ id: "1", key: "DEV-10", fields: {} }] })]);
    const client = new JiraClient({ baseUrl: "https://x.atlassian.net", credentials, fetch: impl });
    const issues = await client.searchIssues("project = DEV ORDER BY Rank", ["status"], 5);
    assert.equal(issues[0]!.key, "DEV-10");
    assert.equal(calls[0]!.url, "https://x.atlassian.net/rest/api/3/search/jql");
    assert.equal(calls[0]!.method, "POST");
    assert.deepEqual(JSON.parse(calls[0]!.body!), { jql: "project = DEV ORDER BY Rank", fields: ["status"], maxResults: 5 });
    assert.equal(calls[0]!.headers.Authorization, `Basic ${Buffer.from("me@example.com:ATATT-not-a-real-token-1234567890").toString("base64")}`);
  });

  it("retries reads on 503 but never retries a transition", async () => {
    const reads = fakeFetch([json(503, {}), json(200, { transitions: [] })]);
    const client = new JiraClient({ baseUrl: "https://x.atlassian.net", credentials, fetch: reads.impl, retryBaseDelayMs: 1 });
    await client.getTransitions("DEV-10");
    assert.equal(reads.calls.length, 2);

    const writes = fakeFetch([json(503, {}), json(204, {})]);
    const writer = new JiraClient({ baseUrl: "https://x.atlassian.net", credentials, fetch: writes.impl, retryBaseDelayMs: 1 });
    await assert.rejects(() => writer.transitionIssue("DEV-10", "21"), JiraHttpError);
    assert.equal(writes.calls.length, 1);
  });

  it("produces errors with Jira's message but never the credentials", async () => {
    const { impl } = fakeFetch([json(400, { errorMessages: ["Transition is not valid"] })]);
    const client = new JiraClient({ baseUrl: "https://x.atlassian.net", credentials, fetch: impl });
    const error = await client.transitionIssue("DEV-10", "21").catch((e: Error) => e);
    assert.match(String(error), /400: Transition is not valid/);
    assert.doesNotMatch(String(error), /ATATT|Basic/);
  });

  it("sends comments as ADF and returns undefined for a missing issue property", async () => {
    const { calls, impl } = fakeFetch([() => new Response(null, { status: 201 }), json(404, {})]);
    const client = new JiraClient({ baseUrl: "https://x.atlassian.net", credentials, fetch: impl });
    await client.addComment("DEV-10", "Iniciado em 19/10/2026 23:14 (America/Sao_Paulo).");
    const body = JSON.parse(calls[0]!.body!);
    assert.equal(body.body.type, "doc");
    assert.equal(adfToText(body.body).trim(), "Iniciado em 19/10/2026 23:14 (America/Sao_Paulo).");
    assert.equal(await client.getIssueProperty("DEV-10", "p"), undefined);
  });

  it("lists all issue comments through Jira's paginated comment endpoint", async () => {
    const { calls, impl } = fakeFetch([json(200, { comments: [{ id: "7", body: { type: "doc", version: 1, content: [] } }], total: 1 })]);
    const client = new JiraClient({ baseUrl: "https://x.atlassian.net", credentials, fetch: impl });
    const comments = await client.listComments("DEV-10");
    assert.equal(comments.length, 1);
    assert.equal(comments[0]!.id, "7");
    assert.match(calls[0]!.url, /\/rest\/api\/3\/issue\/DEV-10\/comment\?startAt=0&maxResults=100$/);
  });
});

describe("fieldValues", () => {
  it("extracts text from strings, options, cascading selects, users and ADF", () => {
    assert.deepEqual(fieldValues("  "), []);
    assert.deepEqual(fieldValues({ value: "Backend" }), ["Backend"]);
    assert.deepEqual(fieldValues({ value: "Pai", child: { value: "Filho" } }), ["Pai", "Filho"]);
    assert.deepEqual(fieldValues([{ name: "a" }, { name: "b" }]), ["a", "b"]);
    assert.deepEqual(fieldValues({ displayName: "Tito" }), ["Tito"]);
    assert.deepEqual(fieldValues({ type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }] }), ["x"]);
    assert.deepEqual(fieldValues(null), []);
  });
});
