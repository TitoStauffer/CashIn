import { metrics, type Meter } from "@opentelemetry/api";
import type {
  FinancialImportConfirmedEvent,
  FinancialImportMetrics,
  FinancialImportOrigin,
} from "./financial-imports/financial-imports.metrics.js";

// OpenTelemetry adapter of the import metrics (DEV-135). It uses only the OpenTelemetry API: when the SDK is
// not running (no endpoint, or OTEL_METRICS_EXPORTER unset) the meter is a no-op and recording costs
// nothing. Its labels — import.format, import.kind, item.outcome — are on the metric allowlist of
// telemetry.ts; any other label would be dropped there.
export const BUSINESS_METRIC_NAMES = [
  "financial_import.confirmed",
  "financial_import.undone",
  "financial_import.failed",
  "financial_import.items",
  "financial_import.batch.size",
] as const;

export class OpenTelemetryFinancialImportMetrics implements FinancialImportMetrics {
  private readonly confirmed;
  private readonly undone;
  private readonly failed;
  private readonly items;
  private readonly batchSize;

  constructor(meter: Meter = metrics.getMeter("saldocerto-api.financial-imports")) {
    this.confirmed = meter.createCounter("financial_import.confirmed", { unit: "{import}", description: "Imports confirmed (committed)." });
    this.undone = meter.createCounter("financial_import.undone", { unit: "{import}", description: "Imports undone." });
    this.failed = meter.createCounter("financial_import.failed", { unit: "{import}", description: "Uploads that could not be turned into a preview." });
    this.items = meter.createCounter("financial_import.items", { unit: "{line}", description: "Lines of confirmed imports, by outcome." });
    this.batchSize = meter.createHistogram("financial_import.batch.size", {
      unit: "{line}",
      description: "Lines imported per confirmed import.",
      advice: { explicitBucketBoundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] },
    });
  }

  importConfirmed(event: FinancialImportConfirmedEvent): void {
    const origin = labelsOf(event);
    this.confirmed.add(1, origin);
    this.items.add(event.imported, { ...origin, "item.outcome": "imported" });
    this.items.add(event.skippedDuplicate, { ...origin, "item.outcome": "skipped_duplicate" });
    this.items.add(event.rejectedInvalid, { ...origin, "item.outcome": "rejected_invalid" });
    this.batchSize.record(event.imported, origin);
  }

  importUndone(event: FinancialImportOrigin): void {
    this.undone.add(1, labelsOf(event));
  }

  importFailed(event: FinancialImportOrigin): void {
    this.failed.add(1, labelsOf(event));
  }
}

function labelsOf(origin: FinancialImportOrigin) {
  return { "import.format": origin.format, "import.kind": origin.kind };
}
