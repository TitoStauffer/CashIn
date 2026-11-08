import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createApp } from "../app.js";
import { PostgresAuthRepository } from "../auth/postgres-auth.repository.js";
import { createOpaqueToken, hashToken } from "../auth/token.js";
import { createDatabase, runMigrations } from "../database.js";
import type { FinancialImportSession } from "./financial-imports.types.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

const csvConfiguration = {
  delimiter: ";" as const,
  encoding: "utf-8" as const,
  hasHeader: true,
  dateFormat: "dd/MM/yyyy" as const,
  numberFormat: "pt-BR" as const,
  columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
};

// Bank statement where a transfer between the user's own wallets shows up as an ordinary debit on
// one side and an ordinary credit on the other.
function bankOfx(transactions: Array<{ id: string; date: string; amount: string; name: string; type?: string }>): Buffer {
  const body = transactions.map((transaction) => [
    "<STMTTRN>",
    `<TRNTYPE>${transaction.type ?? (transaction.amount.startsWith("-") ? "DEBIT" : "CREDIT")}`,
    `<DTPOSTED>${transaction.date.replaceAll("-", "")}120000[-3:BRT]`,
    `<TRNAMT>${transaction.amount}`,
    `<FITID>${transaction.id}`,
    `<NAME>${transaction.name}`,
    "</STMTTRN>",
  ].join("\n")).join("\n");
  return Buffer.from([
    "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "ENCODING:UTF-8", "CHARSET:UTF-8", "",
    "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>",
    "<CURDEF>BRL",
    "<BANKACCTFROM><BANKID>001<ACCTID>12345-6<ACCTTYPE>CHECKING</BANKACCTFROM>",
    "<BANKTRANLIST>", body, "</BANKTRANLIST>",
    "</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>",
  ].join("\n"), "utf8");
}

test("PostgreSQL wallet transfer reconciliation moves cash between wallets without income or expense", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `wallet_transfer_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);

    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now())
       RETURNING id, email`,
      [`owner-${schemaName}@example.com`, `outsider-${schemaName}@example.com`],
    );
    const userId = users.rows.find((row) => row.email.startsWith("owner-"))!.id;
    const outsiderId = users.rows.find((row) => row.email.startsWith("outsider-"))!.id;
    const personalWallets = await database.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = ANY($1::uuid[]) AND is_personal",
      [[userId, outsiderId]],
    );
    const checkingWalletId = personalWallets.rows.find((row) => row.owner_user_id === userId)!.id;
    const outsiderWalletId = personalWallets.rows.find((row) => row.owner_user_id === outsiderId)!.id;
    // A second wallet of the same user is the other end of the transfers below; the owner becomes a
    // member of it automatically.
    const savingsWallet = await database.query<{ id: string }>(
      "INSERT INTO wallets (owner_user_id, name, is_personal) VALUES ($1, 'Poupança', false) RETURNING id",
      [userId],
    );
    const savingsWalletId = savingsWallet.rows[0]!.id;
    const category = await database.query<{ id: string }>(
      "INSERT INTO categories (user_id, wallet_id, name, nature) VALUES ($1, $2, 'Salário', 'income') RETURNING id",
      [userId, checkingWalletId],
    );
    const incomeCategoryId = category.rows[0]!.id;

    const authRepository = new PostgresAuthRepository(database);
    const sessionToken = createOpaqueToken();
    await authRepository.createSession(userId, hashToken(sessionToken), new Date(Date.now() + 120_000));
    app = createApp(database);
    await app.ready();
    const headersFor = (walletId: string) => ({ cookie: `cashin_session=${sessionToken}`, "x-wallet-id": walletId });

    const upload = (walletId: string, content: Buffer, fileName: string) => app!.inject({
      method: "POST",
      url: "/financial-imports",
      headers: { ...headersFor(walletId), "content-type": "application/octet-stream", "x-file-name": fileName, "x-file-format": "ofx" },
      payload: content,
    });
    const patchItem = (walletId: string, importId: string, itemId: string, payload: Record<string, unknown>) => app!.inject({
      method: "PATCH", url: `/financial-imports/${importId}/items/${itemId}`, headers: headersFor(walletId), payload,
    });
    const confirm = (walletId: string, importId: string) => app!.inject({
      method: "POST", url: `/financial-imports/${importId}/confirm`, headers: headersFor(walletId),
    });
    const undo = (walletId: string, importId: string) => app!.inject({
      method: "POST", url: `/financial-imports/${importId}/undo`, headers: headersFor(walletId),
    });
    const uploadCsv = (walletId: string, content: string, fileName: string) => app!.inject({
      method: "POST",
      url: "/financial-imports",
      headers: {
        ...headersFor(walletId),
        "content-type": "application/octet-stream",
        "x-file-name": fileName,
        "x-file-format": "csv",
        "x-csv-mapping": encodeURIComponent(JSON.stringify(csvConfiguration)),
      },
      payload: Buffer.from(content, "utf8"),
    });
    const summary = async (walletId: string) => (await app!.inject({
      method: "GET", url: "/financial-summary?from=2026-10-01&to=2026-10-31", headers: headersFor(walletId),
    })).json() as {
      incomeTotal: string; expenseTotal: string; cashBalance: string;
      transferOutTotal: string; transferInTotal: string;
    };
    // Counted by amount, so the later scenarios' transfers do not disturb the assertions about this one.
    const transferCount = async (amount: string) => (await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM wallet_transfers WHERE amount = $1::numeric",
      [amount],
    )).rows[0]!.count;

    // The outgoing side: a debit that is not a card payment is offered as a transfer between wallets.
    const outgoing = (await upload(checkingWalletId, bankOfx([
      { id: "t-out", date: "2026-10-05", amount: "-500.00", name: "TRANSFERENCIA PARA POUPANCA", type: "XFER" },
    ]), "saida.ofx")).json() as FinancialImportSession;
    const outgoingItem = outgoing.items![0]!;
    assert.deepEqual(
      [outgoingItem.type, outgoingItem.validationStatus, outgoingItem.transferCounterpartWalletId, outgoingItem.walletTransferId],
      ["transfer", "uncategorized", null, null],
    );
    assert.match(outgoingItem.errorMessage ?? "", /Escolha a carteira do outro lado/);

    // The wallets offered are the ones this user can reach, never another user's.
    const reloaded = (await app.inject({
      method: "GET", url: `/financial-imports/${outgoing.id}`, headers: headersFor(checkingWalletId),
    })).json() as FinancialImportSession;
    const offeredWallets = reloaded.items![0]!.transferCounterpartWallets!;
    assert.deepEqual(offeredWallets.map((wallet) => wallet.walletId), [savingsWalletId]);
    assert.deepEqual(reloaded.items![0]!.transferCandidates, []);

    // Confirming without the other end is refused, and so is a wallet the user cannot reach.
    assert.equal((await confirm(checkingWalletId, outgoing.id)).statusCode, 409);
    assert.equal((await patchItem(checkingWalletId, outgoing.id, outgoingItem.id, {
      date: outgoingItem.date, description: "TRANSFERENCIA PARA POUPANCA", type: "transfer", categoryId: null, subcategoryId: null,
      transferCounterpartWalletId: outsiderWalletId,
    })).statusCode, 404);
    // The wallet of the line itself is never the other end.
    assert.equal((await patchItem(checkingWalletId, outgoing.id, outgoingItem.id, {
      date: outgoingItem.date, description: "TRANSFERENCIA PARA POUPANCA", type: "transfer", categoryId: null, subcategoryId: null,
      transferCounterpartWalletId: checkingWalletId,
    })).statusCode, 400);
    // A transfer settles a statement or mirrors a wallet, never both.
    assert.equal((await patchItem(checkingWalletId, outgoing.id, outgoingItem.id, {
      date: outgoingItem.date, description: "TRANSFERENCIA PARA POUPANCA", type: "transfer", categoryId: null, subcategoryId: null,
      transferCounterpartWalletId: savingsWalletId, creditCardStatementId: savingsWalletId,
    })).statusCode, 400);
    // Only a transfer can be paired with another wallet.
    assert.equal((await patchItem(checkingWalletId, outgoing.id, outgoingItem.id, {
      date: outgoingItem.date, description: "TRANSFERENCIA PARA POUPANCA", type: "expense", categoryId: null, subcategoryId: null,
      transferCounterpartWalletId: savingsWalletId,
    })).statusCode, 400);

    const paired = await patchItem(checkingWalletId, outgoing.id, outgoingItem.id, {
      date: outgoingItem.date, description: "TRANSFERENCIA PARA POUPANCA", type: "transfer", categoryId: null, subcategoryId: null,
      transferCounterpartWalletId: savingsWalletId,
    });
    assert.equal(paired.statusCode, 200);
    assert.deepEqual(
      [paired.json().validationStatus, paired.json().transferCounterpartWalletId, paired.json().errorMessage],
      ["valid", savingsWalletId, null],
    );
    assert.equal((await confirm(checkingWalletId, outgoing.id)).statusCode, 200);
    assert.equal(await transferCount("500.00"), "1");

    // The money left the checking wallet and arrived in the savings wallet, and neither total moved.
    const checkingAfterTransfer = await summary(checkingWalletId);
    assert.deepEqual(
      [checkingAfterTransfer.incomeTotal, checkingAfterTransfer.expenseTotal, checkingAfterTransfer.transferOutTotal, checkingAfterTransfer.cashBalance],
      ["0.00", "0.00", "500.00", "-500.00"],
    );
    const savingsAfterTransfer = await summary(savingsWalletId);
    assert.deepEqual(
      [savingsAfterTransfer.incomeTotal, savingsAfterTransfer.expenseTotal, savingsAfterTransfer.transferInTotal, savingsAfterTransfer.cashBalance],
      ["0.00", "0.00", "500.00", "500.00"],
    );
    // No movement was created on either side: a transfer is not income nor expense.
    const movements = await database.query<{ incomes: number; expenses: number }>(
      `SELECT (SELECT count(*)::integer FROM incomes) AS incomes,
              (SELECT count(*)::integer FROM expenses) AS expenses`,
    );
    assert.deepEqual(movements.rows[0], { incomes: 0, expenses: 0 });

    // The other side arrives later: the pending transfer is the single candidate, so it is suggested
    // instead of creating a second transfer for the same money.
    const incoming = (await upload(savingsWalletId, bankOfx([
      { id: "t-in", date: "2026-10-05", amount: "500.00", name: "TRANSFERENCIA RECEBIDA" },
    ]), "entrada.ofx")).json() as FinancialImportSession;
    const incomingItem = incoming.items![0]!;
    assert.deepEqual(
      [incomingItem.type, incomingItem.validationStatus, incomingItem.transferCounterpartWalletId],
      ["transfer", "valid", checkingWalletId],
    );
    assert.ok(incomingItem.walletTransferId);
    assert.equal((await confirm(savingsWalletId, incoming.id)).statusCode, 200);
    // Still one transfer, and the cash balances did not move again.
    assert.equal(await transferCount("500.00"), "1");
    assert.equal((await summary(savingsWalletId)).cashBalance, "500.00");
    assert.equal((await summary(checkingWalletId)).cashBalance, "-500.00");

    // A second line of the same wallet cannot claim a side that is already reconciled.
    const repeated = (await upload(savingsWalletId, bankOfx([
      { id: "t-in-again", date: "2026-10-05", amount: "500.00", name: "OUTRA TRANSFERENCIA RECEBIDA" },
    ]), "entrada-2.ofx")).json() as FinancialImportSession;
    // With the side already reconciled there is no pending transfer left to mirror, so the credit
    // stays the income the parser read.
    assert.equal(repeated.items![0]!.type, "income");
    assert.equal((await patchItem(savingsWalletId, repeated.id, repeated.items![0]!.id, {
      date: repeated.items![0]!.date, description: "OUTRA TRANSFERENCIA RECEBIDA", type: "transfer", categoryId: null, subcategoryId: null,
      transferCounterpartWalletId: checkingWalletId, walletTransferId: incomingItem.walletTransferId,
    })).statusCode, 409);

    // A category of another wallet is never accepted, transfer or not.
    const foreignCategory = await patchItem(savingsWalletId, repeated.id, repeated.items![0]!.id, {
      date: repeated.items![0]!.date, description: "OUTRA TRANSFERENCIA RECEBIDA", type: "income",
      categoryId: incomeCategoryId, subcategoryId: null,
    });
    assert.equal(foreignCategory.statusCode, 409);

    // Reimporting the line already imported as a transfer must be recognized, or the money would be
    // counted twice for one real movement. A CSV carries no external id, so the comparison depends
    // only on the identity of the line — and the type is part of that identity, which changed when the
    // line was reconciled.
    const reimported = (await uploadCsv(
      checkingWalletId,
      "Data;Descrição;Valor\n05/10/2026;TRANSFERENCIA PARA POUPANCA;-500,00\n",
      "reimportado.csv",
    )).json() as FinancialImportSession;
    assert.deepEqual(
      [reimported.items![0]!.validationStatus, reimported.items![0]!.canIncludeDuplicate],
      ["duplicate", true],
    );

    // Undoing the side that arrived later keeps the transfer: the money did move, and only this
    // wallet's line stops being reconciled, which puts the side back on offer.
    assert.equal((await undo(savingsWalletId, incoming.id)).statusCode, 200);
    assert.equal(await transferCount("500.00"), "1");
    assert.equal((await summary(savingsWalletId)).cashBalance, "500.00");
    const pendingAgain = (await upload(savingsWalletId, bankOfx([
      { id: "t-in-third", date: "2026-10-06", amount: "500.00", name: "TRANSFERENCIA RECEBIDA DE NOVO" },
    ]), "entrada-3.ofx")).json() as FinancialImportSession;
    assert.equal(pendingAgain.items![0]!.validationStatus, "valid");
    assert.equal(pendingAgain.items![0]!.transferCounterpartWalletId, checkingWalletId);

    // Undoing the side that created the transfer removes it, because no other side holds it.
    assert.equal((await undo(checkingWalletId, outgoing.id)).statusCode, 200);
    assert.equal(await transferCount("500.00"), "0");
    assert.equal((await summary(checkingWalletId)).cashBalance, "0.00");
    assert.equal((await summary(savingsWalletId)).cashBalance, "0.00");

    // Two pending transfers of the same amount and date are ambiguous: nothing is reconciled on its
    // own, and both candidates are offered for the user to choose.
    const ambiguousCard = await database.query<{ id: string }>(
      "INSERT INTO wallets (owner_user_id, name, is_personal) VALUES ($1, 'Reserva', false) RETURNING id",
      [userId],
    );
    for (const target of [savingsWalletId, ambiguousCard.rows[0]!.id]) {
      await database.query(
        `INSERT INTO wallet_transfers (from_wallet_id, to_wallet_id, user_id, amount, date, description)
         VALUES ($1, $2, $3, 310.00, '2026-10-09', 'APORTE')`,
        [checkingWalletId, target, userId],
      );
    }
    const ambiguous = (await upload(checkingWalletId, bankOfx([
      { id: "t-ambiguous", date: "2026-10-09", amount: "-310.00", name: "APORTE", type: "XFER" },
    ]), "ambigua.ofx")).json() as FinancialImportSession;
    const ambiguousItem = ambiguous.items![0]!;
    assert.deepEqual(
      [ambiguousItem.type, ambiguousItem.validationStatus, ambiguousItem.transferCounterpartWalletId],
      ["transfer", "uncategorized", null],
    );
    assert.match(ambiguousItem.errorMessage ?? "", /Escolha a transferência que esta movimentação completa/);
    const ambiguousReloaded = (await app.inject({
      method: "GET", url: `/financial-imports/${ambiguous.id}`, headers: headersFor(checkingWalletId),
    })).json() as FinancialImportSession;
    assert.equal(ambiguousReloaded.items![0]!.transferCandidates!.length, 2);
    // Confirming is blocked until the user picks one of them.
    assert.equal((await confirm(checkingWalletId, ambiguous.id)).statusCode, 409);

    // Two lines of the same file never claim the same pending transfer: the second waits for the user
    // instead of being confirmed into a conflict it did not cause.
    const disputed = (await upload(checkingWalletId, bankOfx([
      { id: "t-disputed-1", date: "2026-10-12", amount: "-77.00", name: "TRANSFERENCIA", type: "XFER" },
      { id: "t-disputed-2", date: "2026-10-12", amount: "-77.00", name: "OUTRA TRANSFERENCIA", type: "XFER" },
    ]), "disputada.ofx")).json() as FinancialImportSession;
    await database.query(
      `INSERT INTO wallet_transfers (from_wallet_id, to_wallet_id, user_id, amount, date, description)
       VALUES ($1, $2, $3, 77.00, '2026-10-12', 'DISPUTADA')`,
      [checkingWalletId, savingsWalletId, userId],
    );
    const disputedAgain = (await upload(checkingWalletId, bankOfx([
      { id: "t-disputed-3", date: "2026-10-13", amount: "-77.00", name: "TRANSFERENCIA", type: "XFER" },
      { id: "t-disputed-4", date: "2026-10-13", amount: "-77.00", name: "OUTRA TRANSFERENCIA", type: "XFER" },
    ]), "disputada-2.ofx")).json() as FinancialImportSession;
    assert.deepEqual(
      disputedAgain.items!.map((item) => item.validationStatus),
      ["valid", "uncategorized"],
    );
    assert.equal(disputed.items!.length, 2);
  } finally {
    await app?.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});


// Access to a shared wallet can be revoked after a transfer exists — the owner removes the member.
// The transfer stays, because the money did move; what stops being readable is the wallet's name.
test("PostgreSQL transfer candidates hide the other wallet's name once access to it is revoked", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `transfer_access_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);

    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now())
       RETURNING id, email`,
      [`owner-${schemaName}@example.com`, `member-${schemaName}@example.com`],
    );
    const ownerId = users.rows.find((row) => row.email.startsWith("owner-"))!.id;
    const memberId = users.rows.find((row) => row.email.startsWith("member-"))!.id;
    const personal = await database.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = $1 AND is_personal",
      [memberId],
    );
    const checkingWalletId = personal.rows[0]!.id;
    // The shared wallet belongs to someone else, and the member can be removed from it — the owner's
    // own membership is protected by a trigger, which is why the scenario needs two users.
    const shared = await database.query<{ id: string }>(
      "INSERT INTO wallets (owner_user_id, name, is_personal) VALUES ($1, 'Conta Conjunta', false) RETURNING id",
      [ownerId],
    );
    const sharedWalletId = shared.rows[0]!.id;
    await database.query(
      "INSERT INTO wallet_members (wallet_id, user_id, role) VALUES ($1, $2, 'member')",
      [sharedWalletId, memberId],
    );

    await database.query(
      `INSERT INTO wallet_transfers (from_wallet_id, to_wallet_id, user_id, amount, date, description)
       VALUES ($1, $2, $3, 410.00, '2026-10-09', 'TRANSFERENCIA ENTRE CONTAS')`,
      [checkingWalletId, sharedWalletId, memberId],
    );

    const authRepository = new PostgresAuthRepository(database);
    const sessionToken = createOpaqueToken();
    await authRepository.createSession(memberId, hashToken(sessionToken), new Date(Date.now() + 120_000));
    app = createApp(database);
    await app.ready();
    const headers = { cookie: `cashin_session=${sessionToken}`, "x-wallet-id": checkingWalletId };
    const uploadSide = (fileName: string, id: string) => app!.inject({
      method: "POST",
      url: "/financial-imports",
      headers: { ...headers, "content-type": "application/octet-stream", "x-file-name": fileName, "x-file-format": "ofx" },
      payload: bankOfx([{ id, date: "2026-10-09", amount: "-410.00", name: "TRANSFERENCIA", type: "XFER" }]),
    });

    // While the membership exists, the candidate carries the wallet's name.
    const withAccess = (await uploadSide("com-acesso.ofx", "t-access-1")).json() as FinancialImportSession;
    const namedCandidate = withAccess.items![0]!.transferCandidates![0]!;
    assert.equal(namedCandidate.counterpartWalletName, "Conta Conjunta");
    assert.equal(namedCandidate.counterpartWalletId, sharedWalletId);
    await app.inject({ method: "DELETE", url: `/financial-imports/${withAccess.id}`, headers });

    // The membership is revoked after the transfer already exists.
    await database.query(
      "DELETE FROM wallet_members WHERE wallet_id = $1 AND user_id = $2",
      [sharedWalletId, memberId],
    );

    const withoutAccess = (await uploadSide("sem-acesso.ofx", "t-access-2")).json() as FinancialImportSession;
    const item = withoutAccess.items![0]!;
    const candidate = item.transferCandidates![0]!;
    // The name is gone, the candidate is not: the transfer has this wallet on one end.
    assert.equal(candidate.counterpartWalletName, null);
    assert.equal(candidate.counterpartWalletId, sharedWalletId);
    assert.equal(candidate.amount, "410.00");
    // The wallet is also no longer offered as a destination to choose from scratch.
    assert.deepEqual(item.transferCounterpartWallets, []);

    // Reconciling the pending side still works, which is the point of keeping the candidate.
    const reconciled = await app.inject({
      method: "PATCH",
      url: `/financial-imports/${withoutAccess.id}/items/${item.id}`,
      headers,
      payload: { date: item.date, description: item.description, type: "transfer", walletTransferId: candidate.walletTransferId },
    });
    assert.equal(reconciled.statusCode, 200, reconciled.body);
    const confirmed = await app.inject({ method: "POST", url: `/financial-imports/${withoutAccess.id}/confirm`, headers });
    assert.equal(confirmed.statusCode, 200, confirmed.body);
    assert.equal((confirmed.json() as FinancialImportSession).summary.imported, 1);
  } finally {
    if (app) await app.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
