export class PaymentMethodError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "PaymentMethodError";
  }
}

export class PaymentMethodConflictError extends PaymentMethodError {
  constructor(message: string) {
    super(message, 409);
    this.name = "PaymentMethodConflictError";
  }
}

export class InvalidPaymentMethodReferenceError extends PaymentMethodError {
  constructor() {
    super("A forma de pagamento informada não está disponível nesta carteira.", 400);
    this.name = "InvalidPaymentMethodReferenceError";
  }
}
