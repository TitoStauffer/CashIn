export type WalletRole = "owner" | "member";

export interface Wallet {
  id: string;
  name: string;
  isPersonal: boolean;
  role: WalletRole;
}

export interface WalletRepository {
  listForUser(userId: string): Promise<Wallet[]>;
  findPersonalForUser(userId: string): Promise<Wallet | null>;
  findAccessibleWallet(userId: string, walletId: string): Promise<Wallet | null>;
  createForUser(userId: string, name: string): Promise<Wallet>;
}
