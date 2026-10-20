import { WalletError } from "./wallets.errors.js";
import type { Wallet, WalletRepository } from "./wallets.types.js";

const WALLET_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WalletsService {
  constructor(private readonly repository: WalletRepository) {}

  listWallets(userId: string): Promise<Wallet[]> {
    return this.repository.listForUser(userId);
  }

  async resolveActiveWallet(userId: string, requestedWalletId?: string): Promise<string> {
    if (requestedWalletId !== undefined) {
      if (!WALLET_ID_PATTERN.test(requestedWalletId)) {
        throw new WalletError("Carteira não encontrada.", 404);
      }
      const wallet = await this.repository.findAccessibleWallet(userId, requestedWalletId);
      if (!wallet) throw new WalletError("Carteira não encontrada.", 404);
      return wallet.id;
    }

    const personalWallet = await this.repository.findPersonalForUser(userId);
    if (!personalWallet) throw new WalletError("Carteira pessoal não encontrada.", 404);
    return personalWallet.id;
  }

  async createWallet(userId: string, name: string): Promise<Wallet> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new WalletError("O nome da carteira é obrigatório.", 400);
    if (normalizedName.length > 100) throw new WalletError("O nome deve ter no máximo 100 caracteres.", 400);
    try {
      return await this.repository.createForUser(userId, normalizedName);
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
        throw new WalletError("Já existe uma carteira com esse nome.", 409);
      }
      throw error;
    }
  }
}
