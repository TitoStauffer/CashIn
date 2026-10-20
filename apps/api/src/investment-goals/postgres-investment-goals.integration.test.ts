import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createDatabase, runMigrations } from "../database.js";
import { InvestmentGoalsService } from "./investment-goals.service.js";
import { PostgresInvestmentGoalsRepository } from "./postgres-investment-goals.repository.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

test("PostgreSQL investment goal and contribution CRUD preserves progress and owner isolation", {
  skip: !testDatabaseUrl,
}, async () => {
  const schemaName = `goal_test_${randomBytes(8).toString("hex")}`;
  const adminPool = new Pool({ connectionString: testDatabaseUrl });
  let scopedPool: Pool | undefined;

  try {
    await adminPool.query(`CREATE SCHEMA ${schemaName}`);
    scopedPool = new Pool({ connectionString: testDatabaseUrl, options: `-c search_path=${schemaName}` });
    const database = createDatabase(scopedPool);
    await runMigrations(database);
    const users = await database.query<{ id: string; email: string }>(
      `INSERT INTO users (email, password_hash, email_verified_at)
       VALUES ($1, 'test-hash', now()), ($2, 'test-hash', now()) RETURNING id, email`,
      [`goal-${schemaName}@example.com`, `other-${schemaName}@example.com`],
    );
    const userId = users.rows.find((row) => row.email === `goal-${schemaName}@example.com`)?.id;
    const otherUserId = users.rows.find((row) => row.email === `other-${schemaName}@example.com`)?.id;
    assert.ok(userId && otherUserId);
    const walletRows = await database.query<{ owner_user_id: string; id: string }>(
      "SELECT owner_user_id, id FROM wallets WHERE owner_user_id = ANY($1::uuid[])", [[userId, otherUserId]],
    );
    const walletId = walletRows.rows.find((row) => row.owner_user_id === userId)!.id;
    const otherWalletId = walletRows.rows.find((row) => row.owner_user_id === otherUserId)!.id;
    const service = new InvestmentGoalsService(new PostgresInvestmentGoalsRepository(database));

    const categories = await database.query<{ id: string; nature: string; user_id: string }>(
      `INSERT INTO categories (user_id, wallet_id, name, nature)
       VALUES ($1, $3, 'Reserva', 'investment'), ($1, $3, 'Reserva antiga', 'investment_goal'), ($1, $3, 'Mercado', 'expense'), ($2, $4, 'Reserva', 'investment')
       RETURNING id, nature, user_id`,
      [userId, otherUserId, walletId, otherWalletId],
    );
    const investmentCategory = categories.rows.find((row) => row.nature === "investment" && row.user_id === userId)!.id;
    const legacyInvestmentCategory = categories.rows.find((row) => row.nature === "investment_goal" && row.user_id === userId)!.id;
    const expenseCategory = categories.rows.find((row) => row.nature === "expense" && row.user_id === userId)!.id;
    const foreignCategory = categories.rows.find((row) => row.user_id === otherUserId)!.id;
    const subcategory = await database.query<{ id: string }>(
      "INSERT INTO subcategories (user_id, wallet_id, category_id, name) VALUES ($1, $2, $3, 'Emergência') RETURNING id",
      [userId, walletId, investmentCategory],
    );

    const goal = await service.createGoal(userId, walletId, {
      title: "Reserva de emergência", description: "Guardar uma reserva financeira.", targetAmount: "1000.00",
      categoryId: investmentCategory, subcategoryId: subcategory.rows[0]!.id,
    });
    assert.equal(goal.targetAmount, "1000.00");
    assert.equal(goal.dueDate, null);
    assert.equal(goal.categoryName, "Reserva");
    assert.equal(goal.subcategoryName, "Emergência");
    assert.equal(goal.contributedAmount, "0");
    assert.equal(goal.progressPercentage, 0);
    await assert.rejects(
      service.createGoal(userId, walletId, {
        title: "reserva de EMERGENCIA", description: "Nome com caixa e acento diferentes.", targetAmount: "1000.00",
      }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    await assert.rejects(
      service.createGoal(userId, walletId, { title: "Precisão", description: "Três casas decimais", targetAmount: "1.001" }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400,
    );

    const legacyGoal = await service.createGoal(userId, walletId, {
      title: "Meta antiga", description: "Categoria legada", targetAmount: "25.00", categoryId: legacyInvestmentCategory,
    });
    assert.equal(legacyGoal.categoryName, "Reserva antiga");

    await assert.rejects(
      service.createGoal(userId, walletId, { title: "Inválida", description: "Natureza de despesa", targetAmount: "10", categoryId: expenseCategory }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400,
    );
    await assert.rejects(
      service.createGoal(userId, walletId, { title: "Inválida", description: "Outra conta", targetAmount: "10", categoryId: foreignCategory }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 400,
    );

    const contribution = await service.createContribution(userId, walletId, goal.id, {
      amount: "125.50", date: "2026-10-19", description: "Primeiro aporte",
    });
    const afterCreate = await service.getGoal(userId, walletId, goal.id);
    assert.equal(afterCreate.contributedAmount, "125.50");
    assert.equal(afterCreate.progressPercentage, 12.55);
    await service.updateContribution(userId, walletId, goal.id, contribution.id, {
      amount: "200.00", date: "2026-10-20", description: null,
    });
    assert.equal((await service.getGoal(userId, walletId, goal.id)).contributedAmount, "200.00");
    const removable = await service.createContribution(userId, walletId, goal.id, { amount: "5.00", date: "2026-10-20" });
    await service.deleteContribution(userId, walletId, goal.id, removable.id);
    assert.equal((await service.getGoal(userId, walletId, goal.id)).contributedAmount, "200.00");
    assert.equal((await service.listGoals(otherUserId, otherWalletId)).length, 0);
    await assert.rejects(
      service.getGoal(otherUserId, otherWalletId, goal.id),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 404,
    );
    assert.equal((await service.closeGoal(userId, walletId, goal.id)).status, "closed");
    await assert.rejects(
      service.createContribution(userId, walletId, goal.id, { amount: "10", date: "2026-10-20" }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    await assert.rejects(
      service.updateGoal(userId, walletId, goal.id, { title: "Meta alterada", description: "Meta fechada", targetAmount: "1000" }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    await assert.rejects(
      service.updateContribution(userId, walletId, goal.id, contribution.id, { amount: "300", date: "2026-10-21" }),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    await assert.rejects(
      service.deleteContribution(userId, walletId, goal.id, contribution.id),
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    assert.equal((await service.getGoal(userId, walletId, goal.id)).contributedAmount, "200.00");

    const concurrentGoal = await service.createGoal(userId, walletId, {
      title: "Meta concorrente", description: "Validar serialização do encerramento.", targetAmount: "500.00",
    });
    let signalLockAcquired!: () => void;
    const lockAcquired = new Promise<void>((resolve) => { signalLockAcquired = resolve; });
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeDatabase = {
      query: database.query.bind(database),
      transaction: <Result>(work: Parameters<typeof database.transaction<Result>>[0]) => database.transaction(async (executor) => work({
        query: async <Row extends import("pg").QueryResultRow>(queryText: string, values?: readonly unknown[]) => {
          const result = await executor.query<Row>(queryText, values);
          if (queryText.includes("FOR UPDATE")) {
            signalLockAcquired();
            await closeGate;
          }
          return result;
        },
      })),
    };
    const closingService = new InvestmentGoalsService(new PostgresInvestmentGoalsRepository(closeDatabase));
    const closing = closingService.closeGoal(userId, walletId, concurrentGoal.id);
    await lockAcquired;

    const concurrentMutation = service.createContribution(userId, walletId, concurrentGoal.id, {
      amount: "50.00", date: "2026-10-21", description: "Concorrente ao fechamento",
    });
    let mutationWaitingForLock = false;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const waiting = await scopedPool.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity
           WHERE datname = current_database()
             AND pid <> pg_backend_pid()
             AND wait_event_type = 'Lock'
             AND query LIKE '%FOR UPDATE%'
         ) AS waiting`,
      );
      if (waiting.rows[0]?.waiting) {
        mutationWaitingForLock = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    releaseClose();
    assert.equal((await closing).status, "closed");
    assert.equal(mutationWaitingForLock, true, "concurrent contribution should wait for the goal lock");
    await assert.rejects(
      concurrentMutation,
      (error: unknown) => typeof error === "object" && error !== null && "statusCode" in error && error.statusCode === 409,
    );
    assert.deepEqual(await service.listContributions(userId, walletId, concurrentGoal.id), []);
  } finally {
    await scopedPool?.end();
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await adminPool.end();
  }
});
