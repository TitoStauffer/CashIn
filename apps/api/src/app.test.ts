import assert from "node:assert/strict";
import test from "node:test";
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

// A configuração certa não é o mesmo que a linha certa: entre as duas está a premissa de que o
// Fastify aplica os serializers e a redação. Esta é a linha realmente emitida pelo pino.
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

  // Além do que não pode sair, o que tem de sair: sem isto o teste passaria com um log vazio.
  const request = lines.map((line) => JSON.parse(line) as { req?: { method: string; url: string } })
    .find((entry) => entry.req);
  assert.deepEqual({ method: request?.req?.method, url: request?.req?.url }, { method: "POST", url: "/auth/login" });
  const response = lines.map((line) => JSON.parse(line) as { res?: { statusCode: number } })
    .find((entry) => entry.res);
  assert.equal(typeof response?.res?.statusCode, "number");
});
