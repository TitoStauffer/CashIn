import assert from "node:assert/strict";
import test from "node:test";
import { IncomesService } from "./incomes/incomes.service.js";
import type { IncomeRepository } from "./incomes/incomes.types.js";
import { ExpensesService } from "./expenses/expenses.service.js";
import type { ExpenseRepository } from "./expenses/expenses.types.js";
import { InvestmentGoalError } from "./investment-goals/investment-goals.errors.js";
import { InvestmentGoalsService } from "./investment-goals/investment-goals.service.js";
import type { InvestmentGoalsRepository } from "./investment-goals/investment-goals.types.js";

const USER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const GOAL_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CATEGORY_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const validMovement = {
  amount: "1.00",
  date: "2026-10-20",
  categoryId: CATEGORY_ID,
};

test("income and expense services reject decimal strings that bypass route validation", async () => {
  let incomeRepositoryCalled = false;
  const incomes = new IncomesService({
    createIncome: async () => { incomeRepositoryCalled = true; return null; },
  } as unknown as IncomeRepository);
  await assert.rejects(
    incomes.createIncome(USER_ID, USER_ID, { ...validMovement, amount: "1.001" }),
    (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 400,
  );
  assert.equal(incomeRepositoryCalled, false);

  let expenseRepositoryCalled = false;
  const expenses = new ExpensesService({
    createExpense: async () => { expenseRepositoryCalled = true; return null; },
  } as unknown as ExpenseRepository);
  await assert.rejects(
    expenses.createExpense(USER_ID, USER_ID, { ...validMovement, amount: "999999999999.999" }),
    (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 400,
  );
  assert.equal(expenseRepositoryCalled, false);
});

test("investment goal and contribution services reject invalid precision before persistence", async () => {
  let createGoalCalled = false;
  let createContributionCalled = false;
  const repository = {
    hasGoal: async () => true,
    createGoal: async () => { createGoalCalled = true; return null; },
    createContribution: async () => { createContributionCalled = true; return null; },
  } as unknown as InvestmentGoalsRepository;
  const service = new InvestmentGoalsService(repository);

  await assert.rejects(
    service.createGoal(USER_ID, USER_ID, { title: "Reserva", description: "Fundo", targetAmount: "1.001" }),
    (error: unknown) => error instanceof InvestmentGoalError && error.statusCode === 400,
  );
  await assert.rejects(
    service.createContribution(USER_ID, USER_ID, GOAL_ID, { amount: "0.00", date: "2026-10-20" }),
    (error: unknown) => error instanceof InvestmentGoalError && error.statusCode === 400,
  );
  assert.equal(createGoalCalled, false);
  assert.equal(createContributionCalled, false);
});

test("investment goal service maps database reference violations to a client error", async () => {
  const repository = {
    createGoal: async () => { throw Object.assign(new Error("foreign key violation"), { code: "23503" }); },
  } as unknown as InvestmentGoalsRepository;
  const service = new InvestmentGoalsService(repository);

  await assert.rejects(
    service.createGoal(USER_ID, USER_ID, { title: "Reserva", description: "Fundo", targetAmount: "1.00" }),
    (error: unknown) => error instanceof InvestmentGoalError && error.statusCode === 400,
  );
});
