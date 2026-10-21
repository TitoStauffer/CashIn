export class CreditCardError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "CreditCardError";
  }
}
