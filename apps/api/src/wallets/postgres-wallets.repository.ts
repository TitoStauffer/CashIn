import type { Database } from "../database.js";
import type { Wallet, WalletRepository } from "./wallets.types.js";

interface WalletRow {
  id: string;
  name: string;
  is_personal: boolean;
  role: "owner" | "member";
}

function mapWallet(row: WalletRow): Wallet {
  return { id: row.id, name: row.name, isPersonal: row.is_personal, role: row.role };
}

export class PostgresWalletsRepository implements WalletRepository {
  constructor(private readonly database: Database) {}

  async listForUser(userId: string): Promise<Wallet[]> {
    const result = await this.database.query<WalletRow>(
      `SELECT wallet.id, wallet.name, wallet.is_personal, membership.role
       FROM wallet_members AS membership
       JOIN wallets AS wallet ON wallet.id = membership.wallet_id
       WHERE membership.user_id = $1
       ORDER BY wallet.is_personal DESC, lower(wallet.name), wallet.id`,
      [userId],
    );
    return result.rows.map(mapWallet);
  }

  async findPersonalForUser(userId: string): Promise<Wallet | null> {
    const result = await this.database.query<WalletRow>(
      `SELECT wallet.id, wallet.name, wallet.is_personal, membership.role
       FROM wallets AS wallet
       JOIN wallet_members AS membership ON membership.wallet_id = wallet.id
       WHERE wallet.owner_user_id = $1 AND wallet.is_personal AND membership.user_id = $1`,
      [userId],
    );
    return result.rows[0] ? mapWallet(result.rows[0]) : null;
  }

  async findAccessibleWallet(userId: string, walletId: string): Promise<Wallet | null> {
    const result = await this.database.query<WalletRow>(
      `SELECT wallet.id, wallet.name, wallet.is_personal, membership.role
       FROM wallet_members AS membership
       JOIN wallets AS wallet ON wallet.id = membership.wallet_id
       WHERE membership.user_id = $1 AND wallet.id = $2`,
      [userId, walletId],
    );
    return result.rows[0] ? mapWallet(result.rows[0]) : null;
  }

  async createForUser(userId: string, name: string): Promise<Wallet> {
    const result = await this.database.query<WalletRow>(
      `INSERT INTO wallets (owner_user_id, name, is_personal)
       VALUES ($1, $2, false)
       RETURNING id, name, is_personal, 'owner'::text AS role`,
      [userId, name],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Wallet insert returned no row");
    return mapWallet(row);
  }
}
