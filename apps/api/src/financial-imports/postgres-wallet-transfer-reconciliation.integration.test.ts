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
    const summary = async (walletId: string) => (await app!.inject({
      method: "GET", url: "/financial-summary?from=2026-10-01&to=2026-10-31", headers: headersFor(walletId),
    })).json() as {
      incomeTotal: string; expenseTotal: string; cashBalance: string;
      transferOutTotal: string; transferInTotal: string;
    };
    const transferCount = async () => (await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM wallet_transfers",
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
    assert.equal(await transferCount(), "1");

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
    assert.equal(await transferCount(), "1");
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

    // Undoing the side that arrived later keeps the transfer: the money did move, and only this
    // wallet's line stops being reconciled, which puts the side back on offer.
    assert.equal((await undo(savingsWalletId, incoming.id)).statusCode, 200);
    assert.equal(await transferCount(), "1");
    assert.equal((await summary(savingsWalletId)).cashBalance, "500.00");
    const pendingAgain = (await upload(savingsWalletId, bankOfx([
      { id: "t-in-third", date: "2026-10-06", amount: "500.00", name: "TRANSFERENCIA RECEBIDA DE NOVO" },
    ]), "entrada-3.ofx")).json() as FinancialImportSession;
    assert.equal(pendingAgain.items![0]!.validationStatus, "valid");
    assert.equal(pendingAgain.items![0]!.transferCounterpartWalletId, checkingWalletId);

    // Undoing the side that created the transfer removes it, because no other side holds it.
    assert.equal((await undo(checkingWalletId, outgoing.id)).statusCode, 200);
    assert.equal(await transferCount(), "0");
    assert.equal((await summary(checkingWalletId)).cashBalance, "0.00");
    assert.equal((await summary(savingsWalletId)).cashBalance, "0.00");
  } finally {
    await app?.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
