import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../app.js";
import { PostgresAuthRepository } from "../auth/postgres-auth.repository.js";
import { createOpaqueToken, hashToken } from "../auth/token.js";
import { createDatabase, runMigrations } from "../database.js";
import { FINANCIAL_IMPORT_PROCESSING_TIMEOUT_MINUTES } from "./financial-imports.service.js";
import type { FinancialImportSession } from "./financial-imports.types.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function bankOfx(id: string, name: string): Buffer {
  return Buffer.from([
    "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "ENCODING:UTF-8", "CHARSET:UTF-8", "",
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
    "<CURDEF>BRL",
    "<BANKACCTFROM><BANKID>001<ACCTID>12345-6<ACCTTYPE>CHECKING</BANKACCTFROM>",
    "<BANKTRANLIST>",
    "<STMTTRN>",
    "<TRNTYPE>CREDIT",
    "<DTPOSTED>20261005120000[-3:BRT]",
    "<TRNAMT>1200.00",
    `<FITID>${id}`,
    `<NAME>${name}`,
    "</STMTTRN>",
    "</BANKTRANLIST>",
    "</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
  ].join("\n"), "utf8");
}

// The traceability and the authorization of an import, against the real schema: who imported a file,
// who is allowed to learn it, and what happens to an import whose request never came back.
test("PostgreSQL imports stay authorized, attributed to their importer, and recoverable after an interruption", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `import_security_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);

    const ownerEmail = `owner-${schemaName}@example.com`;
    const memberEmail = `member-${schemaName}@example.com`;
    const outsiderEmail = `outsider-${schemaName}@example.com`;
    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now()), ($3, 'test-hash', now())
       RETURNING id, email`,
      [ownerEmail, memberEmail, outsiderEmail],
    );
    const idFor = (email: string) => users.rows.find((row) => row.email === email)!.id;
    const ownerId = idFor(ownerEmail);
    const memberId = idFor(memberEmail);
    const outsiderId = idFor(outsiderEmail);

    // A shared wallet: the owner is made a member by the wallet itself, the second user is invited in.
    const sharedWallet = await database.query<{ id: string }>(
      "INSERT INTO wallets (owner_user_id, name, is_personal) VALUES ($1, 'Casa', false) RETURNING id",
      [ownerId],
    );
    const sharedWalletId = sharedWallet.rows[0]!.id;
    await database.query(
      "INSERT INTO wallet_members (wallet_id, user_id, role) VALUES ($1, $2, 'member')",
      [sharedWalletId, memberId],
    );

    const authRepository = new PostgresAuthRepository(database);
    const tokenFor = async (userId: string) => {
      const token = createOpaqueToken();
      await authRepository.createSession(userId, hashToken(token), new Date(Date.now() + 120_000));
      return token;
    };
    const ownerToken = await tokenFor(ownerId);
    const memberToken = await tokenFor(memberId);
    const outsiderToken = await tokenFor(outsiderId);

    app = createApp(database);
    await app.ready();

    const headersFor = (token: string) => ({ cookie: `cashin_session=${token}`, "x-wallet-id": sharedWalletId });
    const upload = (token: string, fileName: string, id: string, name: string) => app!.inject({
      method: "POST",
      url: "/financial-imports",
      headers: { ...headersFor(token), "content-type": "application/octet-stream", "x-file-name": fileName, "x-file-format": "ofx" },
      payload: bankOfx(id, name),
    });
    const history = async (token: string) => ((await app!.inject({
      method: "GET", url: "/financial-imports", headers: headersFor(token),
    })).json() as { items: FinancialImportSession[] }).items;

    const ownerImport = (await upload(ownerToken, "extrato-do-dono.ofx", "sec-owner", "SALARIO")).json() as FinancialImportSession;
    const memberImport = (await upload(memberToken, "extrato-do-membro.ofx", "sec-member", "REEMBOLSO")).json() as FinancialImportSession;

    // The importer is part of the import from the moment it is created, not only of the history.
    assert.deepEqual(ownerImport.importedBy, { userId: ownerId, email: ownerEmail, isCurrentUser: true });
    assert.deepEqual(memberImport.importedBy, { userId: memberId, email: memberEmail, isCurrentUser: true });

    // The owner is the only member allowed to list a wallet's members, so the owner is also the only
    // one who reads another member's e-mail here. Everyone else gets the identifier and the flag.
    const ownerHistory = await history(ownerToken);
    const ownerViewOfMemberImport = ownerHistory.find((session) => session.id === memberImport.id)!;
    const ownerViewOfOwnImport = ownerHistory.find((session) => session.id === ownerImport.id)!;
    assert.deepEqual(ownerViewOfMemberImport.importedBy, { userId: memberId, email: memberEmail, isCurrentUser: false });
    assert.deepEqual(ownerViewOfOwnImport.importedBy, { userId: ownerId, email: ownerEmail, isCurrentUser: true });

    const memberHistory = await history(memberToken);
    const memberViewOfOwnerImport = memberHistory.find((session) => session.id === ownerImport.id)!;
    const memberViewOfOwnImport = memberHistory.find((session) => session.id === memberImport.id)!;
    assert.deepEqual(memberViewOfOwnerImport.importedBy, { userId: ownerId, email: null, isCurrentUser: false });
    assert.deepEqual(memberViewOfOwnImport.importedBy, { userId: memberId, email: memberEmail, isCurrentUser: true });

    // A single import read on its own carries the same attribution as the list.
    const detail = (await app.inject({
      method: "GET", url: `/financial-imports/${ownerImport.id}`, headers: headersFor(memberToken),
    })).json() as FinancialImportSession;
    assert.deepEqual(detail.importedBy, { userId: ownerId, email: null, isCurrentUser: false });

    // Horizontal authorization: a user who is not a member of the wallet is refused, and no session
    // row is created for the file they sent.
    const sessionCount = async () => (await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM import_sessions WHERE wallet_id = $1",
      [sharedWalletId],
    )).rows[0]!.count;
    const before = await sessionCount();
    const refused = await upload(outsiderToken, "invasao.ofx", "sec-outsider", "NAO DEVE ENTRAR");
    assert.equal(refused.statusCode, 404);
    assert.equal(await sessionCount(), before);
    const refusedHistory = await app.inject({ method: "GET", url: "/financial-imports", headers: headersFor(outsiderToken) });
    assert.equal(refusedHistory.statusCode, 404);

    // An import interrupted between its session row and its preview has nothing left to advance it.
    // Reading the history closes it out as a failure, so the state is recoverable and says why.
    const stale = await database.query<{ id: string }>(
      `INSERT INTO import_sessions (wallet_id, created_by_user_id, format, original_filename, file_size_bytes, file_hash, created_at, updated_at)
       VALUES ($1, $2, 'ofx', 'interrompido.ofx', 2048, $3, now() - ($4::integer * interval '1 minute'), now() - ($4::integer * interval '1 minute'))
       RETURNING id`,
      [sharedWalletId, ownerId, "f".repeat(64), FINANCIAL_IMPORT_PROCESSING_TIMEOUT_MINUTES + 5],
    );
    const staleId = stale.rows[0]!.id;
    const recent = await database.query<{ id: string }>(
      `INSERT INTO import_sessions (wallet_id, created_by_user_id, format, original_filename, file_size_bytes, file_hash)
       VALUES ($1, $2, 'ofx', 'em-andamento.ofx', 2048, $3)
       RETURNING id`,
      [sharedWalletId, ownerId, "e".repeat(64)],
    );
    const recentId = recent.rows[0]!.id;

    const afterExpiry = await history(ownerToken);
    const expired = afterExpiry.find((session) => session.id === staleId)!;
    assert.equal(expired.status, "failed");
    assert.equal(expired.failureMessage, "A importação foi interrompida antes de gerar a prévia. Envie o arquivo novamente.");
    assert.ok(expired.failedAt, "an expired import must record when it was closed out");
    // An import that is still within the window is untouched: the expiry never cuts a live request off.
    assert.equal(afterExpiry.find((session) => session.id === recentId)!.status, "processing");
  } finally {
    if (app) await app.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
