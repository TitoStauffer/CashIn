import type { DispatcherConfig, FieldRequirement } from "./config.js";
import { fieldValues } from "./jira/adf.js";
import { statusMatches, type JiraIssue } from "./jira/client.js";

export interface EligibilityResult {
  eligible: boolean;
  reasons: string[];
}

/** Fields the dispatcher must request from Jira to evaluate eligibility. */
export function eligibilityFields(config: DispatcherConfig): string[] {
  return [...new Set(["summary", "status", "issuelinks", ...config.jira.requiredFields.map((f) => f.field)])];
}

/**
 * Deterministic checks applied after the JQL filter. They never guess field names:
 * every field, link type and status comes from configuration.
 * Semantic judgement (e.g. whether the scope is "clear") remains with the Codex workflow.
 */
export function evaluateEligibility(issue: JiraIssue, config: DispatcherConfig): EligibilityResult {
  const reasons: string[] = [];

  if (!statusMatches(issue.fields.status, config.jira.reservableStatuses)) {
    reasons.push(`status atual "${issue.fields.status?.name ?? "desconhecido"}" não está em reservableStatuses`);
  }

  for (const requirement of config.jira.requiredFields) {
    const problem = checkField(issue, requirement);
    if (problem) reasons.push(problem);
  }

  for (const rule of config.jira.blockingLinks) {
    for (const link of issue.fields.issuelinks ?? []) {
      if (link.type.name.toLowerCase() !== rule.type.toLowerCase()) continue;
      const other = rule.direction === "inward" ? link.inwardIssue : link.outwardIssue;
      if (!other) continue;
      const category = other.fields?.status?.statusCategory?.key;
      if (category !== "done") {
        reasons.push(`dependência ${other.key} (${rule.type}) não está concluída`);
      }
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

function checkField(issue: JiraIssue, requirement: FieldRequirement): string | undefined {
  const raw = issue.fields[requirement.field];
  const values = fieldValues(raw);
  if (values.length === 0) return `campo "${requirement.label}" (${requirement.field}) está vazio ou ausente`;

  const text = values.join("\n");
  const lower = text.toLowerCase();

  for (const expected of requirement.mustContain ?? []) {
    if (!lower.includes(expected.toLowerCase())) {
      return `campo "${requirement.label}" não contém "${expected}"`;
    }
  }

  if (requirement.pattern && !new RegExp(requirement.pattern, "i").test(text)) {
    return `campo "${requirement.label}" não corresponde ao padrão configurado`;
  }

  if (requirement.allowedValues) {
    const allowed = requirement.allowedValues.map((v) => v.toLowerCase());
    if (!values.some((value) => allowed.includes(value.trim().toLowerCase()))) {
      return `campo "${requirement.label}" tem valor fora de allowedValues`;
    }
  }

  return undefined;
}
