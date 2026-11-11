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

function cardOfx(transactions: Array<{ id: string; date: string; amount: string; name: string; type?: string }>): Buffer {
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
    "<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>",
    "<CURDEF>BRL",
    "<CCACCTFROM><ACCTID>5555-0001</CCACCTFROM>",
    "<BANKTRANLIST>",
    body,
    "</BANKTRANLIST>",
    "</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>",
  ].join("\n"), "utf8");
}

const csvConfiguration = {
  delimiter: ";" as const,
  encoding: "utf-8" as const,
  hasHeader: true,
  dateFormat: "dd/MM/yyyy" as const,
  numberFormat: "pt-BR" as const,
  columns: { date: 0, description: 1, amount: 2, credit: null, debit: null, externalId: null },
};

test("PostgreSQL credit card statement import posts purchases and credits to the right statements", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `card_import_${randomBytes(8).toString("hex")}`;
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
    const cards = await database.query<{ id: string; alias: string }>(
      `INSERT INTO credit_cards (wallet_id, alias, closing_day, due_day)
       VALUES ($1, 'Principal', 10, 20), ($1, 'Fim do mês', 31, 8), ($2, 'De outra carteira', 10, 20)
       RETURNING id, alias`,
      [walletId, outsiderWalletId],
    );
    const cardId = cards.rows.find((row) => row.alias === "Principal")!.id;
    const monthEndCardId = cards.rows.find((row) => row.alias === "Fim do mês")!.id;
    const outsiderCardId = cards.rows.find((row) => row.alias === "De outra carteira")!.id;

    const authRepository = new PostgresAuthRepository(database);
    const ownerToken = createOpaqueToken();
    const outsiderToken = createOpaqueToken();
    await authRepository.createSession(userId, hashToken(ownerToken), new Date(Date.now() + 120_000));
    await authRepository.createSession(outsiderId, hashToken(outsiderToken), new Date(Date.now() + 120_000));
    app = createApp(database);
    await app.ready();
    const ownerHeaders = { cookie: `cashin_session=${ownerToken}`, "x-wallet-id": walletId };
    const outsiderHeaders = { cookie: `cashin_session=${outsiderToken}`, "x-wallet-id": outsiderWalletId };

    const upload = (content: Buffer, headers: Record<string, string>) => app!.inject({
      method: "POST",
      url: "/financial-imports",
      headers: { ...ownerHeaders, "content-type": "application/octet-stream", ...headers },
      payload: content,
    });
    const patchItem = (importId: string, itemId: string, payload: Record<string, unknown>) => app!.inject({
      method: "PATCH",
      url: `/financial-imports/${importId}/items/${itemId}`,
      headers: ownerHeaders,
      payload,
    });
    const statementsOf = async (creditCardId: string) => {
      const response = await app!.inject({ method: "GET", url: `/credit-cards/${creditCardId}/statements`, headers: ownerHeaders });
      assert.equal(response.statusCode, 200);
      return (response.json() as { items: Array<{
        id: string; closingDate: string; dueDate: string; purchasesAmount: string; creditsAmount: string; totalAmount: string;
        paidAmount: string | null; paidDate: string | null; paymentsAmount: string;
        payments: Array<{ amount: string; source: string }>;
        purchases: Array<{ id: string; description: string }>;
        credits: Array<{ amount: string; description: string; originalExpenseId: string | null }>;
      }> }).items;
    };

    const statementOfx = cardOfx([
      { id: "c1", date: "2026-10-10", amount: "-100.10", name: "MERCADO" },
      { id: "c2", date: "2026-10-11", amount: "-50.25", name: "LIVRARIA" },
      { id: "c3", date: "2026-10-12", amount: "20.25", name: "Estorno de LIVRARIA" },
      { id: "c4", date: "2026-10-15", amount: "500.00", name: "Pagamento recebido", type: "PAYMENT" },
      { id: "c5", date: "2026-10-16", amount: "-30.00", name: "CINEMA" },
      { id: "c6", date: "2026-10-17", amount: "30.00", name: "Estorno CINEMA" },
    ]);

    // The card must belong to the selected wallet, and the import kind must match the file.
    assert.equal((await upload(statementOfx, { "x-file-name": "fatura.ofx", "x-file-format": "ofx", "x-credit-card-id": outsiderCardId })).statusCode, 404);
    const bankModeResponse = await upload(statementOfx, { "x-file-name": "fatura.ofx", "x-file-format": "ofx" });
    assert.equal(bankModeResponse.statusCode, 422);
    assert.match(bankModeResponse.json().message, /fatura de cartão/);

    const created = await upload(statementOfx, { "x-file-name": "fatura.ofx", "x-file-format": "ofx", "x-credit-card-id": cardId });
    assert.equal(created.statusCode, 201);
    const preview = created.json() as FinancialImportSession;
    assert.equal(preview.kind, "credit_card_statement");
    assert.equal(preview.creditCardId, cardId);
    assert.equal(preview.creditCardName, "Principal");
    const byDescription = (session: FinancialImportSession, description: string) => session.items!.find((item) => item.description === description)!;
    // Purchase on the closing day belongs to that statement; the next day belongs to the next one.
    assert.deepEqual(
      [byDescription(preview, "MERCADO").statementClosingDate, byDescription(preview, "MERCADO").statementDueDate],
      ["2026-10-10", "2026-10-20"],
    );
    assert.equal(byDescription(preview, "LIVRARIA").statementClosingDate, "2026-11-10");
    assert.equal(byDescription(preview, "LIVRARIA").type, "expense");
    assert.equal(byDescription(preview, "Estorno de LIVRARIA").type, "card_credit");
    assert.equal(byDescription(preview, "Estorno de LIVRARIA").validationStatus, "valid");
    const payment = byDescription(preview, "Pagamento recebido");
    assert.equal(payment.type, "transfer");
    assert.equal(payment.validationStatus, "uncategorized");
    assert.match(payment.errorMessage ?? "", /conciliado com o extrato bancário/);

    for (const description of ["MERCADO", "LIVRARIA", "CINEMA"]) {
      const item = byDescription(preview, description);
      const response = await patchItem(preview.id, item.id, { date: item.date, description, type: "expense", categoryId, subcategoryId: null });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().validationStatus, "valid");
    }
    const cinema = byDescription(preview, "CINEMA");
    assert.equal((await patchItem(preview.id, cinema.id, { date: cinema.date, description: "CINEMA", type: "income", categoryId, subcategoryId: null })).statusCode, 400);
    assert.equal((await patchItem(preview.id, cinema.id, {
      date: cinema.date, description: "CINEMA", type: "expense", categoryId, subcategoryId: null, statementClosingDate: "2027-01-10",
    })).statusCode, 400);
    const moved = await patchItem(preview.id, cinema.id, {
      date: cinema.date, description: "CINEMA", type: "expense", categoryId, subcategoryId: null, statementClosingDate: "2026-12-10",
    });
    assert.equal(moved.json().statementClosingDate, "2026-12-10");
    assert.equal((await patchItem(preview.id, cinema.id, {
      date: cinema.date, description: "CINEMA", type: "expense", categoryId, subcategoryId: null, statementClosingDate: null,
    })).json().statementClosingDate, "2026-11-10");

    const reviewed = (await app.inject({ method: "GET", url: `/financial-imports/${preview.id}`, headers: ownerHeaders })).json() as FinancialImportSession;
    assert.deepEqual(reviewed.statements, [
      { closingDate: "2026-10-10", dueDate: "2026-10-20", purchasesAmount: "100.10", creditsAmount: "0.00", totalAmount: "100.10", isPaid: false },
      { closingDate: "2026-11-10", dueDate: "2026-11-20", purchasesAmount: "80.25", creditsAmount: "50.25", totalAmount: "30.00", isPaid: false },
    ]);
    // Another wallet cannot read this import.
    assert.equal((await app.inject({ method: "GET", url: `/financial-imports/${preview.id}`, headers: outsiderHeaders })).statusCode, 404);

    const confirmed = await app.inject({ method: "POST", url: `/financial-imports/${preview.id}/confirm`, headers: ownerHeaders });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().status, "completed");
    assert.equal(confirmed.json().summary.imported, 5);
    // Unchanged purchases and credits keep the import undoable until a statement is paid.
    assert.equal(confirmed.json().canUndo, true);

    const statements = await statementsOf(cardId);
    const november = statements.find((statement) => statement.closingDate === "2026-11-10")!;
    const october = statements.find((statement) => statement.closingDate === "2026-10-10")!;
    assert.deepEqual([october.purchasesAmount, october.creditsAmount, october.totalAmount], ["100.10", "0.00", "100.10"]);
    assert.deepEqual([november.purchasesAmount, november.creditsAmount, november.totalAmount], ["80.25", "50.25", "30.00"]);
    const livraria = november.purchases.find((purchase) => purchase.description === "LIVRARIA")!;
    const cinemaPurchase = november.purchases.find((purchase) => purchase.description === "CINEMA")!;
    assert.equal(november.credits.find((credit) => credit.description === "Estorno de LIVRARIA")!.originalExpenseId, livraria.id);
    assert.equal(november.credits.find((credit) => credit.description === "Estorno CINEMA")!.originalExpenseId, cinemaPurchase.id);
    // Purchases are credit card expenses, and credits never become cash income.
    const ledger = await database.query<{ incomes: number; card_expenses: number }>(
      `SELECT (SELECT count(*)::integer FROM incomes WHERE wallet_id = $1) AS incomes,
              (SELECT count(*)::integer FROM expenses WHERE wallet_id = $1 AND payment_method_nature = 'credit_card') AS card_expenses`,
      [walletId],
    );
    assert.deepEqual(ledger.rows[0], { incomes: 0, card_expenses: 3 });

    // The same purchases exported as CSV (purchases positive) are detected as duplicates of this card.
    const statementCsv = Buffer.from("Data;Descrição;Valor\n10/10/2026;MERCADO;100,10\n11/10/2026;LIVRARIA;50,25\n12/10/2026;Estorno de LIVRARIA;-20,25\n", "utf8");
    const csvHeaders = {
      "x-file-name": "fatura.csv",
      "x-file-format": "csv",
      "x-csv-mapping": encodeURIComponent(JSON.stringify(csvConfiguration)),
    };
    assert.equal((await upload(statementCsv, { ...csvHeaders, "x-credit-card-id": cardId })).statusCode, 400);
    const csvPreview = (await upload(statementCsv, { ...csvHeaders, "x-credit-card-id": cardId, "x-card-amount-sign": "purchases_positive" })).json() as FinancialImportSession;
    assert.deepEqual(csvPreview.items!.map((item) => [item.type, item.validationStatus]), [
      ["expense", "duplicate"],
      ["expense", "duplicate"],
      ["card_credit", "duplicate"],
    ]);
    // Duplicates are scoped to the card: the same lines on another card are new purchases.
    const otherCardPreview = (await upload(statementCsv, { ...csvHeaders, "x-credit-card-id": monthEndCardId, "x-card-amount-sign": "purchases_positive" })).json() as FinancialImportSession;
    assert.ok(otherCardPreview.items!.every((item) => item.validationStatus !== "duplicate"));

    // Paying uses the net balance; afterwards the import can no longer be undone.
    const paid = await app.inject({
      method: "POST",
      url: `/credit-cards/${cardId}/statements/${november.id}/pay`,
      headers: ownerHeaders,
      payload: { date: "2026-11-20" },
    });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.json().paidAmount, "30.00");
    const history = ((await app.inject({ method: "GET", url: "/financial-imports", headers: ownerHeaders })).json() as { items: FinancialImportSession[] }).items;
    const completed = history.find((session) => session.id === preview.id)!;
    assert.equal(completed.canUndo, false);
    assert.equal(completed.undoBlockedReason, "Uma fatura com lançamentos desta importação já foi paga.");
    assert.equal((await app.inject({ method: "POST", url: `/financial-imports/${preview.id}/undo`, headers: ownerHeaders })).statusCode, 409);

    // A purchase that falls in a paid statement must be moved before it can be imported.
    const late = (await upload(cardOfx([{ id: "late-1", date: "2026-11-05", amount: "-12.00", name: "PADARIA" }]), {
      "x-file-name": "atrasada.ofx", "x-file-format": "ofx", "x-credit-card-id": cardId,
    })).json() as FinancialImportSession;
    const lateItem = late.items![0]!;
    assert.equal(lateItem.validationStatus, "invalid");
    assert.match(lateItem.errorMessage ?? "", /10\/11\/2026 já foi paga/);
    assert.equal(lateItem.canEdit, true);
    const relocated = await patchItem(late.id, lateItem.id, {
      date: lateItem.date, description: "PADARIA", type: "expense", categoryId, subcategoryId: null, statementClosingDate: "2026-12-10",
    });
    assert.equal(relocated.json().validationStatus, "valid");

    // Month-end closing days follow short months, and an unchanged import can be fully undone.
    const monthEnd = (await upload(
      Buffer.from("Data;Descrição;Valor\n28/02/2026;FARMACIA;45,90\n01/03/2026;POSTO;80,00\n", "utf8"),
      { ...csvHeaders, "x-file-name": "fim.csv", "x-credit-card-id": monthEndCardId, "x-card-amount-sign": "purchases_positive" },
    )).json() as FinancialImportSession;
    assert.deepEqual(monthEnd.items!.map((item) => [item.statementClosingDate, item.statementDueDate]), [
      ["2026-02-28", "2026-03-08"],
      ["2026-03-31", "2026-04-08"],
    ]);
    for (const item of monthEnd.items!) {
      await patchItem(monthEnd.id, item.id, { date: item.date, description: item.description, type: "expense", categoryId, subcategoryId: null });
    }
    assert.equal((await app.inject({ method: "POST", url: `/financial-imports/${monthEnd.id}/confirm`, headers: ownerHeaders })).statusCode, 200);
    assert.equal((await statementsOf(monthEndCardId)).length, 2);
    const undone = await app.inject({ method: "POST", url: `/financial-imports/${monthEnd.id}/undo`, headers: ownerHeaders });
    assert.equal(undone.statusCode, 200);
    assert.equal(undone.json().status, "undone");
    assert.equal((await statementsOf(monthEndCardId)).length, 0);

    // A statement whose credits cover its purchases has no amount due and cannot be paid.
    const refunded = (await upload(
      Buffer.from("Data;Descrição;Valor\n10/03/2026;LOJA;45,90\n12/03/2026;Estorno LOJA;-45,90\n", "utf8"),
      { ...csvHeaders, "x-file-name": "estornada.csv", "x-credit-card-id": monthEndCardId, "x-card-amount-sign": "purchases_positive" },
    )).json() as FinancialImportSession;
    const refundedPurchase = refunded.items!.find((item) => item.type === "expense")!;
    await patchItem(refunded.id, refundedPurchase.id, { date: refundedPurchase.date, description: "LOJA", type: "expense", categoryId, subcategoryId: null });
    assert.equal((await app.inject({ method: "POST", url: `/financial-imports/${refunded.id}/confirm`, headers: ownerHeaders })).statusCode, 200);
    const [coveredStatement] = await statementsOf(monthEndCardId);
    assert.deepEqual([coveredStatement!.purchasesAmount, coveredStatement!.creditsAmount, coveredStatement!.totalAmount], ["45.90", "45.90", "0.00"]);
    const unpaid = await app.inject({
      method: "POST",
      url: `/credit-cards/${monthEndCardId}/statements/${coveredStatement!.id}/pay`,
      headers: ownerHeaders,
      payload: { date: "2026-04-08" },
    });
    assert.equal(unpaid.statusCode, 409);
    assert.match(unpaid.json().message, /créditos cobrem as compras/);

    // Deleting the purchase keeps the statement, because it still holds the credit.
    const deleted = await app.inject({ method: "DELETE", url: `/expenses/${coveredStatement!.purchases[0]!.id}`, headers: ownerHeaders });
    assert.equal(deleted.statusCode, 204);
    const [creditOnlyStatement] = await statementsOf(monthEndCardId);
    assert.deepEqual(
      [creditOnlyStatement!.id, creditOnlyStatement!.purchasesAmount, creditOnlyStatement!.creditsAmount, creditOnlyStatement!.credits[0]!.originalExpenseId],
      [coveredStatement!.id, "0.00", "45.90", null],
    );

    // Undoing a card statement import keeps a statement that was partially paid: the payment is money
    // already gone from the account and it lives in the statement, so removing the statement would
    // cascade the payment away and the paid amount would vanish from the card and from the balance.
    const partialCard = (await app.inject({
      method: "POST", url: "/credit-cards", headers: ownerHeaders, payload: { nickname: "Parcial", closingDay: 10, dueDay: 20 },
    })).json() as { id: string };
    const partialImport = (await upload(
      Buffer.from("Data;Descrição;Valor\n05/05/2026;MERCEARIA;200,00\n", "utf8"),
      { ...csvHeaders, "x-file-name": "parcial.csv", "x-credit-card-id": partialCard.id, "x-card-amount-sign": "purchases_positive" },
    )).json() as FinancialImportSession;
    const partialItem = partialImport.items![0]!;
    await patchItem(partialImport.id, partialItem.id, {
      date: partialItem.date, description: "MERCEARIA", type: "expense", categoryId, subcategoryId: null,
    });
    assert.equal((await app.inject({ method: "POST", url: `/financial-imports/${partialImport.id}/confirm`, headers: ownerHeaders })).statusCode, 200);
    const [importedStatement] = await statementsOf(partialCard.id);
    const partiallyPaid = await app.inject({
      method: "POST",
      url: `/credit-cards/${partialCard.id}/statements/${importedStatement!.id}/pay`,
      headers: ownerHeaders,
      payload: { date: "2026-05-20", amount: "50.00" },
    });
    assert.equal(partiallyPaid.statusCode, 200);
    // A partial payment does not settle the statement, so the import is still undoable.
    const undonePartial = await app.inject({ method: "POST", url: `/financial-imports/${partialImport.id}/undo`, headers: ownerHeaders });
    assert.equal(undonePartial.statusCode, 200);
    assert.equal(undonePartial.json().status, "undone");
    const [keptStatement] = await statementsOf(partialCard.id);
    assert.deepEqual(
      [keptStatement!.id, keptStatement!.purchasesAmount, keptStatement!.paymentsAmount, keptStatement!.paidDate],
      [importedStatement!.id, "0.00", "50.00", null],
    );
    assert.deepEqual(keptStatement!.payments.map((payment) => [payment.amount, payment.source]), [["50.00", "manual"]]);

    // A statement import that carries only refunds posts no expense, so it has to confirm even with
    // no active credit payment method in the wallet. This case crosses the confirmation on purpose:
    // the unit cases exercise `prepareCardPosting` and `cardPurchasePosting` in isolation, and the
    // first attempt at this delivery passed all of them while the confirmation still answered 409.
    await database.query("UPDATE payment_methods SET is_active = false WHERE wallet_id = $1 AND nature = 'credit_card'", [walletId]);
    const refundsOnlyCard = (await app.inject({
      method: "POST", url: "/credit-cards", headers: ownerHeaders, payload: { nickname: "Só estornos", closingDay: 10, dueDay: 20 },
    })).json() as { id: string };
    const refundsOnly = (await upload(
      Buffer.from("Data;Descrição;Valor\n06/06/2026;Estorno LIVRARIA;-40,00\n", "utf8"),
      { ...csvHeaders, "x-file-name": "estornos.csv", "x-credit-card-id": refundsOnlyCard.id, "x-card-amount-sign": "purchases_positive" },
    )).json() as FinancialImportSession;
    assert.deepEqual(refundsOnly.items!.map((item) => item.type), ["card_credit"]);

    const confirmedRefundsOnly = await app.inject({
      method: "POST", url: `/financial-imports/${refundsOnly.id}/confirm`, headers: ownerHeaders,
    });

    assert.equal(confirmedRefundsOnly.statusCode, 200);
    assert.equal(confirmedRefundsOnly.json().status, "completed");
    const [refundsOnlyStatement] = await statementsOf(refundsOnlyCard.id);
    assert.deepEqual(
      [refundsOnlyStatement!.purchasesAmount, refundsOnlyStatement!.creditsAmount],
      ["0.00", "40.00"],
    );
  } finally {
    await app?.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});

// DEV-124. The card issuer gives an international purchase and the IOF charged on it the same FITID. Trusting
// the identifier alone, both duplicate checks treated the purchase as a copy of its own tax — inside the file
// and across imports — and the purchase never reached the statement, with no way to import it from the screen.
// The identity is now FITID together with the signed amount.
test("PostgreSQL card import keeps a purchase and its IOF that share a FITID, and still refuses a real reimport", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `card_fitid_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);

    const users = await database.query<{ id: string }>(
      "INSERT INTO users (email, password_hash, email_verified_at) VALUES ($1, 'test-hash', now()) RETURNING id",
      [`owner-${schemaName}@example.com`],
    );
    const userId = users.rows[0]!.id;
    const walletId = (await database.query<{ id: string }>(
      "SELECT id FROM wallets WHERE owner_user_id = $1", [userId],
    )).rows[0]!.id;
    const categoryId = (await database.query<{ id: string }>(
      "INSERT INTO categories (user_id, wallet_id, name, nature) VALUES ($1, $2, 'Assinaturas', 'expense') RETURNING id",
      [userId, walletId],
    )).rows[0]!.id;
    const cardId = (await database.query<{ id: string }>(
      "INSERT INTO credit_cards (wallet_id, alias, closing_day, due_day) VALUES ($1, 'Principal', 10, 20) RETURNING id",
      [walletId],
    )).rows[0]!.id;

    const token = createOpaqueToken();
    await new PostgresAuthRepository(database).createSession(userId, hashToken(token), new Date(Date.now() + 120_000));
    app = createApp(database);
    await app.ready();
    const headers = { cookie: `cashin_session=${token}`, "x-wallet-id": walletId };
    const upload = async (content: Buffer, fileName: string) => {
      const response = await app!.inject({
        method: "POST",
        url: "/financial-imports",
        headers: {
          ...headers, "content-type": "application/octet-stream",
          "x-file-name": fileName, "x-file-format": "ofx", "x-credit-card-id": cardId,
        },
        payload: content,
      });
      assert.equal(response.statusCode, 201);
      return response.json() as FinancialImportSession;
    };
    const byDescription = (session: FinancialImportSession, description: string) => (
      session.items!.find((item) => item.description === description)!
    );
    const patchItem = (importId: string, itemId: string, payload: Record<string, unknown>) => app!.inject({
      method: "PATCH",
      url: `/financial-imports/${importId}/items/${itemId}`,
      headers,
      payload,
    });

    // The pair exactly as the issuer exports it: one identifier, two transactions with different amounts.
    const invoice = cardOfx([
      { id: "shared-fitid", date: "2026-11-07", amount: "-3.62", name: "IOF de compra internacional" },
      { id: "shared-fitid", date: "2026-11-07", amount: "-103.50", name: "Anthropic" },
    ]);

    // 1. Inside the file, neither line is a duplicate of the other, and both reach the confirmation.
    const first = await upload(invoice, "fatura.ofx");
    for (const description of ["IOF de compra internacional", "Anthropic"]) {
      const item = byDescription(first, description);
      assert.notEqual(item.validationStatus, "duplicate", `${description} must not be a duplicate of its pair`);
      const patched = await patchItem(first.id, item.id, { date: item.date, description, type: "expense", categoryId, subcategoryId: null });
      assert.equal(patched.statusCode, 200);
      assert.equal(patched.json().validationStatus, "valid");
    }
    const confirmed = await app.inject({ method: "POST", url: `/financial-imports/${first.id}/confirm`, headers });
    assert.equal(confirmed.statusCode, 200);
    assert.equal(confirmed.json().summary.imported, 2);

    // 2. The protection the rule exists for still holds: the same file again is recognised as already
    // imported, and FITID together with amount is strong enough evidence to refuse the override.
    const reimported = await upload(invoice, "fatura-de-novo.ofx");
    for (const description of ["IOF de compra internacional", "Anthropic"]) {
      const item = byDescription(reimported, description);
      assert.equal(item.validationStatus, "duplicate", `${description} must be recognised on reimport`);
      assert.equal(item.canIncludeDuplicate, false);
      assert.match(item.errorMessage ?? "", /FITID coincide/);
    }

    // 3. The cross-import half of the defect, isolated: a FITID already imported, with a different amount, is
    // a different transaction. Before the fix this line was refused as already imported and could not be
    // included from the screen.
    const later = await upload(cardOfx([
      { id: "shared-fitid", date: "2026-11-08", amount: "-50.00", name: "Outra compra internacional" },
    ]), "outra.ofx");
    const other = byDescription(later, "Outra compra internacional");
    assert.notEqual(other.validationStatus, "duplicate");

    // 4. The way back for invoices already hurt by the defect: the IOF went in, the purchase was dropped as
    // its duplicate. Reimporting the same file after the fix has to bring the purchase and only the purchase.
    const iofOnly = await upload(cardOfx([
      { id: "recovered-fitid", date: "2026-11-06", amount: "-16.85", name: "IOF de compra internacional" },
    ]), "so-iof.ofx");
    const iof = byDescription(iofOnly, "IOF de compra internacional");
    assert.equal((await patchItem(iofOnly.id, iof.id, {
      date: iof.date, description: iof.description, type: "expense", categoryId, subcategoryId: null,
    })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: `/financial-imports/${iofOnly.id}/confirm`, headers })).statusCode, 200);

    const recovery = await upload(cardOfx([
      { id: "recovered-fitid", date: "2026-11-06", amount: "-16.85", name: "IOF de compra internacional" },
      { id: "recovered-fitid", date: "2026-11-06", amount: "-481.48", name: "Anthropic Claude Sub" },
    ]), "fatura-recuperada.ofx");
    assert.equal(byDescription(recovery, "IOF de compra internacional").validationStatus, "duplicate");
    assert.notEqual(byDescription(recovery, "Anthropic Claude Sub").validationStatus, "duplicate");

    // 5. Identifier and amount repeating inside one file stays flagged, but the flag has to survive to the
    // screen as an override: two equal toll charges on one day are real, and a duplicate cannot be repairable
    // by schema, so the override is the only way back. Asserted through the API, not the parser alone.
    const tolls = await upload(cardOfx([
      { id: "toll-fitid", date: "2026-10-05", amount: "-5.80", name: "Transação de NuTag" },
      { id: "toll-fitid", date: "2026-10-05", amount: "-5.80", name: "Transação de NuTag" },
    ]), "pedagio.ofx");
    const [firstToll, secondToll] = tolls.items!;
    assert.notEqual(firstToll!.validationStatus, "duplicate");
    assert.equal(secondToll!.validationStatus, "duplicate");
    assert.equal(secondToll!.canIncludeDuplicate, true);
    assert.match(secondToll!.errorMessage ?? "", /emissor pode ter reaproveitado o identificador/);

    // 6. The override is offered only when consent can finish: a repeated line that is also invalid (here a
    // date that does not exist) cannot be edited on the screen, so "include anyway" would be a dead end.
    const brokenTolls = await upload(cardOfx([
      { id: "broken-toll-fitid", date: "2026-10-07", amount: "-5.80", name: "Transação de NuTag" },
      { id: "broken-toll-fitid", date: "2026-13-45", amount: "-5.80", name: "Transação de NuTag" },
    ]), "pedagio-data-invalida.ofx");
    const brokenToll = brokenTolls.items![1]!;
    assert.equal(brokenToll.validationStatus, "duplicate");
    assert.ok(!brokenToll.date, "the impossible date must not survive as a date");
    assert.equal(brokenToll.canIncludeDuplicate, false);
  } finally {
    await app?.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
