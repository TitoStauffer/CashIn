import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { createDatabase } from "../database.js";
import { PostgresWalletInvitationRepository } from "../wallet-invitations/postgres-wallet-invitation.repository.js";
import { PostgresWalletAccessRequestRepository } from "./postgres-wallet-access-request.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL wallet access requests enforce owner access, opaque links, decisions, and invite acceptance", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `wallet_access_${randomBytes(8).toString("hex")}`;
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
    const requesterId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const otherId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    await database.query(
      `INSERT INTO users (id, email, password_hash, email_verified_at) VALUES
        ($1, 'owner@example.com', 'test-hash', now()),
        ($2, 'requester@example.com', 'test-hash', now()),
        ($3, 'other@example.com', 'test-hash', now())`,
      [ownerId, requesterId, otherId],
    );
    const wallet = await database.query<{ id: string }>(
      "INSERT INTO wallets (owner_user_id, name, is_personal) VALUES ($1, 'Family', false) RETURNING id",
      [ownerId],
    );
    const walletId = wallet.rows[0]!.id;
    const accessRepository = new PostgresWalletAccessRequestRepository(database);
    const invitationRepository = new PostgresWalletInvitationRepository(database);
    const now = new Date("2026-10-20T12:00:00.000Z");
    const rawLinkToken = "raw-access-link-token";
    const linkTokenHash = "1".repeat(64);
    const link = await accessRepository.createLink(walletId, ownerId, linkTokenHash, new Date(now.getTime() + 86_400_000), now);

    const storedHash = await database.query<{ token_hash: string }>(
      "SELECT token_hash FROM wallet_access_links WHERE id = $1",
      [link.id],
    );
    assert.equal(storedHash.rows[0]?.token_hash, linkTokenHash);
    assert.notEqual(storedHash.rows[0]?.token_hash, rawLinkToken);
    assert.equal(await accessRepository.createRequest("f".repeat(64), "requester@example.com", now), null);

    const created = await accessRepository.createRequest(linkTokenHash, "requester@example.com", now);
    assert.equal(created?.ownerEmail, "owner@example.com");
    assert.equal(created?.walletId, walletId);
    assert.equal(await accessRepository.createRequest(linkTokenHash, "requester@example.com", now), null);
    assert.equal(await accessRepository.listRequests(walletId, otherId, now), null);
    assert.equal((await accessRepository.listRequests(walletId, ownerId, now))?.[0]?.status, "pending");

    const pending = await accessRepository.findPendingRequest(walletId, ownerId, created!.request.id, now);
    assert.ok(pending);
    const invitation = await invitationRepository.createInvitation(
      walletId,
      ownerId,
      pending!.email,
      "2".repeat(64),
      new Date(now.getTime() + 86_400_000),
      now,
    );
    assert.equal(await accessRepository.approveRequest(walletId, ownerId, pending!.id, invitation.invitation.id, now), true);
    assert.equal((await accessRepository.listRequests(walletId, ownerId, now))?.[0]?.status, "approved");

    const accepted = await invitationRepository.acceptInvitation("2".repeat(64), requesterId, "requester@example.com", now);
    assert.equal(accepted?.id, walletId);
    assert.equal((await accessRepository.listRequests(walletId, ownerId, now))?.[0]?.status, "accepted");

    const personalWallet = await database.query<{ id: string }>(
      "SELECT id FROM wallets WHERE owner_user_id = $1 AND is_personal",
      [otherId],
    );
    await assert.rejects(
      accessRepository.createLink(personalWallet.rows[0]!.id, otherId, "3".repeat(64), new Date(now.getTime() + 60_000), now),
      /carteiras compartilhadas/i,
    );
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
