import type { Database, QueryExecutor } from "../database.js";
import { WalletAccessRequestError } from "./wallet-access-requests.errors.js";
import type {
  CreatedWalletAccessLink,
  CreatedWalletAccessRequest,
  WalletAccessRequest,
  WalletAccessRequestForApproval,
  WalletAccessRequestRepository,
} from "./wallet-access-requests.types.js";

interface AccessRequestRow {
  id: string;
  email_normalized: string;
  status: WalletAccessRequest["status"];
  created_at: Date;
  expires_at: Date;
  approved_at: Date | null;
  rejected_at: Date | null;
  cancelled_at: Date | null;
}

interface AccessLinkOwnerRow {
  id: string;
  name: string;
}

interface CreatedRequestRow extends AccessRequestRow {
  wallet_name: string;
  owner_email: string;
}

function mapRequest(row: AccessRequestRow): WalletAccessRequest {
  return {
    id: row.id,
    email: row.email_normalized,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    approvedAt: row.approved_at,
    rejectedAt: row.rejected_at,
    cancelledAt: row.cancelled_at,
  };
}

async function expireRequests(executor: QueryExecutor, walletId: string, now: Date): Promise<void> {
  await executor.query(
    `UPDATE wallet_access_requests
     SET status = 'expired', expired_at = expires_at
     WHERE wallet_id = $1 AND status = 'pending' AND expires_at <= $2`,
    [walletId, now],
  );
}

export class PostgresWalletAccessRequestRepository implements WalletAccessRequestRepository {
  constructor(private readonly database: Database) {}

  async createLink(
    walletId: string,
    ownerUserId: string,
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<CreatedWalletAccessLink> {
    return this.database.transaction(async (transaction) => {
      const walletResult = await transaction.query<AccessLinkOwnerRow & { is_personal: boolean }>(
        `SELECT wallet.id, wallet.name, wallet.is_personal
         FROM wallets AS wallet
         WHERE wallet.id = $1 AND wallet.owner_user_id = $2
         FOR UPDATE`,
        [walletId, ownerUserId],
      );
      const wallet = walletResult.rows[0];
      if (!wallet) throw new WalletAccessRequestError("Carteira não encontrada.", 404);
      if (wallet.is_personal) throw new WalletAccessRequestError("Solicitações só podem ser habilitadas em carteiras compartilhadas.", 400);

      await transaction.query(
        `UPDATE wallet_access_links SET revoked_at = $3
         WHERE wallet_id = $1 AND owner_user_id = $2 AND revoked_at IS NULL AND expires_at > $3`,
        [walletId, ownerUserId, now],
      );
      const result = await transaction.query<{ id: string; expires_at: Date }>(
        `INSERT INTO wallet_access_links (wallet_id, owner_user_id, token_hash, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, expires_at`,
        [walletId, ownerUserId, tokenHash, expiresAt, now],
      );
      const link = result.rows[0];
      if (!link) throw new Error("Wallet access link insert returned no row");
      return { id: link.id, expiresAt: link.expires_at, walletName: wallet.name };
    });
  }

  async createRequest(tokenHash: string, email: string, now: Date): Promise<CreatedWalletAccessRequest | null> {
    try {
      return await this.database.transaction(async (transaction) => {
      const linkResult = await transaction.query<{
        id: string;
        wallet_id: string;
        owner_user_id: string;
        expires_at: Date;
        wallet_name: string;
        owner_email: string;
        is_personal: boolean;
      }>(
        `SELECT access_link.id, access_link.wallet_id, access_link.owner_user_id,
                access_link.expires_at, wallet.name AS wallet_name,
                users.email AS owner_email, wallet.is_personal
         FROM wallet_access_links AS access_link
         JOIN wallets AS wallet ON wallet.id = access_link.wallet_id
         JOIN users ON users.id = access_link.owner_user_id
         WHERE access_link.token_hash = $1 AND access_link.revoked_at IS NULL
         FOR UPDATE OF access_link`,
        [tokenHash],
      );
      const link = linkResult.rows[0];
      if (!link || link.expires_at <= now || link.is_personal) return null;

      await transaction.query(
        `UPDATE wallet_access_requests
         SET status = 'expired', expired_at = expires_at
         WHERE wallet_id = $1 AND email_normalized = $2 AND status = 'pending' AND expires_at <= $3`,
        [link.wallet_id, email, now],
      );

      const existingAccess = await transaction.query<{ id: string }>(
        `SELECT membership.user_id AS id
         FROM wallet_members AS membership
         JOIN users ON users.id = membership.user_id
         WHERE membership.wallet_id = $1 AND lower(users.email) = $2
         UNION ALL
         SELECT invitation.id
         FROM wallet_invitations AS invitation
         WHERE invitation.wallet_id = $1 AND invitation.email_normalized = $2
           AND invitation.status = 'pending' AND invitation.expires_at > $3
         LIMIT 1`,
        [link.wallet_id, email, now],
      );
      if (existingAccess.rows.length > 0) return null;

      const result = await transaction.query<CreatedRequestRow>(
        `INSERT INTO wallet_access_requests
           (wallet_id, owner_user_id, access_link_id, email_normalized, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, email_normalized, status, created_at, expires_at,
                   approved_at, rejected_at, cancelled_at`,
        [link.wallet_id, link.owner_user_id, link.id, email, link.expires_at, now],
      );
      const row = result.rows[0];
      if (!row) throw new Error("Wallet access request insert returned no row");
      return {
        request: mapRequest(row),
        walletId: link.wallet_id,
        walletName: link.wallet_name,
        ownerEmail: link.owner_email,
      };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async listRequests(walletId: string, ownerUserId: string, now: Date): Promise<WalletAccessRequest[] | null> {
    if (!await this.ownsWallet(walletId, ownerUserId)) return null;
    await expireRequests(this.database, walletId, now);
    const result = await this.database.query<AccessRequestRow>(
      `SELECT request.id, request.email_normalized,
              CASE WHEN request.status = 'approved' AND invitation.status = 'accepted'
                   THEN 'accepted' ELSE request.status END AS status,
              request.created_at, request.expires_at, request.approved_at,
              request.rejected_at, request.cancelled_at
       FROM wallet_access_requests AS request
       LEFT JOIN wallet_invitations AS invitation ON invitation.id = request.wallet_invitation_id
       WHERE request.wallet_id = $1 AND request.owner_user_id = $2
       ORDER BY request.created_at DESC, request.id DESC`,
      [walletId, ownerUserId],
    );
    return result.rows.map(mapRequest);
  }

  async findPendingRequest(
    walletId: string,
    ownerUserId: string,
    requestId: string,
    now: Date,
  ): Promise<WalletAccessRequestForApproval | null> {
    return this.database.transaction(async (transaction) => {
      if (!await this.ownsWallet(walletId, ownerUserId, transaction)) return null;
      await expireRequests(transaction, walletId, now);
      const result = await transaction.query<{ id: string; email_normalized: string; created_at: Date; expires_at: Date }>(
        `SELECT id, email_normalized, created_at, expires_at
         FROM wallet_access_requests
         WHERE id = $1 AND wallet_id = $2 AND owner_user_id = $3 AND status = 'pending'
         FOR UPDATE`,
        [requestId, walletId, ownerUserId],
      );
      const row = result.rows[0];
      return row ? { id: row.id, email: row.email_normalized, createdAt: row.created_at, expiresAt: row.expires_at } : null;
    });
  }

  async approveRequest(walletId: string, ownerUserId: string, requestId: string, invitationId: string, now: Date): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const result = await transaction.query(
        `UPDATE wallet_access_requests AS request
         SET status = 'approved', approved_at = $4, wallet_invitation_id = $5
         FROM wallets AS wallet
         WHERE request.id = $1 AND request.wallet_id = $2 AND request.owner_user_id = $3
           AND request.status = 'pending' AND request.expires_at > $4
           AND wallet.id = request.wallet_id AND wallet.owner_user_id = request.owner_user_id
         RETURNING request.id`,
        [requestId, walletId, ownerUserId, now, invitationId],
      );
      return result.rows.length === 1;
    });
  }

  async rejectRequest(walletId: string, ownerUserId: string, requestId: string, now: Date): Promise<boolean> {
    return this.setPendingState(walletId, ownerUserId, requestId, "rejected", now);
  }

  async cancelRequest(walletId: string, ownerUserId: string, requestId: string, now: Date): Promise<boolean> {
    return this.setPendingState(walletId, ownerUserId, requestId, "cancelled", now);
  }

  private async setPendingState(
    walletId: string,
    ownerUserId: string,
    requestId: string,
    state: "rejected" | "cancelled",
    now: Date,
  ): Promise<boolean> {
    const timestampColumn = state === "rejected" ? "rejected_at" : "cancelled_at";
    const result = await this.database.query(
      `UPDATE wallet_access_requests AS request
       SET status = $4, ${timestampColumn} = $5
       FROM wallets AS wallet
       WHERE request.id = $1 AND request.wallet_id = $2 AND request.owner_user_id = $3
         AND request.status = 'pending' AND request.expires_at > $5
         AND wallet.id = request.wallet_id AND wallet.owner_user_id = request.owner_user_id
       RETURNING request.id`,
      [requestId, walletId, ownerUserId, state, now],
    );
    return result.rows.length === 1;
  }

  private async ownsWallet(walletId: string, ownerUserId: string, executor: QueryExecutor = this.database): Promise<boolean> {
    const result = await executor.query<{ id: string }>(
      "SELECT id FROM wallets WHERE id = $1 AND owner_user_id = $2",
      [walletId, ownerUserId],
    );
    return result.rows.length === 1;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
