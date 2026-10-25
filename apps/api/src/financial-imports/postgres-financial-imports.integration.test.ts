import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createApp } from "../app.js";
import { PostgresAuthRepository } from "../auth/postgres-auth.repository.js";
import { createOpaqueToken, hashToken } from "../auth/token.js";
import { createDatabase, runMigrations } from "../database.js";
import { PostgresFinancialImportsRepository } from "./postgres-financial-imports.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL financial import confirms exact amounts, isolates wallets, and safely undoes unchanged movements", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `financial_import_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;
  let app: ReturnType<typeof createApp> | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({
      connectionString: testDatabaseUrl,
      options: `-c search_path=${schemaName}`,
    });
    const database = createDatabase(scopedPool);
    await runMigrations(database);
    const repository = new PostgresFinancialImportsRepository(database);

    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now())
       RETURNING id, email`,
      [`import-${schemaName}@example.com`, `other-${schemaName}@example.com`],
    );
    const userId = users.rows.find((row) => row.email.startsWith("import-"))!.id;
    const otherUserId = users.rows.find((row) => row.email.startsWith("other-"))!.id;
    const wallets = await database.query<{ id: string; owner_user_id: string }>(
      "SELECT id, owner_user_id FROM wallets WHERE owner_user_id = ANY($1::uuid[])",
      [[userId, otherUserId]],
    );
    const walletId = wallets.rows.find((row) => row.owner_user_id === userId)!.id;
    const otherWalletId = wallets.rows.find((row) => row.owner_user_id === otherUserId)!.id;
    await database.query(
      "INSERT INTO wallet_members (wallet_id, user_id, role) VALUES ($1, $2, 'member')",
      [walletId, otherUserId],
    );
    const categories = await database.query<{ id: string; nature: "income" | "expense" }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $2, 'Salário', 'income'), ($1, $2, 'Alimentação', 'expense')
       RETURNING id, nature`,
      [userId, walletId],
    );
    const incomeCategoryId = categories.rows.find((row) => row.nature === "income")!.id;
    const expenseCategoryId = categories.rows.find((row) => row.nature === "expense")!.id;
    const sessionToken = createOpaqueToken();
    await new PostgresAuthRepository(database).createSession(
      userId,
      hashToken(sessionToken),
      new Date(Date.now() + 60_000),
    );
    app = createApp(database, { financialImportRepository: repository });
    await app.ready();
    const authenticatedHeaders = {
      cookie: `cashin_session=${sessionToken}`,
      "x-wallet-id": walletId,
    };

    const created = await repository.createImport(userId, walletId, {
      format: "csv",
      fileName: "movimentações.csv",
      fileSize: 128,
      fileHash: "a".repeat(64),
    });
    assert.equal(created.status, "processing");
    assert.equal(created.canUndo, false);
    assert.equal(await repository.getImport(userId, otherWalletId, created.id), null);

    const preview = await repository.savePreview(userId, walletId, created.id, [
      {
        sequence: 1,
        date: "2026-10-20",
        description: "Salário",
        signedAmount: "123456789012.34",
        type: "income",
        categoryId: incomeCategoryId,
        validationStatus: "valid",
      },
      {
        sequence: 2,
        date: "2026-10-21",
        description: "Mercado",
        signedAmount: "-87.65",
        type: "expense",
        categoryId: expenseCategoryId,
        validationStatus: "valid",
      },
      {
        sequence: 3,
        date: "2026-10-21",
        description: "Sem categoria",
        signedAmount: "-1.00",
        type: "expense",
        validationStatus: "uncategorized",
      },
      {
        sequence: 4,
        date: null,
        description: "Linha inválida preservada",
        signedAmount: null,
        type: "expense",
        validationStatus: "invalid",
        errorMessage: "Data e valor inválidos.",
      },
      {
        sequence: 5,
        date: "2026-10-22",
        description: "Sequência original repetida",
        signedAmount: "5.00",
        type: "expense",
        validationStatus: "invalid",
        errorMessage: "A sequência original da movimentação está duplicada no arquivo.",
      },
      {
        sequence: 6,
        date: "2026-10-22",
        description: "Lançamento duplicado",
        signedAmount: "5.00",
        type: "expense",
        validationStatus: "duplicate",
        errorMessage: "A movimentação já existe.",
      },
    ]);
    assert.deepEqual(preview?.summary, {
      total: 6,
      valid: 2,
      duplicate: 1,
      invalid: 2,
      uncategorized: 1,
      imported: 0,
    });
    assert.equal(preview?.items?.length, 6);
    assert.deepEqual(preview?.items?.[3], {
      id: preview?.items?.[3]?.id,
      sequence: 4,
      date: "",
      description: "Linha inválida preservada",
      amount: "0.00",
      type: "expense",
      categoryId: null,
      subcategoryId: null,
      validationStatus: "invalid",
      errorMessage: "Data e valor inválidos.",
      canEdit: false,
      createdAt: preview?.items?.[3]?.createdAt,
      updatedAt: preview?.items?.[3]?.updatedAt,
    });

    for (const excludedItem of [preview?.items?.[4], preview?.items?.[5]]) {
      assert.ok(excludedItem);
      const patchResponse: { statusCode: number } = await app.inject({
        method: "PATCH",
        url: `/financial-imports/${created.id}/items/${excludedItem.id}`,
        headers: authenticatedHeaders,
        payload: {
          date: "2026-10-23",
          description: excludedItem.description,
          type: "expense",
          categoryId: expenseCategoryId,
          subcategoryId: null,
        },
      });
      assert.equal(patchResponse.statusCode, 409);
    }
    const excludedItems = await database.query<{ validation_status: string }>(
      `SELECT validation_status FROM import_items
       WHERE import_session_id = $1 AND sequence IN (5, 6)
       ORDER BY sequence`,
      [created.id],
    );
    assert.deepEqual(excludedItems.rows.map((row) => row.validation_status), ["invalid", "duplicate"]);

    const completed = await repository.confirmImport(otherUserId, walletId, created.id);
    assert.equal(completed?.status, "completed");
    assert.equal(completed?.summary.imported, 2);
    assert.equal(completed?.canUndo, true);
    const movements = await database.query<{ source: string; amount: string }>(
      `SELECT 'income' AS source, amount::text FROM incomes WHERE wallet_id = $1
       UNION ALL
       SELECT 'expense' AS source, amount::text FROM expenses WHERE wallet_id = $1
       ORDER BY source`,
      [walletId],
    );
    assert.deepEqual(movements.rows, [
      { source: "expense", amount: "87.65" },
      { source: "income", amount: "123456789012.34" },
    ]);

    const undone = await repository.undoImport(userId, walletId, created.id);
    assert.equal(undone?.status, "undone");
    assert.equal(undone?.summary.imported, 0);
    assert.equal((await database.query("SELECT id FROM incomes WHERE wallet_id = $1", [walletId])).rows.length, 0);
    assert.equal((await database.query("SELECT id FROM expenses WHERE wallet_id = $1", [walletId])).rows.length, 0);

    const changedSession = await repository.createImport(userId, walletId, {
      format: "ofx",
      fileName: "statement.ofx",
      fileSize: 64,
      fileHash: "b".repeat(64),
    });
    await repository.savePreview(userId, walletId, changedSession.id, [{
      sequence: 1,
      date: "2026-10-22",
      signedAmount: "10.00",
      type: "income",
      categoryId: incomeCategoryId,
      validationStatus: "valid",
    }]);
    await repository.confirmImport(userId, walletId, changedSession.id);
    await database.query(
      "UPDATE incomes SET description = 'alterado', updated_at = now() + interval '1 second' WHERE wallet_id = $1",
      [walletId],
    );
    const changed = await repository.getImport(userId, walletId, changedSession.id);
    assert.equal(changed?.canUndo, false);
    assert.equal(changed?.undoBlockedReason, "Um ou mais lançamentos importados foram alterados ou removidos.");
    assert.equal(await repository.undoImport(userId, walletId, changedSession.id), null);
    await database.query("DELETE FROM incomes WHERE wallet_id = $1", [walletId]);
    const removed = await repository.getImport(userId, walletId, changedSession.id);
    assert.equal(removed?.canUndo, false);
    assert.equal(removed?.undoBlockedReason, "Um ou mais lançamentos importados foram alterados ou removidos.");

    const removableCategory = await database.query<{ id: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $2, 'Categoria liberada pelo desfazer', 'expense')
       RETURNING id`,
      [userId, walletId],
    );
    const removableCategoryId = removableCategory.rows[0]!.id;
    const removableSubcategory = await database.query<{ id: string }>(
      `INSERT INTO subcategories (user_id, wallet_id, category_id, name)
       VALUES ($1, $2, $3, 'Subcategoria liberada pelo desfazer')
       RETURNING id`,
      [userId, walletId, removableCategoryId],
    );
    const removableSubcategoryId = removableSubcategory.rows[0]!.id;
    const removableSession = await repository.createImport(userId, walletId, {
      format: "csv",
      fileName: "remove-references.csv",
      fileSize: 64,
      fileHash: "e".repeat(64),
    });
    await repository.savePreview(userId, walletId, removableSession.id, [
      {
        sequence: 1,
        date: "2026-10-23",
        description: "Histórico preservado sem classificação",
        signedAmount: "19.99",
        type: "expense",
        categoryId: removableCategoryId,
        subcategoryId: removableSubcategoryId,
        validationStatus: "valid",
      },
      {
        sequence: 2,
        date: "2026-10-23",
        description: "Inválido preservado sem classificação",
        signedAmount: "3.50",
        type: "expense",
        categoryId: removableCategoryId,
        subcategoryId: removableSubcategoryId,
        validationStatus: "invalid",
        errorMessage: "A sequência original da movimentação está duplicada no arquivo.",
      },
    ]);

    for (const [table, id] of [
      ["subcategories", removableSubcategoryId],
      ["categories", removableCategoryId],
    ] as const) {
      await assert.rejects(
        database.query(`DELETE FROM ${table} WHERE id = $1 AND wallet_id = $2`, [id, walletId]),
        (error: unknown) => (error as { code?: string }).code === "23503",
      );
    }

    await repository.confirmImport(userId, walletId, removableSession.id);
    for (const [table, id] of [
      ["subcategories", removableSubcategoryId],
      ["categories", removableCategoryId],
    ] as const) {
      await assert.rejects(
        database.query(`DELETE FROM ${table} WHERE id = $1 AND wallet_id = $2`, [id, walletId]),
        (error: unknown) => (error as { code?: string }).code === "23503",
      );
    }

    assert.equal((await repository.undoImport(userId, walletId, removableSession.id))?.status, "undone");
    const historicalItems = (await repository.getImport(userId, walletId, removableSession.id))?.items;
    const historicalItem = historicalItems?.[0];
    assert.deepEqual(historicalItem && {
      date: historicalItem.date,
      description: historicalItem.description,
      amount: historicalItem.amount,
      type: historicalItem.type,
      validationStatus: historicalItem.validationStatus,
      errorMessage: historicalItem.errorMessage,
      categoryId: historicalItem.categoryId,
      subcategoryId: historicalItem.subcategoryId,
    }, {
      date: "2026-10-23",
      description: "Histórico preservado sem classificação",
      amount: "19.99",
      type: "expense",
      validationStatus: "uncategorized",
      errorMessage: "Selecione uma categoria para importar a movimentação.",
      categoryId: null,
      subcategoryId: null,
    });
    const invalidHistoricalItem = historicalItems?.[1];
    assert.deepEqual(invalidHistoricalItem && {
      date: invalidHistoricalItem.date,
      description: invalidHistoricalItem.description,
      amount: invalidHistoricalItem.amount,
      type: invalidHistoricalItem.type,
      validationStatus: invalidHistoricalItem.validationStatus,
      errorMessage: invalidHistoricalItem.errorMessage,
      categoryId: invalidHistoricalItem.categoryId,
      subcategoryId: invalidHistoricalItem.subcategoryId,
    }, {
      date: "2026-10-23",
      description: "Inválido preservado sem classificação",
      amount: "3.50",
      type: "expense",
      validationStatus: "invalid",
      errorMessage: "A sequência original da movimentação está duplicada no arquivo.",
      categoryId: null,
      subcategoryId: null,
    });
    assert.equal(
      (await database.query(
        "DELETE FROM subcategories WHERE id = $1 AND wallet_id = $2 RETURNING id",
        [removableSubcategoryId, walletId],
      )).rowCount,
      1,
    );
    assert.equal(
      (await database.query(
        "DELETE FROM categories WHERE id = $1 AND wallet_id = $2 RETURNING id",
        [removableCategoryId, walletId],
      )).rowCount,
      1,
    );

    const discardCategory = await database.query<{ id: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $2, 'Categoria da prévia descartada', 'expense') RETURNING id`,
      [userId, walletId],
    );
    const discardCategoryId = discardCategory.rows[0]!.id;
    const discardSubcategory = await database.query<{ id: string }>(
      `INSERT INTO subcategories (user_id, wallet_id, category_id, name)
       VALUES ($1, $2, $3, 'Subcategoria da prévia descartada') RETURNING id`,
      [userId, walletId, discardCategoryId],
    );
    const discardSubcategoryId = discardSubcategory.rows[0]!.id;
    const discardSession = await repository.createImport(userId, walletId, {
      format: "csv",
      fileName: "descartar.csv",
      fileSize: 64,
      fileHash: "8".repeat(64),
    });
    await repository.savePreview(userId, walletId, discardSession.id, [{
      sequence: 1,
      date: "2026-10-23",
      description: "Prévia abandonada",
      signedAmount: "4.50",
      type: "expense",
      categoryId: discardCategoryId,
      subcategoryId: discardSubcategoryId,
      validationStatus: "valid",
    }]);
    const discarded = await repository.discardImport(userId, walletId, discardSession.id);
    assert.equal(discarded?.status, "failed");
    assert.equal(discarded?.failureMessage, "Importação descartada pelo usuário.");
    assert.equal(discarded?.items?.[0]?.categoryId, null);
    assert.equal(discarded?.items?.[0]?.subcategoryId, null);
    assert.equal(
      (await database.query("DELETE FROM subcategories WHERE id = $1 AND wallet_id = $2 RETURNING id", [discardSubcategoryId, walletId])).rowCount,
      1,
    );
    assert.equal(
      (await database.query("DELETE FROM categories WHERE id = $1 AND wallet_id = $2 RETURNING id", [discardCategoryId, walletId])).rowCount,
      1,
    );

    const concurrentSession = await repository.createImport(userId, walletId, {
      format: "csv",
      fileName: "concurrent.csv",
      fileSize: 64,
      fileHash: "c".repeat(64),
    });
    await repository.savePreview(userId, walletId, concurrentSession.id, [{
      sequence: 1,
      date: "2026-10-23",
      signedAmount: "25.00",
      type: "income",
      categoryId: incomeCategoryId,
      validationStatus: "valid",
    }]);
    await repository.confirmImport(userId, walletId, concurrentSession.id);
    const concurrentTarget = await database.query<{ income_id: string }>(
      `SELECT resulting_income_id AS income_id
       FROM import_items
       WHERE import_session_id = $1 AND validation_status = 'imported'`,
      [concurrentSession.id],
    );
    const blocker = await scopedPool.connect();
    try {
      await blocker.query("BEGIN");
      await blocker.query(
        `UPDATE incomes
         SET updated_at = updated_at + interval '1 microsecond'
         WHERE id = $1 AND wallet_id = $2`,
        [concurrentTarget.rows[0]!.income_id, walletId],
      );

      const concurrentUndo = repository.undoImport(userId, walletId, concurrentSession.id);
      const raceResult = await Promise.race([
        concurrentUndo.then(() => "finished" as const),
        delay(100).then(() => "waiting" as const),
      ]);
      assert.equal(raceResult, "waiting", "undo must wait for a concurrent movement update lock");

      await blocker.query("COMMIT");
      assert.equal(await concurrentUndo, null);
      assert.equal(
        (await database.query("SELECT count(*)::integer AS count FROM incomes WHERE id = $1", [concurrentTarget.rows[0]!.income_id])).rows[0]!.count,
        1,
        "a one-microsecond concurrent update must block undo without losing the movement",
      );
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }

    const editSession = await repository.createImport(userId, walletId, {
      format: "csv",
      fileName: "edit-confirm.csv",
      fileSize: 64,
      fileHash: "d".repeat(64),
    });
    const editPreview = await repository.savePreview(userId, walletId, editSession.id, [{
      sequence: 1,
      date: "2026-10-23",
      description: "Classificação concorrente",
      signedAmount: "15.00",
      type: "income",
      validationStatus: "uncategorized",
    }]);
    const editItem = editPreview?.items?.[0];
    assert.ok(editItem);
    const itemBlocker = await scopedPool.connect();
    try {
      await itemBlocker.query("BEGIN");
      await itemBlocker.query(
        "SELECT id FROM import_items WHERE id = $1 AND wallet_id = $2 FOR UPDATE",
        [editItem.id, walletId],
      );

      const editPromise = repository.updateItem(userId, walletId, editSession.id, editItem.id, {
        date: "2026-10-23",
        description: "Classificação concorrente",
        type: "income",
        categoryId: incomeCategoryId,
        subcategoryId: null,
      });
      await delay(100);
      const confirmationPromise = repository.confirmImport(userId, walletId, editSession.id);
      const concurrentRace = await Promise.race([
        confirmationPromise.then(() => "finished" as const),
        delay(100).then(() => "waiting" as const),
      ]);
      assert.equal(concurrentRace, "waiting", "confirmation must wait for the editing session lock");

      await itemBlocker.query("COMMIT");
      assert.equal((await editPromise)?.validationStatus, "valid");
      const confirmation = await confirmationPromise;
      assert.equal(confirmation?.status, "completed");
      assert.equal(confirmation?.summary.imported, 1);
      assert.equal(
        (await database.query(
          "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description = $2",
          [walletId, "Classificação concorrente"],
        )).rows[0]!.count,
        1,
      );
    } finally {
      await itemBlocker.query("ROLLBACK").catch(() => undefined);
      itemBlocker.release();
    }

    const rollbackSession = await repository.createImport(userId, walletId, {
      format: "csv",
      fileName: "rollback.csv",
      fileSize: 64,
      fileHash: "f".repeat(64),
    });
    await repository.savePreview(userId, walletId, rollbackSession.id, [
      {
        sequence: 1,
        date: "2026-10-24",
        description: "Inserção anterior à falha",
        signedAmount: "11.00",
        type: "income",
        categoryId: incomeCategoryId,
        validationStatus: "valid",
      },
      {
        sequence: 2,
        date: "2026-10-24",
        description: "Falha determinística",
        signedAmount: "12.00",
        type: "income",
        categoryId: incomeCategoryId,
        validationStatus: "valid",
      },
    ]);
    await database.query(`
      CREATE FUNCTION reject_financial_import_test() RETURNS trigger AS $$
      BEGIN
        IF NEW.description = 'Falha determinística' THEN
          RAISE EXCEPTION 'falha determinística de integração';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_financial_import_test
      BEFORE INSERT ON incomes
      FOR EACH ROW EXECUTE FUNCTION reject_financial_import_test();
    `);
    try {
      await assert.rejects(
        repository.confirmImport(userId, walletId, rollbackSession.id),
        /falha determinística de integração/i,
      );
      assert.equal((await repository.getImport(userId, walletId, rollbackSession.id))?.status, "preview");
      assert.equal(
        (await database.query(
          "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description IN ($2, $3)",
          [walletId, "Inserção anterior à falha", "Falha determinística"],
        )).rows[0]!.count,
        0,
        "confirmation must roll back every movement and the session state",
      );
    } finally {
      await database.query("DROP TRIGGER reject_financial_import_test ON incomes; DROP FUNCTION reject_financial_import_test()");
    }

    await app.close();
    app = createApp(database, {
      financialImportRepository: repository,
      financialImportParser: {
        parse: async () => [
          {
            sequence: 1,
            date: "2026-10-24",
            description: "Linha válida",
            signedAmount: "30.00",
            type: "income",
            categoryId: incomeCategoryId,
          },
          {
            sequence: 2,
            date: "2026-10-24",
            description: "á".repeat(2_001),
            signedAmount: "5.00",
            type: "income",
            categoryId: incomeCategoryId,
          },
          {
            sequence: 3,
            date: "2026-10-24",
            description: "Referências incompatíveis",
            signedAmount: "7.00",
            type: "expense",
            categoryId: "categoria-malformada",
            subcategoryId: "22222222-2222-4222-8222-222222222222",
          },
        ],
      },
    });
    await app.ready();
    const oversizedDescription = await app.inject({
      method: "POST",
      url: "/financial-imports",
      headers: {
        ...authenticatedHeaders,
        "content-type": "application/octet-stream",
        "x-file-name": "description.csv",
        "x-file-format": "csv",
      },
      payload: Buffer.from("description-test"),
    });
    assert.equal(oversizedDescription.statusCode, 201);
    assert.deepEqual(oversizedDescription.json().summary, {
      total: 3,
      valid: 1,
      duplicate: 0,
      invalid: 2,
      uncategorized: 0,
      imported: 0,
    });
    assert.equal(Buffer.byteLength(oversizedDescription.json().items[1].description, "utf8"), 4_000);
    assert.match(oversizedDescription.json().items[1].errorMessage, /máximo 4\.000 bytes/i);
    assert.equal(oversizedDescription.json().items[1].canEdit, true);
    assert.equal(oversizedDescription.json().items[2].validationStatus, "invalid");
    assert.equal(oversizedDescription.json().items[2].categoryId, null);
    assert.equal(oversizedDescription.json().items[2].subcategoryId, null);
    assert.match(oversizedDescription.json().items[2].errorMessage, /categoria ou subcategoria.+inválida/i);

    const repairedDescription = await app.inject({
      method: "PATCH",
      url: `/financial-imports/${oversizedDescription.json().id}/items/${oversizedDescription.json().items[1].id}`,
      headers: authenticatedHeaders,
      payload: {
        date: "2026-10-24",
        description: "Descrição corrigida",
        type: "income",
        categoryId: incomeCategoryId,
        subcategoryId: null,
      },
    });
    assert.equal(repairedDescription.statusCode, 200);
    assert.equal(repairedDescription.json().validationStatus, "valid");

    const confirmedDescriptionImport = await app.inject({
      method: "POST",
      url: `/financial-imports/${oversizedDescription.json().id}/confirm`,
      headers: authenticatedHeaders,
    });
    assert.equal(confirmedDescriptionImport.statusCode, 200);
    assert.equal(confirmedDescriptionImport.json().summary.imported, 2);
    assert.equal(confirmedDescriptionImport.json().summary.invalid, 1);
    assert.equal(
      (await database.query(
        "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description = 'Linha válida'",
        [walletId],
      )).rows[0]!.count,
      1,
    );

    const crossWalletCategory = await database.query<{ id: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $2, 'Categoria externa', 'income') RETURNING id`,
      [otherUserId, otherWalletId],
    );
    const incompatibleSubcategory = await database.query<{ id: string }>(
      `INSERT INTO subcategories (user_id, wallet_id, category_id, name)
       VALUES ($1, $2, $3, 'Subcategoria incompatível') RETURNING id`,
      [userId, walletId, expenseCategoryId],
    );
    await app.close();
    app = createApp(database, {
      financialImportRepository: repository,
      financialImportParser: {
        parse: async () => [
          {
            sequence: 1,
            date: "2026-10-25",
            description: "Referência válida",
            signedAmount: "40.00",
            type: "income",
            categoryId: incomeCategoryId,
          },
          {
            sequence: 2,
            date: "2026-10-25",
            description: "Categoria inexistente",
            signedAmount: "1.00",
            type: "income",
            categoryId: "33333333-3333-4333-8333-333333333333",
            validationStatus: "invalid",
            errorMessage: "Inválida pelo parser.",
          },
          {
            sequence: 3,
            date: "2026-10-25",
            description: "Categoria de outra carteira",
            signedAmount: "2.00",
            type: "income",
            categoryId: crossWalletCategory.rows[0]!.id,
          },
          {
            sequence: 4,
            date: "2026-10-25",
            description: "Categoria de outra natureza",
            signedAmount: "3.00",
            type: "income",
            categoryId: expenseCategoryId,
          },
          {
            sequence: 5,
            date: "2026-10-25",
            description: "Subcategoria incompatível",
            signedAmount: "4.00",
            type: "income",
            categoryId: incomeCategoryId,
            subcategoryId: incompatibleSubcategory.rows[0]!.id,
          },
        ],
      },
    });
    await app.ready();
    const invalidReferences = await app.inject({
      method: "POST",
      url: "/financial-imports",
      headers: {
        ...authenticatedHeaders,
        "content-type": "application/octet-stream",
        "x-file-name": "references.csv",
        "x-file-format": "csv",
      },
      payload: Buffer.from("reference-test"),
    });
    assert.equal(invalidReferences.statusCode, 201);
    assert.deepEqual(invalidReferences.json().summary, {
      total: 5,
      valid: 1,
      duplicate: 0,
      invalid: 4,
      uncategorized: 0,
      imported: 0,
    });
    assert.equal(invalidReferences.json().items.length, 5);
    for (const invalidItem of invalidReferences.json().items.slice(1, 4)) {
      assert.equal(invalidItem.validationStatus, "invalid");
      assert.equal(invalidItem.categoryId, null);
      assert.equal(invalidItem.subcategoryId, null);
      assert.match(invalidItem.errorMessage, /categoria informada não existe nesta carteira|não corresponde ao tipo/i);
    }
    assert.match(invalidReferences.json().items[1].errorMessage, /Inválida pelo parser/);
    assert.equal(invalidReferences.json().items[4].validationStatus, "invalid");
    assert.equal(invalidReferences.json().items[4].categoryId, incomeCategoryId);
    assert.equal(invalidReferences.json().items[4].subcategoryId, null);
    assert.match(invalidReferences.json().items[4].errorMessage, /subcategoria informada não pertence/i);

    const confirmedReferences = await app.inject({
      method: "POST",
      url: `/financial-imports/${invalidReferences.json().id}/confirm`,
      headers: authenticatedHeaders,
    });
    assert.equal(confirmedReferences.statusCode, 200);
    assert.equal(confirmedReferences.json().summary.imported, 1);
    assert.equal(confirmedReferences.json().summary.invalid, 4);
    assert.equal(
      (await database.query(
        "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description = 'Referência válida'",
        [walletId],
      )).rows[0]!.count,
      1,
    );

    const batchSession = await repository.createImport(userId, walletId, {
      format: "csv",
      fileName: "limite-10000.csv",
      fileSize: 1024,
      fileHash: "9".repeat(64),
    });
    const batchPreview = await repository.savePreview(
      userId,
      walletId,
      batchSession.id,
      Array.from({ length: 10_000 }, (_, index) => ({
        sequence: index + 1,
        date: "2026-10-25",
        description: `Movimentação em lote ${index + 1}`,
        signedAmount: "1.00",
        type: "income" as const,
        categoryId: incomeCategoryId,
        validationStatus: "valid" as const,
      })),
    );
    assert.equal(batchPreview?.summary.total, 10_000);
    assert.equal(batchPreview?.items?.length, 10_000);
    const batchCompleted = await repository.confirmImport(userId, walletId, batchSession.id);
    assert.equal(batchCompleted?.summary.imported, 10_000);
    assert.equal(batchCompleted?.items?.length, 10_000);
    assert.equal(
      (await database.query(
        "SELECT count(*)::integer AS count FROM incomes WHERE wallet_id = $1 AND description LIKE 'Movimentação em lote %'",
        [walletId],
      )).rows[0]!.count,
      10_000,
    );
  } finally {
    await app?.close();
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
