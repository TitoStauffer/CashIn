import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { createApp, requestLoggerOptions } from "./app.js";
import type { Database, QueryExecutor } from "./database.js";

function createHealthDatabase(
  query: (queryText: string) => Promise<{ rows: unknown[]; rowCount?: number | null }>,
): Database {
  const executor: QueryExecutor = {
    query: async <Row extends import("pg").QueryResultRow>(queryText: string) => {
      const result = await query(queryText);
      return { rows: result.rows as Row[], rowCount: result.rowCount ?? null };
    },
  };
  return { ...executor, transaction: async (work) => work(executor) };
}

test("GET /health reports the API and database as healthy", async () => {
  let queryCalled = false;
  const app = createApp(createHealthDatabase(async (queryText) => {
      queryCalled = queryText === "SELECT 1";
      return { rows: [{ "?column?": 1 }] };
    }));

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", database: "ok" });
  assert.equal(queryCalled, true);
  await app.close();
});

test("GET /health reports database failures without exposing internals", async () => {
  const app = createApp(createHealthDatabase(async () => {
      throw new Error("private connection details");
    }));

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "error",
    database: "unavailable",
  });
  assert.equal(response.body.includes("private connection details"), false);
  await app.close();
});

// What a request contributes to a log line. A session cookie and a payload are the two things a log
// must never carry, so this checks the configuration itself: the serializer decides what is written,
// and the redaction is the second lock for a field a future log line might add.
test("request logging keeps credentials and payloads out of every log line", () => {
  const serialized = requestLoggerOptions.serializers.req({
    method: "POST",
    url: "/financial-imports",
    ip: "203.0.113.10",
    headers: { cookie: "cashin_session=segredo" },
    body: Buffer.from("conteudo do extrato"),
  } as never);

  assert.deepEqual(serialized, { method: "POST", url: "/financial-imports", remoteAddress: "203.0.113.10" });
  assert.deepEqual(requestLoggerOptions.serializers.res({ statusCode: 201, headers: { "set-cookie": "x" } } as never), { statusCode: 201 });
  for (const path of ["req.headers", "req.body", "res.headers"]) {
    assert.ok(requestLoggerOptions.redact.paths.includes(path), `${path} must be redacted`);
  }
});

// Redaction is the second lock, and this is the regression that proves it instead of leaving the
// claim resting on a mutation that only ever runs on the author's machine. Each case builds the
// logger with a serializer that leaks one of the redacted paths on purpose, keeping `redact` exactly
// as production has it. One case per path: proving it for the headers alone would leave the other
// two resting on the configuration assertion. No production configuration had to become injectable.
const leakingSerializerCases = [
  {
    path: "req.headers",
    secret: "leaked-session-cookie",
    serializers: {
      req: (request: { method: string; headers: unknown }) => ({ method: request.method, headers: request.headers }),
    },
    read: (entry: { req?: Record<string, unknown>; res?: Record<string, unknown> }) => entry.req?.headers,
  },
  {
    path: "req.body",
    secret: "leaked-request-body",
    serializers: {
      req: (request: { method: string; body: unknown }) => ({ method: request.method, body: request.body }),
    },
    read: (entry: { req?: Record<string, unknown>; res?: Record<string, unknown> }) => entry.req?.body,
  },
  {
    path: "res.headers",
    secret: "leaked-response-cookie",
    serializers: {
      res: (reply: { statusCode: number; getHeaders(): unknown }) => ({ statusCode: reply.statusCode, headers: reply.getHeaders() }),
    },
    read: (entry: { req?: Record<string, unknown>; res?: Record<string, unknown> }) => entry.res?.headers,
  },
];

for (const { path, secret, serializers, read } of leakingSerializerCases) {
  test(`the pino redaction censors ${path} even when the serializer leaks it`, async () => {
    const lines: string[] = [];
    const app = Fastify({
      logger: {
        ...requestLoggerOptions,
        // Each case installs a serializer whose return shape production deliberately forbids —
        // that is the point of the case — so the assembled object is asserted back to the
        // production shape at this single spot instead of loosening the exported type.
        serializers: { ...requestLoggerOptions.serializers, ...serializers } as unknown as typeof requestLoggerOptions.serializers,
        stream: { write: (line: string) => { lines.push(line); } },
      },
    });
    app.post("/echo", async (_request, reply) => {
      reply.header("set-cookie", `cashin_session=${secret}`);
      return { ok: true };
    });

    await app.inject({
      method: "POST",
      url: "/echo",
      headers: { cookie: `cashin_session=${secret}` },
      payload: { password: secret },
    });
    await app.close();

    assert.ok(lines.length > 0, "the logger must emit at least one line");
    assert.doesNotMatch(lines.join(""), new RegExp(secret));
    // Asserted on the parsed line and on the field itself, so the proof does not depend on where
    // the censor happens to land in the text.
    const censored = lines
      .map((line) => JSON.parse(line) as { req?: Record<string, unknown>; res?: Record<string, unknown> })
      .map(read)
      .find((value) => value !== undefined);
    assert.equal(censored, "[redacted]");
  });
}

// The right configuration is not the same as the right line: between them sits the premise that
// Fastify applies these serializers and this redaction. This is the line pino really emitted.
test("the emitted request log line carries no cookie and no payload", async () => {
  const lines: string[] = [];
  const app = createApp(createHealthDatabase(async () => ({ rows: [{ "?column?": 1 }] })), {
    logger: { write: (line) => { lines.push(line); } },
  });

  await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { cookie: "cashin_session=segredo-de-sessao" },
    payload: { email: "pessoa@example.test", password: "senha-no-corpo" },
  });
  await app.close();

  const emitted = lines.join("");
  assert.ok(lines.length > 0, "the logger must emit at least one line");
  assert.doesNotMatch(emitted, /segredo-de-sessao/);
  assert.doesNotMatch(emitted, /senha-no-corpo/);
  assert.doesNotMatch(emitted, /cashin_session/);

  // Besides what must not be there, what must: without this the test would pass on an empty log.
  // And the **exact** keys, not merely the present ones: Fastify's default serializer also leaks
  // neither headers nor body, so asserting only that the line is clean would pass with this
  // project's configuration entirely ignored. The default adds `host`, `remotePort` and `version`,
  // and it is their absence that tells one serializer from the other.
  const request = lines.map((line) => JSON.parse(line) as { req?: Record<string, unknown> }).find((entry) => entry.req);
  assert.deepEqual(Object.keys(request?.req ?? {}).sort(), ["method", "remoteAddress", "url"]);
  assert.equal(request?.req?.method, "POST");
  assert.equal(request?.req?.url, "/auth/login");
  const response = lines.map((line) => JSON.parse(line) as { res?: Record<string, unknown> }).find((entry) => entry.res);
  assert.deepEqual(Object.keys(response?.res ?? {}), ["statusCode"]);
  assert.equal(typeof response?.res?.statusCode, "number");
});
