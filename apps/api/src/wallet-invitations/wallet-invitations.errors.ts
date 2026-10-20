export class WalletInvitationError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
    this.name = "WalletInvitationError";
  }
}
