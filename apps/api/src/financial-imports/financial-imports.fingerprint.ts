import { createHash } from "node:crypto";
import type { FinancialImportItemType } from "./financial-imports.types.js";

export function createFinancialImportFingerprint(input: {
  date: string | null;
  signedAmount: string | null;
  type: FinancialImportItemType;
  description: string | null | undefined;
}): string | null {
  if (!input.date || !input.signedAmount) return null;
  const identity = JSON.stringify([
    input.date,
    normalizeSignedAmount(input.signedAmount),
    input.type,
    normalizeFinancialImportDescription(input.description),
  ]);
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

export function createLegacyFinancialImportFingerprint(input: {
  date: string;
  signedAmount: string;
  description: string | null | undefined;
}): string {
  const identity = [input.date, normalizeSignedAmount(input.signedAmount), normalizeFinancialImportDescription(input.description)].join("|");
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

export function createLegacyOfxFinancialImportFingerprint(input: {
  accountReferenceHash: string;
  date: string;
  signedAmount: string;
  description: string | null | undefined;
}): string {
  return createHash("sha256")
    .update([input.accountReferenceHash, input.date, normalizeSignedAmount(input.signedAmount), normalizeFinancialImportDescription(input.description)].join("|"), "utf8")
    .digest("hex");
}

export function normalizeSignedAmount(value: string): string {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return value;
  const integer = match[2]!.replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").padEnd(2, "0");
  return `${match[1]}${integer}.${fraction}`;
}

export function normalizeFinancialImportDescription(value: string | null | undefined): string {
  return value?.normalize("NFKC").toLocaleLowerCase("pt-BR").replaceAll(/\s+/g, " ").trim() ?? "";
}
