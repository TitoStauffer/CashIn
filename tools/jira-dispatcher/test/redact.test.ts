import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Redactor } from "../src/redact.js";
import { formatJiraTimestamp } from "../src/time.js";

describe("Redactor", () => {
  const redactor = Redactor.fromEnvironment(
    { JIRA_API_TOKEN: "my-very-secret-token", SMTP_PASSWORD: "hunter22hunter", PATH: "/usr/bin" },
    ["user@example.com:my-very-secret-token"]
  );

  it("removes known secret values from env vars with sensitive names", () => {
    const out = redactor.redact("token=my-very-secret-token pass hunter22hunter path /usr/bin");
    assert.doesNotMatch(out, /my-very-secret-token|hunter22hunter/);
    assert.match(out, /\/usr\/bin/);
  });

  it("removes Base64-encoded secrets and Authorization headers", () => {
    const encoded = Buffer.from("user@example.com:my-very-secret-token").toString("base64");
    assert.doesNotMatch(redactor.redact(`Authorization: Basic ${encoded}`), new RegExp(encoded));
    assert.equal(new Redactor().redact("Authorization: Bearer abcdefghijklmnop"), "Authorization: Bearer [REDACTED]");
  });

  it("removes common token shapes and credentials in URLs", () => {
    const r = new Redactor();
    assert.equal(r.redact("ATATT3xFfGF0abcdefghijklmnopqrstuvwxyz"), "[REDACTED]");
    assert.equal(r.redact("ghp_abcdefghijklmnopqrstuvwxyz123456"), "[REDACTED]");
    assert.equal(r.redact("https://bob:pa55word@github.com/x"), "https://bob:[REDACTED]@github.com/x");
    assert.equal(r.redact('{"password":"abc123","ok":1}'), '{"password":"[REDACTED]","ok":1}');
    assert.equal(r.redact('{\\"api_token\\":\\"abc123\\"}'), '{\\"api_token\\":\\"[REDACTED]\\"}');
  });

  it("does not mangle ordinary text", () => {
    assert.equal(new Redactor().redact("Iniciado em 19/10/2026 23:14. runId: 123"), "Iniciado em 19/10/2026 23:14. runId: 123");
  });
});

describe("formatJiraTimestamp", () => {
  it("uses the AGENTS.md format in America/Sao_Paulo", () => {
    assert.equal(formatJiraTimestamp(new Date("2026-10-20T02:14:00Z"), "America/Sao_Paulo"), "19/10/2026 23:14 (America/Sao_Paulo)");
  });
});
