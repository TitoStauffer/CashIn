import type { Database } from "../database.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "./auth.types.js";

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
}

interface IdRow {
  id: string;
}

interface VerificationRow {
  user_id: string;
}

function mapStoredUser(row: UserRow): StoredUser {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    emailVerifiedAt: row.email_verified_at,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly database: Database) {}

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    const result = await this.database.query<UserRow>(
      `SELECT id, email, password_hash, email_verified_at
       FROM users WHERE email = $1`,
      [email],
    );
    return result.rows[0] ? mapStoredUser(result.rows[0]) : null;
  }

  async createPendingAccount(
    email: string,
    passwordHash: string,
    verificationTokenHash: string,
    verificationTokenExpiresAt: Date,
  ): Promise<PendingAccount | null> {
    try {
      return await this.database.transaction(async (transaction) => {
        const insertedUser = await transaction.query<IdRow & { email: string }>(
          `INSERT INTO users (email, password_hash)
           VALUES ($1, $2)
           RETURNING id, email`,
          [email, passwordHash],
        );
        const user = insertedUser.rows[0];
        if (!user) throw new Error("Account insert returned no row");

        await transaction.query(
          `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at)
           VALUES ($1, $2, $3)`,
          [user.id, verificationTokenHash, verificationTokenExpiresAt],
        );

        return { user: { id: user.id, email: user.email } };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async deleteUnverifiedUser(userId: string): Promise<void> {
    await this.database.query(
      "DELETE FROM users WHERE id = $1 AND email_verified_at IS NULL",
      [userId],
    );
  }

  async verifyEmail(tokenHash: string, now: Date): Promise<boolean> {
    return this.database.transaction(async (transaction) => {
      const token = await transaction.query<VerificationRow>(
        `UPDATE email_verification_tokens
         SET used_at = $2
         WHERE token_hash = $1 AND used_at IS NULL AND expires_at > $2
         RETURNING user_id`,
        [tokenHash, now],
      );
      const userId = token.rows[0]?.user_id;
      if (!userId) return false;

      const user = await transaction.query<IdRow>(
        `UPDATE users
         SET email_verified_at = $2
         WHERE id = $1 AND email_verified_at IS NULL
         RETURNING id`,
        [userId, now],
      );
      return user.rows.length === 1;
    });
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.database.query(
      `INSERT INTO auth_sessions (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );
  }

  async findUserBySession(tokenHash: string, now: Date): Promise<AuthUser | null> {
    const result = await this.database.query<AuthUser>(
      `SELECT users.id, users.email
       FROM auth_sessions
       INNER JOIN users ON users.id = auth_sessions.user_id
       WHERE auth_sessions.token_hash = $1
         AND auth_sessions.expires_at > $2
         AND users.email_verified_at IS NOT NULL`,
      [tokenHash, now],
    );
    return result.rows[0] ?? null;
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.database.query("DELETE FROM auth_sessions WHERE token_hash = $1", [tokenHash]);
  }
}
