export class WalletError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "WalletError";
  }
}
