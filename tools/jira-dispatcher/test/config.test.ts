import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, parseConfig } from "../src/config.js";
import { makeConfig } from "./helpers.js";

describe("config", () => {
  it("uses safe Codex defaults: non-interactive exec with the workspace-write sandbox", () => {
    const config = makeConfig();
    assert.deepEqual(config.codex.args, ["exec", "--json", "--sandbox", "workspace-write"]);
    assert.deepEqual(config.codex.stripEnv, ["JIRA_EMAIL", "JIRA_API_TOKEN"]);
  });

  for (const forbidden of [
    ["exec", "--dangerously-bypass-approvals-and-sandbox"],
    ["exec", "--yolo"],
    ["exec", "--sandbox", "danger-full-access"],
    ["exec", "--sandbox=danger-full-access"],
    ["exec", "--full-auto"]
  ]) {
    it(`refuses unrestricted Codex execution: ${forbidden.slice(1).join(" ")}`, () => {
      assert.throws(() => makeConfig({ codex: { args: forbidden } }), ConfigError);
    });
  }

  it("refuses args the dispatcher manages itself", () => {
    assert.throws(() => makeConfig({ codex: { args: ["exec", "-o", "x.json"] } }), /dispatcher define/);
    assert.throws(() => makeConfig({ codex: { args: ["review"] } }), /exec/);
  });

  it("requires an explicit eligibility JQL and https Jira URL", () => {
    assert.throws(() => makeConfig({ jira: { eligibilityJql: "  " } }), /eligibilityJql/);
    assert.throws(() => makeConfig({ jira: { eligibilityJql: 'project = DEV ORDER BY created DESC' } }), /ORDER BY Rank ASC/);
    assert.throws(() => makeConfig({ jira: { baseUrl: "http://example.atlassian.net" } }), /https/);
  });

  it("requires a valid, non-empty and unique epic allowlist", () => {
    assert.throws(() => makeConfig({ jira: { allowedEpicKeys: [] } }), /allowedEpicKeys/);
    assert.throws(() => makeConfig({ jira: { allowedEpicKeys: ["epic without key"] } }), /chave de issue válida/);
    assert.throws(() => makeConfig({ jira: { allowedEpicKeys: ["DEV-6", "dev-6"] } }), /duplicadas/);
  });

  it("normalizes authorized epic keys", () => {
    assert.deepEqual(makeConfig({ jira: { allowedEpicKeys: ["dev-6", "dev-50"] } }).jira.allowedEpicKeys, ["DEV-6", "DEV-50"]);
  });

  it("rejects the example file until every PREENCHA placeholder is filled", () => {
    const example = JSON.parse(readFileSync(resolve(import.meta.dirname, "..", "dispatcher.config.example.json"), "utf8"));
    assert.throws(() => parseConfig(example, "/tmp"), /jira\.eligibilityJql.*jira\.requiredFields\[1\]\.field/);
  });

  it("rejects invalid regex patterns and time zones", () => {
    assert.throws(() => makeConfig({ jira: { requiredFields: [{ field: "x", label: "x", pattern: "(" }] } }), /expressão regular/);
    assert.throws(() => makeConfig({ jira: { commentTimeZone: "Mars/Base" } }), /fuso/);
  });
});
