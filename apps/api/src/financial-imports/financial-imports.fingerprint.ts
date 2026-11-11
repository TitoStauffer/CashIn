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

/**
 * The identity an issuer's FITID gives a transaction: the identifier **together with** the signed amount.
 *
 * The OFX specification says a FITID is unique per account, and both duplicate checks used to trust it
 * alone. The card issuer breaks that: it gives an international purchase and the IOF charged on it the
 * same FITID (DEV-124). Trusting the identifier alone marked the purchase as a duplicate of its own tax,
 * inside the file and across imports, and the purchase never reached the statement — R$ 584,98 missing
 * from one real invoice, with no way to import it from the screen.
 *
 * The amount is the corroboration, and not the full fingerprint, on purpose. A FITID exists to recognise
 * a transaction whose description or date changed between two exports; requiring the whole fingerprint
 * would throw that away and let an amended reimport duplicate. The amount does not change for the same
 * transaction, and compared with its sign it tells apart the purchase, its IOF and the IOF reversal.
 *
 * Returns `null` when either half is missing: a line without an amount is invalid, not a duplicate.
 */
export function createExternalTransactionIdentity(externalId: string | null, signedAmount: string | null): string | null {
  if (!externalId || !signedAmount) return null;
  return JSON.stringify([externalId, normalizeSignedAmount(signedAmount)]);
}

export function normalizeFinancialImportDescription(value: string | null | undefined): string {
  return value?.normalize("NFKC").toLocaleLowerCase("pt-BR").replaceAll(/\s+/g, " ").trim() ?? "";
}
