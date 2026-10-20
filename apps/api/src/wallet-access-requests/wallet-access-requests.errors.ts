export class WalletAccessRequestError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "WalletAccessRequestError";
  }
}
