import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createDatabase } from "../database.js";
import { PostgresWalletInvitationRepository } from "./postgres-wallet-invitation.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL wallet invitations enforce ownership, verified email, cancellation, expiry, and single-use acceptance", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `wallet_invites_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await database.query(`
      CREATE TABLE schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const migrationDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
    for (const version of [
      "001_auth.sql",
      "002_categories.sql",
      "003_incomes.sql",
      "004_expenses.sql",
      "005_investment_goals.sql",
      "006_financial_precision_and_name_uniqueness.sql",
      "007_wallets.sql",
      "008_wallet_invitations.sql",
      "009_wallet_access_requests.sql",
    ]) {
      const sql = await readFile(join(migrationDirectory, version), "utf8");
      await database.transaction(async (transaction) => {
        await transaction.query(sql);
        await transaction.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      });
    }

    const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const memberId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await database.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at) VALUES
        ($1, 'owner@example.com', 'test-hash', now()),
        ($2, 'member@example.com', 'test-hash', NULL)`,
      [ownerId, memberId],
    );
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO wallets (owner_user_id, name, is_personal)
       VALUES ($1, 'Family', false) RETURNING id`,
      [ownerId],
    );
    const walletId = wallet.rows[0]!.id;
    const repository = new PostgresWalletInvitationRepository(database);
    const now = new Date("2026-10-20T12:00:00.000Z");
    const tokenHash = "1".repeat(64);
    const created = await repository.createInvitation(
      walletId,
      ownerId,
      "member@example.com",
      tokenHash,
      new Date(now.getTime() + 60_000),
      now,
    );

    const storedHash = await database.query<{ token_hash: string }>(
      "SELECT token_hash FROM wallet_invitations WHERE id = $1",
      [created.invitation.id],
    );
    assert.equal(storedHash.rows[0]?.token_hash, tokenHash);
    assert.notEqual(storedHash.rows[0]?.token_hash, "raw-invitation-token");

    assert.equal(await repository.acceptInvitation(tokenHash, memberId, "different@example.com", now), null);
    assert.equal(await repository.acceptInvitation(tokenHash, memberId, "member@example.com", now), null);
    await database.query("UPDATE users SET email_verified_at = $2 WHERE id = $1", [memberId, now]);
    assert.equal(await repository.acceptInvitation(tokenHash, memberId, "different@example.com", now), null);
    const acceptedWallet = await repository.acceptInvitation(tokenHash, memberId, "member@example.com", now);
    assert.deepEqual(acceptedWallet, { id: walletId, name: "Family", isPersonal: false, role: "member" });
    assert.equal(await repository.acceptInvitation(tokenHash, memberId, "member@example.com", now), null);
    assert.equal(await repository.removeMember(walletId, ownerId, ownerId), "owner");
    assert.equal(await repository.removeMember(walletId, ownerId, memberId), "removed");

    const cancelled = await repository.createInvitation(
      walletId,
      ownerId,
      "member@example.com",
      "2".repeat(64),
      new Date(now.getTime() + 60_000),
      now,
    );
    assert.equal(await repository.cancelInvitation(walletId, ownerId, cancelled.invitation.id, now), true);
    assert.equal(await repository.acceptInvitation("2".repeat(64), memberId, "member@example.com", now), null);

    const expiring = await repository.createInvitation(
      walletId,
      ownerId,
      "member@example.com",
      "3".repeat(64),
      new Date(now.getTime() + 1),
      now,
    );
    await repository.listInvitations(walletId, ownerId, new Date(now.getTime() + 2));
    assert.equal(await repository.acceptInvitation("3".repeat(64), memberId, "member@example.com", new Date(now.getTime() + 2)), null);
    const expired = (await repository.listInvitations(walletId, ownerId, now) ?? [])
      .find((invite) => invite.id === expiring.invitation.id);
    assert.equal(expired?.status, "expired");

    await assert.rejects(
      repository.createInvitation(
        walletId,
        memberId,
        "other@example.com",
        "4".repeat(64),
        new Date(now.getTime() + 60_000),
        now,
      ),
      /Carteira não encontrada/,
    );
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
