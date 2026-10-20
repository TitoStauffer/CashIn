export class InvestmentGoalError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "InvestmentGoalError";
  }
}

export class InvalidInvestmentGoalReferenceError extends InvestmentGoalError {
  constructor() {
    super("A categoria ou subcategoria de investimento informada é inválida.", 400);
    this.name = "InvalidInvestmentGoalReferenceError";
  }
}

export class ClosedInvestmentGoalError extends InvestmentGoalError {
  constructor() {
    super("A meta de investimento está encerrada e não aceita alterações.", 409);
    this.name = "ClosedInvestmentGoalError";
  }
}

export class DuplicateInvestmentGoalError extends InvestmentGoalError {
  constructor() {
    super("Já existe uma meta de investimento com esse nome.", 409);
    this.name = "DuplicateInvestmentGoalError";
  }
}
