export class FinancialSummaryError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "FinancialSummaryError";
  }
}
