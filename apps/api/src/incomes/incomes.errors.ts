export class IncomeError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "IncomeError";
  }
}

export class InvalidIncomeReferenceError extends IncomeError {
  constructor() {
    super("A categoria ou subcategoria informada é inválida.", 400);
    this.name = "InvalidIncomeReferenceError";
  }
}
