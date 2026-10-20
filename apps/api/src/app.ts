import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Database } from "./database.js";
import { AuthService } from "./auth/auth.service.js";
import { UnconfiguredEmailSender } from "./auth/email-sender.js";
import { PostgresAuthRepository } from "./auth/postgres-auth.repository.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import type { AuthConfiguration, AuthRepository, EmailSender } from "./auth/auth.types.js";
import { CategoriesService } from "./categories/categories.service.js";
import { PostgresCategoriesRepository } from "./categories/postgres-categories.repository.js";
import { registerCategoryRoutes } from "./categories/categories.routes.js";
import type { CategoryRepository } from "./categories/categories.types.js";
import { IncomesService } from "./incomes/incomes.service.js";
import { PostgresIncomesRepository } from "./incomes/postgres-incomes.repository.js";
import { registerIncomeRoutes } from "./incomes/incomes.routes.js";
import type { IncomeRepository } from "./incomes/incomes.types.js";
import { ExpensesService } from "./expenses/expenses.service.js";
import { PostgresExpensesRepository } from "./expenses/postgres-expenses.repository.js";
import { registerExpenseRoutes } from "./expenses/expenses.routes.js";
import type { ExpenseRepository } from "./expenses/expenses.types.js";
import { InvestmentGoalsService } from "./investment-goals/investment-goals.service.js";
import { PostgresInvestmentGoalsRepository } from "./investment-goals/postgres-investment-goals.repository.js";
import { registerInvestmentGoalRoutes } from "./investment-goals/investment-goals.routes.js";
import type { InvestmentGoalsRepository } from "./investment-goals/investment-goals.types.js";
import { FinancialSummaryService } from "./financial-summary/financial-summary.service.js";
import { PostgresFinancialSummaryRepository } from "./financial-summary/postgres-financial-summary.repository.js";
import { registerFinancialSummaryRoutes } from "./financial-summary/financial-summary.routes.js";
import type { FinancialSummaryRepository } from "./financial-summary/financial-summary.types.js";
import { WalletsService } from "./wallets/wallets.service.js";
import { PostgresWalletsRepository } from "./wallets/postgres-wallets.repository.js";
import { registerWalletRoutes } from "./wallets/wallets.routes.js";
import type { WalletRepository } from "./wallets/wallets.types.js";
import { WalletError } from "./wallets/wallets.errors.js";

export interface AppOptions {
  logger?: boolean;
  emailSender?: EmailSender;
  authRepository?: AuthRepository;
  categoryRepository?: CategoryRepository;
  incomeRepository?: IncomeRepository;
  expenseRepository?: ExpenseRepository;
  investmentGoalsRepository?: InvestmentGoalsRepository;
  financialSummaryRepository?: FinancialSummaryRepository;
  walletRepository?: WalletRepository;
  authConfiguration?: Partial<AuthConfiguration>;
  secureCookies?: boolean;
}

export function createApp(
  database: Database,
  options: AppOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const walletsService = new WalletsService(
    options.walletRepository ?? new PostgresWalletsRepository(database),
  );
  app.decorateRequest("currentWalletId", null);

  const authService = new AuthService(
    options.authRepository ?? new PostgresAuthRepository(database),
    options.emailSender ?? new UnconfiguredEmailSender(),
    {
      webBaseUrl: options.authConfiguration?.webBaseUrl ?? "http://localhost:5173",
      verificationTokenTtlHours: options.authConfiguration?.verificationTokenTtlHours ?? 24,
      sessionTtlDays: options.authConfiguration?.sessionTtlDays ?? 7,
    },
    undefined,
    (error) => {
      const metadata = typeof error === "object" && error !== null
        ? error as { code?: unknown; responseCode?: unknown }
        : {};
      app.log.error({
        smtpCode: typeof metadata.code === "string" ? metadata.code : "UNKNOWN",
        smtpResponseCode: typeof metadata.responseCode === "number" ? metadata.responseCode : undefined,
      }, "Confirmation email delivery failed");
    },
  );

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error.validation) {
      return reply.code(400).send({ message: "Os dados enviados são inválidos." });
    }
    if (error.statusCode && error.statusCode >= 400 && error.statusCode < 500) {
      const message = error.statusCode === 404 ? "Rota não encontrada." : "Não foi possível processar a solicitação.";
      return reply.code(error.statusCode).send({ message });
    }
    request.log.error({ errorName: error.name }, "Request failed");
    return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
  });

  app.get("/health", async (_request, reply) => {
    try {
      await database.query("SELECT 1");
      return { status: "ok", database: "ok" };
    } catch {
      app.log.error("Database health check failed");
      return reply.code(503).send({
        status: "error",
        database: "unavailable",
      });
    }
  });

  registerAuthRoutes(app, {
    authService,
    secureCookies: options.secureCookies ?? false,
  });

  app.decorate("resolveWalletContext", async (request, reply) => {
    try {
      const walletHeader = request.headers["x-wallet-id"];
      if (Array.isArray(walletHeader)) throw new WalletError("Carteira não encontrada.", 404);
      request.currentWalletId = await walletsService.resolveActiveWallet(
        request.currentUser!.id,
        walletHeader,
      );
    } catch (error) {
      if (error instanceof WalletError) {
        return reply.code(error.statusCode).send({ message: error.message });
      }
      request.log.error({ errorName: error instanceof Error ? error.name : "UnknownError" }, "Wallet context resolution failed");
      return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
    }
  });

  registerWalletRoutes(app, { walletsService });

  registerCategoryRoutes(app, {
    categoriesService: new CategoriesService(
      options.categoryRepository ?? new PostgresCategoriesRepository(database),
    ),
  });

  registerIncomeRoutes(app, {
    incomesService: new IncomesService(
      options.incomeRepository ?? new PostgresIncomesRepository(database),
    ),
  });

  registerExpenseRoutes(app, {
    expensesService: new ExpensesService(
      options.expenseRepository ?? new PostgresExpensesRepository(database),
    ),
  });

  registerInvestmentGoalRoutes(app, {
    investmentGoalsService: new InvestmentGoalsService(
      options.investmentGoalsRepository ?? new PostgresInvestmentGoalsRepository(database),
    ),
  });

  registerFinancialSummaryRoutes(app, {
    financialSummaryService: new FinancialSummaryService(
      options.financialSummaryRepository ?? new PostgresFinancialSummaryRepository(database),
    ),
  });

  return app;
}
