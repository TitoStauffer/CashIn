import type { Database, QueryExecutor } from "../database.js";
import type { Wallet } from "../wallets/wallets.types.js";
import { WalletInvitationError } from "./wallet-invitations.errors.js";
import type {
  CreatedWalletInvitation,
  WalletInvitation,
  WalletInvitationRepository,
  WalletMember,
} from "./wallet-invitations.types.js";

interface InvitationRow {
  id: string;
  email_normalized: string;
  status: WalletInvitation["status"];
  expires_at: Date;
  created_at: Date;
  accepted_at: Date | null;
  cancelled_at: Date | null;
}

interface OwnerWalletRow {
  name: string;
  email: string;
  is_personal: boolean;
}

interface AcceptanceRow {
  id: string;
  wallet_id: string;
  email_normalized: string;
  expires_at: Date;
  status: WalletInvitation["status"];
  account_email: string;
  email_verified_at: Date | null;
  wallet_name: string;
  wallet_is_personal: boolean;
}

interface MemberRow {
  id: string;
  email: string;
  role: "owner" | "member";
  created_at: Date;
}

function mapInvitation(row: InvitationRow): WalletInvitation {
  return {
    id: row.id,
    email: row.email_normalized,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    acceptedAt: row.accepted_at,
    cancelledAt: row.cancelled_at,
  };
}

async function expirePendingInvitations(
  executor: QueryExecutor,
  walletId: string,
  now: Date,
  email?: string,
): Promise<void> {
  await executor.query(
    `UPDATE wallet_invitations
     SET status = 'expired', expired_at = $2
     WHERE wallet_id = $1 AND status = 'pending' AND expires_at <= $2
       AND ($3::varchar IS NULL OR email_normalized = $3)`,
    [walletId, now, email ?? null],
  );
}

export class PostgresWalletInvitationRepository implements WalletInvitationRepository {
  constructor(private readonly database: Database) {}

  async createInvitation(
    walletId: string,
    ownerUserId: string,
    email: string,
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<CreatedWalletInvitation> {
    return this.database.transaction(async (transaction) => {
      const walletResult = await transaction.query<OwnerWalletRow>(
        `SELECT wallet.name, users.email, wallet.is_personal
         FROM wallets AS wallet
         JOIN users ON users.id = wallet.owner_user_id
         WHERE wallet.id = $1 AND wallet.owner_user_id = $2
         FOR UPDATE OF wallet`,
        [walletId, ownerUserId],
      );
      const wallet = walletResult.rows[0];
      if (!wallet) throw new WalletInvitationError("Carteira não encontrada.", 404);
      if (wallet.is_personal) {
        throw new WalletInvitationError("Convites só podem ser enviados para carteiras compartilhadas.", 400);
      }

      await expirePendingInvitations(transaction, walletId, now, email);

      const existingMember = await transaction.query<{ id: string }>(
        `SELECT membership.user_id AS id
         FROM wallet_members AS membership
         JOIN users ON users.id = membership.user_id
         WHERE membership.wallet_id = $1 AND lower(users.email) = $2`,
        [walletId, email],
      );
      if (existingMember.rows.length > 0) {
        throw new WalletInvitationError("Este e-mail já tem acesso à carteira.", 409);
      }

      const result = await transaction.query<InvitationRow>(
        `INSERT INTO wallet_invitations
           (wallet_id, invited_by_user_id, email_normalized, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, email_normalized, status, expires_at, created_at, accepted_at, cancelled_at`,
        [walletId, ownerUserId, email, tokenHash, expiresAt],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Wallet invitation insert returned no row");
      return {
        invitation: mapInvitation(row),
        walletName: wallet.name,
        inviterEmail: wallet.email,
      };
    });
  }

  async listInvitations(walletId: string, ownerUserId: string, now: Date): Promise<WalletInvitation[] | null> {
    const owner = await this.findOwnedWallet(walletId, ownerUserId);
    if (!owner) return null;
    await expirePendingInvitations(this.database, walletId, now);
    const result = await this.database.query<InvitationRow>(
      `SELECT id, email_normalized, status, expires_at, created_at, accepted_at, cancelled_at
       FROM wallet_invitations
       WHERE wallet_id = $1
       ORDER BY created_at DESC, id DESC`,
      [walletId],
    );
    return result.rows.map(mapInvitation);
  }

  async cancelInvitation(walletId: string, ownerUserId: string, invitationId: string, now: Date): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const owner = await this.findOwnedWallet(walletId, ownerUserId, transaction);
      if (!owner) return false;
      await expirePendingInvitations(transaction, walletId, now);
      const result = await transaction.query(
        `UPDATE wallet_invitations
         SET status = 'cancelled', cancelled_at = $4
         WHERE id = $1 AND wallet_id = $2 AND invited_by_user_id = $3 AND status = 'pending'
         RETURNING id`,
        [invitationId, walletId, ownerUserId, now],
      );
      return result.rows.length === 1;
    });
  }

  async acceptInvitation(tokenHash: string, userId: string, verifiedEmail: string, now: Date): Promise<Wallet | null> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query<AcceptanceRow>(
        `SELECT invitation.id, invitation.wallet_id, invitation.email_normalized,
                invitation.expires_at, invitation.status, users.email AS account_email,
                users.email_verified_at, wallet.name AS wallet_name,
                wallet.is_personal AS wallet_is_personal
         FROM wallet_invitations AS invitation
         JOIN users ON users.id = $2
         JOIN wallets AS wallet ON wallet.id = invitation.wallet_id
         WHERE invitation.token_hash = $1
         FOR UPDATE OF invitation`,
        [tokenHash, userId],
      );
      const invitation = result.rows[0];
      if (!invitation || invitation.status !== "pending") return null;

      if (invitation.expires_at <= now) {
        await transaction.query(
          `UPDATE wallet_invitations SET status = 'expired', expired_at = $2
           WHERE id = $1 AND status = 'pending'`,
          [invitation.id, now],
        );
        return null;
      }

      if (
        !invitation.email_verified_at
        || invitation.email_normalized !== verifiedEmail
        || invitation.email_normalized !== invitation.account_email.trim().toLowerCase()
      ) return null;

      await transaction.query(
        `INSERT INTO wallet_members (wallet_id, user_id, role)
         VALUES ($1, $2, 'member')
         ON CONFLICT (wallet_id, user_id) DO NOTHING`,
        [invitation.wallet_id, userId],
      );
      const accepted = await transaction.query(
        `UPDATE wallet_invitations
         SET status = 'accepted', accepted_by_user_id = $2, accepted_at = $3
         WHERE id = $1 AND status = 'pending'
         RETURNING id`,
        [invitation.id, userId, now],
      );
      return accepted.rows.length === 1
        ? { id: invitation.wallet_id, name: invitation.wallet_name, isPersonal: invitation.wallet_is_personal, role: "member" }
        : null;
    });
  }

  async listMembers(walletId: string, ownerUserId: string): Promise<WalletMember[] | null> {
    const owner = await this.findOwnedWallet(walletId, ownerUserId);
    if (!owner) return null;
    const result = await this.database.query<MemberRow>(
      `SELECT users.id, users.email, membership.role, membership.created_at
       FROM wallet_members AS membership
       JOIN users ON users.id = membership.user_id
       WHERE membership.wallet_id = $1
       ORDER BY CASE WHEN membership.role = 'owner' THEN 0 ELSE 1 END, lower(users.email), users.id`,
      [walletId],
    );
    return result.rows.map((row) => ({ id: row.id, email: row.email, role: row.role, createdAt: row.created_at }));
  }

  async removeMember(
    walletId: string,
    ownerUserId: string,
    userId: string,
  ): Promise<"removed" | "owner" | "missing"> {
    return this.database.transaction(async (transaction) => {
      const owner = await this.findOwnedWallet(walletId, ownerUserId, transaction);
      if (!owner) return "missing";
      if (userId === ownerUserId) return "owner";
      const result = await transaction.query(
        `DELETE FROM wallet_members AS membership
         USING wallets AS wallet
         WHERE membership.wallet_id = wallet.id AND wallet.id = $1
           AND wallet.owner_user_id = $2 AND membership.user_id = $3
           AND membership.role = 'member'
         RETURNING membership.user_id`,
        [walletId, ownerUserId, userId],
      );
      return result.rows.length === 1 ? "removed" : "missing";
    });
  }

  private async findOwnedWallet(walletId: string, ownerUserId: string, executor: QueryExecutor = this.database): Promise<boolean> {
    const result = await executor.query<{ id: string }>(
      "SELECT id FROM wallets WHERE id = $1 AND owner_user_id = $2",
      [walletId, ownerUserId],
    );
    return result.rows.length === 1;
  }
}
