import type { FinancialImportFormat, FinancialImportKind, FinancialImportSession } from "./financial-imports.types.js";

// What the import use cases report about themselves (DEV-135). The service depends on this interface,
// never on the OpenTelemetry SDK: the default records nothing, `createApp` plugs in the OpenTelemetry
// adapter, and tests plug in a fake. Every event carries only the format and the kind of the import —
// no user, wallet, file name, description or amount.
export interface FinancialImportOrigin {
  format: FinancialImportFormat;
  kind: FinancialImportKind;
}

export interface FinancialImportConfirmedEvent extends FinancialImportOrigin {
  // Lines that became movements, lines left out as duplicates and lines refused by validation.
  imported: number;
  skippedDuplicate: number;
  rejectedInvalid: number;
}

export interface FinancialImportMetrics {
  importConfirmed(event: FinancialImportConfirmedEvent): void;
  importUndone(event: FinancialImportOrigin): void;
  importFailed(event: FinancialImportOrigin): void;
}

export const noFinancialImportMetrics: FinancialImportMetrics = {
  importConfirmed: () => {},
  importUndone: () => {},
  importFailed: () => {},
};

export function originOf(session: Pick<FinancialImportSession, "format" | "kind">): FinancialImportOrigin {
  return { format: session.format, kind: session.kind };
}

export function confirmedEventOf(session: Pick<FinancialImportSession, "format" | "kind" | "summary">): FinancialImportConfirmedEvent {
  return {
    ...originOf(session),
    imported: session.summary.imported,
    skippedDuplicate: session.summary.duplicate,
    rejectedInvalid: session.summary.invalid,
  };
}
