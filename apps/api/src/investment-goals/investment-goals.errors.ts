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
    super("Não é possível registrar aportes em uma meta encerrada.", 409);
    this.name = "ClosedInvestmentGoalError";
  }
}
