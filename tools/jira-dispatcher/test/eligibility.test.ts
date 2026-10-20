import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateEligibility } from "../src/eligibility.js";
import { STATUS, eligibleIssue, makeConfig } from "./helpers.js";

const config = makeConfig();

describe("evaluateEligibility", () => {
  it("accepts an issue that satisfies every configured rule", () => {
    assert.deepEqual(evaluateEligibility(eligibleIssue("DEV-10"), config), { eligible: true, reasons: [] });
  });

  it("rejects issues outside the reservable statuses, even when matched by JQL", () => {
    const result = evaluateEligibility(eligibleIssue("DEV-10", { status: STATUS.progress }), config);
    assert.equal(result.eligible, false);
    assert.match(result.reasons[0]!, /reservableStatuses/);
  });

  it("matches statuses by id or by case-insensitive name", () => {
    const byName = makeConfig({ jira: { reservableStatuses: ["tarefas PENDENTES"] } });
    assert.equal(evaluateEligibility(eligibleIssue("DEV-10"), byName).eligible, true);
  });

  it("rejects a missing or empty required field (including empty ADF documents)", () => {
    const empty = eligibleIssue("DEV-10", { description: { type: "doc", version: 1, content: [] } });
    assert.match(evaluateEligibility(empty, config).reasons.join(), /Descrição.*vazio/);
    const missing = eligibleIssue("DEV-10", { customfield_agent: null });
    assert.match(evaluateEligibility(missing, config).reasons.join(), /Agent técnico principal.*vazio/);
  });

  it("requires mustContain sections to be present in the field text", () => {
    const issue = eligibleIssue("DEV-10", { description: "Apenas um objetivo, sem critérios." });
    assert.match(evaluateEligibility(issue, config).reasons.join(), /não contém "Critérios de aceitação"/);
  });

  it("validates allowedValues against option fields", () => {
    const issue = eligibleIssue("DEV-10", { customfield_agent: { value: "Designer" } });
    assert.match(evaluateEligibility(issue, config).reasons.join(), /fora de allowedValues/);
    const array = eligibleIssue("DEV-10", { customfield_agent: [{ value: "frontend" }] });
    assert.equal(evaluateEligibility(array, config).eligible, true);
  });

  it("supports regex patterns for roles written inside text fields", () => {
    const patterned = makeConfig({
      jira: { requiredFields: [{ field: "description", label: "Papel", pattern: "Agent técnico principal:\\s*(Backend|Frontend|DBA)" }] }
    });
    const ok = eligibleIssue("DEV-10", { description: "Agent técnico principal: Frontend" });
    const bad = eligibleIssue("DEV-10", { description: "Agent técnico principal: ?" });
    assert.equal(evaluateEligibility(ok, patterned).eligible, true);
    assert.equal(evaluateEligibility(bad, patterned).eligible, false);
  });

  it("blocks issues with unresolved blocking links on the configured side only", () => {
    const blocked = eligibleIssue("DEV-10", {
      issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "DEV-9", fields: { status: STATUS.review } } }]
    });
    assert.match(evaluateEligibility(blocked, config).reasons.join(), /DEV-9/);

    const resolved = eligibleIssue("DEV-10", {
      issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "DEV-9", fields: { status: STATUS.done } } }]
    });
    assert.equal(evaluateEligibility(resolved, config).eligible, true);

    // DEV-10 blocks DEV-11: that does not prevent DEV-10 from starting.
    const blocksOther = eligibleIssue("DEV-10", {
      issuelinks: [{ type: { name: "Blocks" }, outwardIssue: { key: "DEV-11", fields: { status: STATUS.todo } } }]
    });
    assert.equal(evaluateEligibility(blocksOther, config).eligible, true);
  });
});
