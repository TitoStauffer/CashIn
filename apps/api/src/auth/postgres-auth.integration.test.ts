import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../app.js";
import { createDatabase, runMigrations } from "../database.js";
import { hashPassword } from "./password-hasher.js";
import { PostgresAuthRepository } from "./postgres-auth.repository.js";
import { createOpaqueToken, hashToken } from "./token.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL migrations and auth repository persist one-time verification and sessions", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `auth_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    const database = createDatabase(scopedPool);
    await runMigrations(database);
    await runMigrations(database);

    const repository = new PostgresAuthRepository(database);
    const emailToken = createOpaqueToken();
    const account = await repository.createPendingAccount(
      `person-${schemaName}@example.com`,
      "scrypt$test-hash",
      hashToken(emailToken),
      new Date(Date.now() + 60_000),
    );
    assert.ok(account);

    const pendingUser = await repository.findUserByEmail(account.user.email);
    assert.equal(pendingUser?.emailVerifiedAt, null);
    assert.equal(await repository.verifyEmail(hashToken(emailToken), new Date()), true);
    assert.equal(await repository.verifyEmail(hashToken(emailToken), new Date()), false);

    const sessionToken = createOpaqueToken();
    const sessionHash = hashToken(sessionToken);
    await repository.createSession(account.user.id, sessionHash, new Date(Date.now() + 60_000));
    assert.deepEqual(await repository.findUserBySession(sessionHash, new Date()), account.user);
    await repository.deleteSession(sessionHash);
    assert.equal(await repository.findUserBySession(sessionHash, new Date()), null);
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});

// DEV-140 — the mobile login against the real schema: the token from `/auth/token` is a real row of
// `auth_sessions`, it reaches wallet-scoped routes through `X-Wallet-Id` exactly like the cookie, and
// the logout through the header deletes that row.
test("PostgreSQL bearer sessions from the token login carry the wallet scope and end on logout", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `bearer_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);

    const password = "Abcdef1!secure";
    const passwordHash = await hashPassword(password);
    const memberEmail = `member-${schemaName}@example.com`;
    const outsiderEmail = `outsider-${schemaName}@example.com`;
    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, $3, now()), ($2, $3, now())
       RETURNING id, email`,
      [memberEmail, outsiderEmail, passwordHash],
    );
    const memberId = users.rows.find((row) => row.email === memberEmail)!.id;
    const wallet = await database.query<{ id: string }>(
      "INSERT INTO wallets (owner_user_id, name, is_personal) VALUES ($1, 'Casa', false) RETURNING id",
      [memberId],
    );
    const walletId = wallet.rows[0]!.id;

    app = createApp(database);
    await app.ready();
    const tokenFor = async (email: string) => {
      const response = await app!.inject({ method: "POST", url: "/auth/token", payload: { email, password } });
      assert.equal(response.statusCode, 200);
      return (response.json() as { token: string }).token;
    };
    const memberToken = await tokenFor(memberEmail);
    const outsiderToken = await tokenFor(outsiderEmail);

    const sessionRows = async () => (await database.query("SELECT 1 FROM auth_sessions")).rowCount;
    assert.equal(await sessionRows(), 2);

    const categoriesWith = (token: string) => app!.inject({
      method: "GET",
      url: "/categories",
      headers: { authorization: `Bearer ${token}`, "x-wallet-id": walletId },
    });
    assert.equal((await categoriesWith(memberToken)).statusCode, 200);
    const outsider = await categoriesWith(outsiderToken);
    assert.equal(outsider.statusCode, 404);
    assert.deepEqual(outsider.json(), { message: "Carteira não encontrada." });

    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${memberToken}` } });
    assert.equal(logout.statusCode, 204);
    assert.equal(await sessionRows(), 1);
    assert.equal((await categoriesWith(memberToken)).statusCode, 401);
  } finally {
    await app?.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
