import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "./app.js";

test("GET /health reports the API and database as healthy", async () => {
  let queryCalled = false;
  const app = createApp({
    query: async (queryText) => {
      queryCalled = queryText === "SELECT 1";
      return { rows: [{ "?column?": 1 }] };
    },
  });

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok", database: "ok" });
  assert.equal(queryCalled, true);
  await app.close();
});

test("GET /health reports database failures without exposing internals", async () => {
  const app = createApp({
    query: async () => {
      throw new Error("private connection details");
    },
  });

  const response = await app.inject({ method: "GET", url: "/health" });

  assert.equal(response.statusCode, 503);
  assert.deepEqual(response.json(), {
    status: "error",
    database: "unavailable",
  });
  assert.equal(response.body.includes("private connection details"), false);
  await app.close();
});
