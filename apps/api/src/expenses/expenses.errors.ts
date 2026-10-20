export class ExpenseError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "ExpenseError";
  }
}

export class InvalidExpenseReferenceError extends ExpenseError {
  constructor() {
    super("A categoria ou subcategoria informada é inválida.", 400);
    this.name = "InvalidExpenseReferenceError";
  }
}
