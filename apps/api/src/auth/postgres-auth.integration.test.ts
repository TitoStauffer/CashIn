import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../database.js";
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
