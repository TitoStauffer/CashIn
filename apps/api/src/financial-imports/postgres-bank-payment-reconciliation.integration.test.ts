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

// Bank statement with outgoing card payments; the amounts are negative, like any debit.
function bankOfx(transactions: Array<{ id: string; date: string; amount: string; name: string }>): Buffer {
  const body = transactions.map((transaction) => [
    "<STMTTRN>",
    `<TRNTYPE>${transaction.amount.startsWith("-") ? "DEBIT" : "CREDIT"}`,
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

test("PostgreSQL bank payment reconciliation settles statements without double counting the purchases", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `bank_payment_${randomBytes(8).toString("hex")}`;
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
      [`payer-${schemaName}@example.com`, `outsider-${schemaName}@example.com`],
    );
    const userId = users.rows.find((row) => row.email.startsWith("payer-"))!.id;
    const outsiderId = users.rows.find((row) => row.email.startsWith("outsider-"))!.id;
    const wallets = await database.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = ANY($1::uuid[])",
      [[userId, outsiderId]],
    );
    const walletId = wallets.rows.find((row) => row.owner_user_id === userId)!.id;
    const outsiderWalletId = wallets.rows.find((row) => row.owner_user_id === outsiderId)!.id;
    const category = await database.query<{ id: string }>(
      "INSERT INTO categories (user_id, wallet_id, name, nature) VALUES ($1, $2, 'Compras', 'expense') RETURNING id",
      [userId, walletId],
    );
    const categoryId = category.rows[0]!.id;
    const creditMethod = await database.query<{ id: string }>(
      "SELECT id FROM payment_methods WHERE wallet_id = $1 AND nature = 'credit_card' AND is_active ORDER BY created_at LIMIT 1",
      [walletId],
    );
    const paymentMethodId = creditMethod.rows[0]!.id;
    const cards = await database.query<{ id: string; alias: string }>(
      `INSERT INTO credit_cards (wallet_id, alias, closing_day, due_day)
       VALUES ($1, 'Principal', 10, 20), ($1, 'Secundário', 10, 20), ($2, 'De outra carteira', 10, 20)
       RETURNING id, alias`,
      [walletId, outsiderWalletId],
    );
    const cardId = cards.rows.find((row) => row.alias === "Principal")!.id;
    const otherCardId = cards.rows.find((row) => row.alias === "Secundário")!.id;
    const outsiderCardId = cards.rows.find((row) => row.alias === "De outra carteira")!.id;

    // Three statements due on the same day: two of this wallet (so a payment matching both amounts
    // is ambiguous) and one of another wallet.
    const statements = await database.query<{ id: string; credit_card_id: string }>(
      `INSERT INTO credit_card_statements (wallet_id, credit_card_id, closing_date, due_date)
       VALUES ($1, $2, '2026-10-10', '2026-10-20'), ($1, $3, '2026-10-10', '2026-10-20'), ($4, $5, '2026-10-10', '2026-10-20')
       RETURNING id, credit_card_id`,
      [walletId, cardId, otherCardId, outsiderWalletId, outsiderCardId],
    );
    const statementId = (card: string) => statements.rows.find((row) => row.credit_card_id === card)!.id;
    const addPurchase = (wallet: string, statement: string, amount: string, method: string, description: string) => database.query(
      `INSERT INTO expenses (user_id, wallet_id, category_id, payment_method_id, payment_method_nature, credit_card_statement_id, amount, date, description)
       VALUES ($1, $2, $3, $4, 'credit_card', $5, $6::numeric, '2026-10-05', $7)`,
      [wallet === walletId ? userId : outsiderId, wallet, wallet === walletId ? categoryId : null, method, statement, amount, description],
    );
    await addPurchase(walletId, statementId(cardId), "400.00", paymentMethodId, "MERCADO");
    await addPurchase(walletId, statementId(otherCardId), "400.00", paymentMethodId, "LIVRARIA");

    const authRepository = new PostgresAuthRepository(database);
    const sessionToken = createOpaqueToken();
    await authRepository.createSession(userId, hashToken(sessionToken), new Date(Date.now() + 120_000));
    app = createApp(database);
    await app.ready();
    const headers = { cookie: `cashin_session=${sessionToken}`, "x-wallet-id": walletId };

    const upload = (content: Buffer, fileName = "extrato.ofx") => app!.inject({
      method: "POST",
      url: "/financial-imports",
      headers: { ...headers, "content-type": "application/octet-stream", "x-file-name": fileName, "x-file-format": "ofx" },
      payload: content,
    });
    const patchItem = (importId: string, itemId: string, payload: Record<string, unknown>) => app!.inject({
      method: "PATCH", url: `/financial-imports/${importId}/items/${itemId}`, headers, payload,
    });
    const statementOf = async (creditCardId: string) => {
      const response = await app!.inject({ method: "GET", url: `/credit-cards/${creditCardId}/statements`, headers });
      return (response.json() as { items: Array<{ id: string; totalAmount: string; paymentsAmount: string; outstandingAmount: string; paidDate: string | null; paidAmount: string | null; payments: Array<{ amount: string; source: string }> }> }).items[0]!;
    };
    const summary = async (from: string, to: string) => (await app!.inject({
      method: "GET", url: `/financial-summary?from=${from}&to=${to}`, headers,
    })).json() as { expenseTotal: string; creditPurchaseTotal: string; cardPaymentTotal: string; cashBalance: string };

    // Two candidates share the amount, so nothing is reconciled automatically.
    const ambiguous = (await upload(bankOfx([
      { id: "p-ambiguous", date: "2026-10-20", amount: "-400.00", name: "PAGAMENTO CARTAO" },
    ]))).json() as FinancialImportSession;
    const ambiguousItem = ambiguous.items![0]!;
    assert.equal(ambiguousItem.type, "transfer");
    assert.equal(ambiguousItem.validationStatus, "uncategorized");
    assert.equal(ambiguousItem.creditCardStatementId, null);
    assert.match(ambiguousItem.errorMessage ?? "", /Selecione a fatura/);
    const reloaded = (await app.inject({ method: "GET", url: `/financial-imports/${ambiguous.id}`, headers })).json() as FinancialImportSession;
    const candidates = reloaded.items![0]!.statementCandidates!;
    assert.deepEqual(
      candidates.map((candidate) => [candidate.creditCardName, candidate.outstandingAmount]).sort(),
      [["Principal", "400.00"], ["Secundário", "400.00"]],
    );
    // Another wallet's statement is never a candidate.
    assert.equal(candidates.some((candidate) => candidate.creditCardId === outsiderCardId), false);
    // Confirming without reconciling is refused.
    assert.equal((await app.inject({ method: "POST", url: `/financial-imports/${ambiguous.id}/confirm`, headers })).statusCode, 409);
    // A statement of another wallet cannot be chosen.
    assert.equal((await patchItem(ambiguous.id, ambiguousItem.id, {
      date: ambiguousItem.date, description: "PAGAMENTO CARTAO", type: "transfer", categoryId: null, subcategoryId: null,
      creditCardStatementId: statementId(outsiderCardId),
    })).statusCode, 404);
    // Only a payment may be reconciled.
    assert.equal((await patchItem(ambiguous.id, ambiguousItem.id, {
      date: ambiguousItem.date, description: "PAGAMENTO CARTAO", type: "expense", categoryId, subcategoryId: null,
      creditCardStatementId: statementId(cardId),
    })).statusCode, 400);

    const reconciled = await patchItem(ambiguous.id, ambiguousItem.id, {
      date: ambiguousItem.date, description: "PAGAMENTO CARTAO", type: "transfer", categoryId: null, subcategoryId: null,
      creditCardStatementId: statementId(cardId),
    });
    assert.equal(reconciled.statusCode, 200);
    assert.equal(reconciled.json().validationStatus, "valid");
    assert.equal(reconciled.json().creditCardStatementId, statementId(cardId));
    assert.equal((await app.inject({ method: "POST", url: `/financial-imports/${ambiguous.id}/confirm`, headers })).statusCode, 200);

    // The payment settles the statement; the purchase is not posted again.
    const settled = await statementOf(cardId);
    assert.deepEqual([settled.totalAmount, settled.paymentsAmount, settled.outstandingAmount], ["400.00", "400.00", "0.00"]);
    assert.deepEqual([settled.paidDate, settled.paidAmount], ["2026-10-20", "400.00"]);
    assert.deepEqual(settled.payments.map((payment) => [payment.amount, payment.source]), [["400.00", "bank_statement"]]);
    const october = await summary("2026-10-01", "2026-10-31");
    assert.equal(october.creditPurchaseTotal, "800.00");
    assert.equal(october.cardPaymentTotal, "400.00");
    // The payment leaves the cash balance once: purchases are not cash, the payment is.
    assert.equal(october.cashBalance, "-400.00");
    const movements = await database.query<{ expenses: number; incomes: number }>(
      `SELECT (SELECT count(*)::integer FROM expenses WHERE wallet_id = $1) AS expenses,
              (SELECT count(*)::integer FROM incomes WHERE wallet_id = $1) AS incomes`,
      [walletId],
    );
    assert.deepEqual(movements.rows[0], { expenses: 2, incomes: 0 });

    // A partial payment reduces the statement without settling it, so it keeps accepting purchases.
    const partial = (await upload(bankOfx([
      { id: "p-partial", date: "2026-10-19", amount: "-150.00", name: "PGTO FATURA CARTAO" },
    ]), "parcial.ofx")).json() as FinancialImportSession;
    const partialItem = partial.items![0]!;
    // The description points at a card payment, but 150,00 matches no outstanding balance exactly,
    // so the statement is left for the user.
    assert.equal(partialItem.type, "transfer");
    assert.equal(partialItem.creditCardStatementId, null);
    assert.match(partialItem.errorMessage ?? "", /Selecione a fatura/);
    await patchItem(partial.id, partialItem.id, {
      date: partialItem.date, description: "PGTO FATURA CARTAO", type: "transfer", categoryId: null, subcategoryId: null,
      creditCardStatementId: statementId(otherCardId),
    });
    assert.equal((await app.inject({ method: "POST", url: `/financial-imports/${partial.id}/confirm`, headers })).statusCode, 200);
    const partiallyPaid = await statementOf(otherCardId);
    assert.deepEqual([partiallyPaid.paymentsAmount, partiallyPaid.outstandingAmount, partiallyPaid.paidDate], ["150.00", "250.00", null]);
    assert.equal(partiallyPaid.paidAmount, null);
    // The partial payment still left the cash balance.
    assert.equal((await summary("2026-10-01", "2026-10-31")).cardPaymentTotal, "550.00");
    // A purchase may still be added to a statement that is only partially paid.
    await addPurchase(walletId, statementId(otherCardId), "10.00", paymentMethodId, "CAFE");
    assert.equal((await statementOf(otherCardId)).outstandingAmount, "260.00");

    // A statement with no outstanding balance cannot be reconciled again.
    const late = (await upload(bankOfx([
      { id: "p-late", date: "2026-10-21", amount: "-30.00", name: "PGTO CARTAO ATRASADO" },
    ]), "atrasado.ofx")).json() as FinancialImportSession;
    assert.equal((await patchItem(late.id, late.items![0]!.id, {
      date: late.items![0]!.date, description: "PGTO CARTAO ATRASADO", type: "transfer", categoryId: null, subcategoryId: null,
      creditCardStatementId: statementId(cardId),
    })).statusCode, 409);

    // Undoing the partial import removes its payment and leaves the statement as it was.
    const undone = await app.inject({ method: "POST", url: `/financial-imports/${partial.id}/undo`, headers });
    assert.equal(undone.statusCode, 200);
    assert.equal(undone.json().status, "undone");
    const reopened = await statementOf(otherCardId);
    assert.deepEqual([reopened.paymentsAmount, reopened.outstandingAmount, reopened.paidDate], ["0.00", "410.00", null]);
    assert.equal((await summary("2026-10-01", "2026-10-31")).cardPaymentTotal, "400.00");

    // Undoing a settlement reopens the statement it had settled.
    const undoneSettlement = await app.inject({ method: "POST", url: `/financial-imports/${ambiguous.id}/undo`, headers });
    assert.equal(undoneSettlement.statusCode, 200);
    const reopenedSettlement = await statementOf(cardId);
    assert.deepEqual([reopenedSettlement.paidDate, reopenedSettlement.paymentsAmount, reopenedSettlement.outstandingAmount], [null, "0.00", "400.00"]);
    assert.equal((await summary("2026-10-01", "2026-10-31")).cardPaymentTotal, "0.00");
  } finally {
    await app?.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
