import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createFinancialImportFingerprint } from "./financial-imports.fingerprint.js";
import { financialImportScenarioTest } from "./financial-imports-integration-test-fixture.js";

financialImportScenarioTest("PostgreSQL financial import confirms exact amounts, isolates wallets, and safely undoes unchanged movements", async (scenario) => {
  const { database, scopedPool, repository, userId, otherUserId, walletId, otherWalletId, categories, incomeCategoryId, expenseCategoryId, authenticatedHeaders, csvConfiguration } = scenario;
  const app = scenario.app;
  const csvMapping = await repository.createCsvMapping(userId, walletId, {
    name: "Banco principal", configuration: csvConfiguration,
  });
  assert.equal(csvMapping.name, "Banco principal");
  assert.deepEqual((await repository.listCsvMappings(otherUserId, walletId)).map((mapping) => mapping.id), [csvMapping.id]);
  assert.equal(await repository.getCsvMapping(userId, otherWalletId, csvMapping.id), null);
  const updatedCsvMapping = await repository.updateCsvMapping(userId, walletId, csvMapping.id, {
    name: "Banco atualizado", configuration: csvConfiguration,
  });
  assert.equal(updatedCsvMapping?.name, "Banco atualizado");
  await assert.rejects(
    database.query(
      `INSERT INTO financial_import_csv_mappings (wallet_id, created_by_user_id, name, configuration)
       VALUES ($1, $2, 'Configuração ambígua', $3::jsonb)`,
      [walletId, userId, JSON.stringify({
        ...csvConfiguration,
        columns: { ...csvConfiguration.columns, credit: 3, debit: 4 },
      })],
    ),
    /financial_import_csv_mappings_configuration_check/,
  );
  for (const [name, columns] of [
    ["Valor e crédito parcial", { ...csvConfiguration.columns, credit: 3 }],
    ["Valor e débito parcial", { ...csvConfiguration.columns, debit: 3 }],
    ["Somente crédito", { ...csvConfiguration.columns, amount: null, credit: 2 }],
    ["Somente débito", { ...csvConfiguration.columns, amount: null, debit: 2 }],
  ] as const) {
    await assert.rejects(
      database.query(
        `INSERT INTO financial_import_csv_mappings (wallet_id, created_by_user_id, name, configuration)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [walletId, userId, name, JSON.stringify({ ...csvConfiguration, columns })],
      ),
      /financial_import_csv_mappings_configuration_check/,
    );
  }
  await assert.rejects(
    database.query(
      `INSERT INTO financial_import_csv_mappings (wallet_id, created_by_user_id, name, configuration)
       VALUES ($1, $2, 'Configuração com chave extra', $3::jsonb)`,
      [walletId, userId, JSON.stringify({ ...csvConfiguration, unexpected: true })],
    ),
    /financial_import_csv_mappings_configuration_check/,
  );

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
      externalId: "fitid-income-1",
      recordHash: "f".repeat(64),
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
  ], {
    currency: "BRL",
    accountReferenceHash: "e".repeat(64),
  });
  assert.deepEqual(preview?.summary, {
    total: 6,
    valid: 2,
    duplicate: 1,
    invalid: 2,
    uncategorized: 1,
    imported: 0,
  });
  assert.equal(preview?.items?.length, 6);
  const persistedSource = await database.query<{
    source_metadata: Record<string, string>;
    external_id: string;
    record_hash: string;
  }>(
    `SELECT session.source_metadata, item.external_id, item.record_hash
     FROM import_sessions AS session
     JOIN import_items AS item ON item.import_session_id = session.id
     WHERE session.id = $1 AND item.sequence = 1`,
    [created.id],
  );
  assert.deepEqual(persistedSource.rows[0], {
    source_metadata: { currency: "BRL", accountReferenceHash: "e".repeat(64) },
    external_id: "fitid-income-1",
    record_hash: "f".repeat(64),
  });
  const blockedNullAmountItem = preview?.items?.[3];
  assert.ok(blockedNullAmountItem);
  const blockedNullAmountPatch: { statusCode: number } = await app.inject({
    method: "PATCH",
    url: `/financial-imports/${created.id}/items/${blockedNullAmountItem.id}`,
    headers: authenticatedHeaders,
    payload: {
      date: "2026-10-23",
      description: blockedNullAmountItem.description,
      type: "expense",
      categoryId: expenseCategoryId,
      subcategoryId: null,
    },
  });
  assert.equal(blockedNullAmountPatch.statusCode, 409);
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
    canIncludeDuplicate: false,
    categorizationSource: null,
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

  const crossFormatSession = await repository.createImport(userId, walletId, {
    format: "ofx", fileName: "repetido.ofx", fileSize: 128, fileHash: "c".repeat(64),
  });
  const crossFormatDescription = "  SALÁRIO  ";
  const crossFormatFingerprint = createFinancialImportFingerprint({
    date: "2026-10-20", signedAmount: "123456789012.34", type: "income", description: crossFormatDescription,
  });
  const crossFormatPreview = await repository.savePreview(userId, walletId, crossFormatSession.id, [{
    sequence: 1,
    date: "2026-10-20",
    description: crossFormatDescription,
    signedAmount: "123456789012.34",
    type: "income",
    categoryId: incomeCategoryId,
    externalId: "different-fitid",
    recordHash: crossFormatFingerprint,
    validationStatus: "valid",
  }], { accountReferenceHash: "d".repeat(64) });
  assert.equal(crossFormatPreview?.summary.duplicate, 1);
  assert.equal(crossFormatPreview?.items?.[0]?.canIncludeDuplicate, true);
  assert.match(crossFormatPreview?.items?.[0]?.errorMessage ?? "", /possível duplicidade/i);

  const separateWalletSession = await repository.createImport(otherUserId, otherWalletId, {
    format: "ofx", fileName: "outra-carteira.ofx", fileSize: 128, fileHash: "f".repeat(64),
  });
  const separateWalletPreview = await repository.savePreview(otherUserId, otherWalletId, separateWalletSession.id, [{
    sequence: 1,
    date: "2026-10-20",
    description: "SALÁRIO",
    signedAmount: "123456789012.34",
    type: "income",
    categoryId: null,
    recordHash: crossFormatFingerprint,
    validationStatus: "uncategorized",
  }]);
  assert.equal(separateWalletPreview?.summary.duplicate, 0);
  await repository.discardImport(otherUserId, otherWalletId, separateWalletSession.id);

  const reviewedDuplicate = await repository.updateItem(userId, walletId, crossFormatSession.id, crossFormatPreview!.items![0]!.id, {
    date: "2026-10-20",
    description: crossFormatDescription,
    type: "income",
    categoryId: incomeCategoryId,
    subcategoryId: null,
    includeDuplicate: true, statementClosingDate: null, creditCardStatementId: null, transferCounterpartWalletId: null, walletTransferId: null,
  });
  assert.equal(reviewedDuplicate?.validationStatus, "valid");
  const acceptedFingerprint = await database.query<{ accepted_duplicate_fingerprint: string | null }>(
    "SELECT accepted_duplicate_fingerprint FROM import_items WHERE id = $1",
    [crossFormatPreview!.items![0]!.id],
  );
  assert.equal(acceptedFingerprint.rows[0]?.accepted_duplicate_fingerprint, crossFormatFingerprint);
  assert.equal((await repository.confirmImport(userId, walletId, crossFormatSession.id))?.summary.imported, 1);
  assert.equal((await repository.undoImport(userId, walletId, crossFormatSession.id))?.status, "undone");

  const changedConsentSession = await repository.createImport(userId, walletId, {
    format: "csv", fileName: "consentimento.csv", fileSize: 128, fileHash: "1".repeat(64),
  });
  const changedConsentPreview = await repository.savePreview(userId, walletId, changedConsentSession.id, [{
    sequence: 1,
    date: "2026-10-20",
    description: "Salário",
    signedAmount: "123456789012.34",
    type: "income",
    categoryId: incomeCategoryId,
    validationStatus: "valid",
  }]);
  const changedConsentItemId = changedConsentPreview!.items![0]!.id;
  const acceptChangedConsent = async (description: string, includeDuplicate = false) => repository.updateItem(
    userId,
    walletId,
    changedConsentSession.id,
    changedConsentItemId,
    { date: "2026-10-20", description, type: "income", categoryId: incomeCategoryId, subcategoryId: null, includeDuplicate, statementClosingDate: null, creditCardStatementId: null, transferCounterpartWalletId: null, walletTransferId: null },
  );
  assert.equal((await acceptChangedConsent("Salário", true))?.validationStatus, "valid");
  assert.equal((await acceptChangedConsent("Salário corrigido"))?.validationStatus, "valid");
  assert.equal((await acceptChangedConsent("Salário"))?.validationStatus, "valid");
  const invalidatedConsentConfirmation = await repository.confirmImport(userId, walletId, changedConsentSession.id);
  assert.equal(invalidatedConsentConfirmation?.status, "preview");
  assert.equal(invalidatedConsentConfirmation?.summary.imported, 0);
  assert.equal(invalidatedConsentConfirmation?.summary.duplicate, 1);
  await repository.discardImport(userId, walletId, changedConsentSession.id);

  const editedSession = await repository.createImport(userId, walletId, {
    format: "csv", fileName: "ajustes.csv", fileSize: 128, fileHash: "2".repeat(64),
  });
  const editedPreview = await repository.savePreview(userId, walletId, editedSession.id, [
    {
      sequence: 1, date: "2026-11-01", description: "Movimento A", signedAmount: "-33.30",
      type: "expense", categoryId: expenseCategoryId, validationStatus: "valid",
    },
    {
      sequence: 2, date: "2026-11-02", description: "Movimento B", signedAmount: "-33.30",
      type: "expense", categoryId: expenseCategoryId, validationStatus: "valid",
    },
  ]);
  const secondEditedItemId = editedPreview!.items![1]!.id;
  const editSecondItem = (includeDuplicate = false) => repository.updateItem(
    userId,
    walletId,
    editedSession.id,
    secondEditedItemId,
    {
      date: "2026-11-01", description: "Movimento A", type: "expense",
      categoryId: expenseCategoryId, subcategoryId: null, includeDuplicate, statementClosingDate: null, creditCardStatementId: null, transferCounterpartWalletId: null, walletTransferId: null,
    },
  );
  assert.equal((await editSecondItem())?.validationStatus, "valid");
  const editedDuplicateConfirmation = await repository.confirmImport(userId, walletId, editedSession.id);
  assert.equal(editedDuplicateConfirmation?.status, "preview");
  assert.equal(editedDuplicateConfirmation?.summary.valid, 1);
  assert.equal(editedDuplicateConfirmation?.summary.duplicate, 1);
  assert.equal(editedDuplicateConfirmation?.summary.imported, 0);
  assert.equal((await editSecondItem(true))?.validationStatus, "valid");
  assert.equal((await repository.confirmImport(userId, walletId, editedSession.id))?.summary.imported, 2);
  await repository.undoImport(userId, walletId, editedSession.id);

  const concurrentSessions = await Promise.all(["d", "e"].map(async (fileHash) => {
    const session = await repository.createImport(userId, walletId, {
      format: "csv", fileName: `${fileHash}.csv`, fileSize: 128, fileHash: fileHash.repeat(64),
    });
    const date = "2026-10-30";
    const signedAmount = "-12.50";
    const description = "Compra concorrente";
    await repository.savePreview(userId, walletId, session.id, [{
      sequence: 1, date, description, signedAmount, type: "expense", categoryId: expenseCategoryId,
      recordHash: createFinancialImportFingerprint({ date, signedAmount, type: "expense", description }),
      validationStatus: "valid",
    }]);
    return session;
  }));
  const concurrentConfirmations = await Promise.all(concurrentSessions.map((session) => (
    repository.confirmImport(userId, walletId, session.id)
  )));
  assert.deepEqual(concurrentConfirmations.map((session) => session?.summary.imported).sort(), [0, 1]);
  assert.equal(concurrentConfirmations.filter((session) => session?.summary.duplicate === 1).length, 1);
  const concurrentWinner = concurrentConfirmations.find((session) => session?.summary.imported === 1);
  assert.ok(concurrentWinner);
  await repository.undoImport(userId, walletId, concurrentWinner.id);

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
      includeDuplicate: false, statementClosingDate: null, creditCardStatementId: null, transferCounterpartWalletId: null, walletTransferId: null,
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
});
