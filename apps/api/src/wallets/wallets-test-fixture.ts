import type { WalletRepository } from "./wallets.types.js";

export class WalletsTestFixture implements WalletRepository {
  async listForUser(userId: string) {
    return [{ id: userId, name: "Pessoal", isPersonal: true, role: "owner" as const }];
  }

  async findPersonalForUser(userId: string) {
    return { id: userId, name: "Pessoal", isPersonal: true, role: "owner" as const };
  }

  async findAccessibleWallet(userId: string, walletId: string) {
    return userId === walletId
      ? { id: walletId, name: "Pessoal", isPersonal: true, role: "owner" as const }
      : null;
  }

  async createForUser(userId: string, name: string) {
    return { id: userId, name, isPersonal: false, role: "owner" as const };
  }
}
