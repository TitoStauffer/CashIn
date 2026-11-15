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
// as production has it. One case per path the configuration assertion covers: proving it for the
// request headers alone would leave the other two resting on that assertion. `req.raw` and `res.raw`
// are redacted as well and have no case here, because no serializer of this project returns them —
// a gap inherited from DEV-59, tracked separately. No production configuration had to become
// injectable for any of this.
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

// DEV-130 — correlation id. Every response carries `X-Request-Id`, and the same value is the `reqId` of
// every log line of that request, so an id quoted by a user leads straight to the right log lines.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function createLoggedApp() {
  const lines: Array<{ reqId?: string; msg?: string }> = [];
  const app = createApp(createHealthDatabase(async () => ({ rows: [{ "?column?": 1 }] })), {
    logger: { write: (line) => { lines.push(JSON.parse(line) as { reqId?: string; msg?: string }); } },
  });
  return { app, lines };
}

function linesOf(lines: Array<{ reqId?: string; msg?: string }>, requestId: string) {
  return lines.filter((line) => line.reqId === requestId);
}

test("a request without X-Request-Id gets a generated UUID, returned and logged as reqId", async () => {
  const { app, lines } = createLoggedApp();

  const response = await app.inject({ method: "GET", url: "/health" });
  await app.close();

  const requestId = response.headers["x-request-id"];
  assert.equal(typeof requestId, "string");
  assert.match(requestId as string, UUID_PATTERN);
  const logged = linesOf(lines, requestId as string).map((line) => line.msg);
  assert.ok(logged.includes("incoming request"), "the request line must carry the returned id");
  assert.ok(logged.includes("request completed"), "the response line must carry the returned id");
  // No line of the request may carry another id — the old `req-N` counter included.
  assert.deepEqual(lines.filter((line) => line.reqId !== undefined && line.reqId !== requestId), []);
});

test("generated ids never repeat, across requests and across a restart of the API", async () => {
  const ids = new Set<string>();
  for (let restart = 0; restart < 2; restart += 1) {
    const app = createApp(createHealthDatabase(async () => ({ rows: [{ "?column?": 1 }] })));
    for (let request = 0; request < 3; request += 1) {
      const response = await app.inject({ method: "GET", url: "/health" });
      ids.add(response.headers["x-request-id"] as string);
    }
    await app.close();
  }
  assert.equal(ids.size, 6);
});

test("a valid X-Request-Id sent by the client is reused in the response and in the log", async () => {
  const { app, lines } = createLoggedApp();
  const clientId = `client-${"a".repeat(121)}`;
  assert.equal(clientId.length, 128);

  const response = await app.inject({ method: "GET", url: "/health", headers: { "x-request-id": clientId } });
  await app.close();

  assert.equal(response.headers["x-request-id"], clientId);
  assert.ok(linesOf(lines, clientId).length >= 2, "the request and response lines must carry the client id");
});

for (const [label, supplied] of [
  ["empty", ""],
  ["longer than 128 characters", "a".repeat(129)],
  ["with a space", "abc def"],
  ["with a character outside the alphabet", "abc;drop"],
  ["with a non-ASCII letter", "requisição"],
  ["repeated", ["first-id", "second-id"]],
] as const) {
  test(`an X-Request-Id ${label} is discarded and replaced by a generated UUID`, async () => {
    const { app, lines } = createLoggedApp();

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": supplied as string | string[] },
    });
    await app.close();

    const requestId = response.headers["x-request-id"] as string;
    assert.match(requestId, UUID_PATTERN);
    assert.ok(linesOf(lines, requestId).length >= 2);
    const rejected = Array.isArray(supplied) ? supplied : [supplied];
    for (const value of rejected.filter((item) => item !== "")) {
      assert.equal(JSON.stringify(lines).includes(value), false, `the discarded id ${value} must not reach the log`);
    }
  });
}

test("error responses carry X-Request-Id too, and the error log line has the same reqId", async () => {
  const { app, lines } = createLoggedApp();
  app.get("/test-only/failure", async () => {
    throw new Error("unexpected");
  });

  const failure = await app.inject({ method: "GET", url: "/test-only/failure", headers: { "x-request-id": "failure-id" } });
  const notFound = await app.inject({ method: "GET", url: "/rota-inexistente", headers: { "x-request-id": "not-found-id" } });
  const badBody = await app.inject({
    method: "POST",
    url: "/auth/login",
    headers: { "content-type": "application/json", "x-request-id": "bad-body-id" },
    payload: "{",
  });
  await app.close();

  assert.equal(failure.statusCode, 500);
  assert.equal(failure.headers["x-request-id"], "failure-id");
  assert.ok(linesOf(lines, "failure-id").some((line) => line.msg === "Request failed"));
  assert.equal(notFound.statusCode, 404);
  assert.equal(notFound.headers["x-request-id"], "not-found-id");
  assert.equal(badBody.statusCode, 400);
  assert.equal(badBody.headers["x-request-id"], "bad-body-id");
});
