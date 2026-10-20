import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { InvestmentGoalError } from "./investment-goals.errors.js";
import type { InvestmentGoalsService } from "./investment-goals.service.js";
import type { InvestmentContributionInput, InvestmentGoalInput } from "./investment-goals.types.js";
import { MONEY_AMOUNT_PATTERN } from "../shared/money.js";

interface RouteOptions {
  investmentGoalsService: InvestmentGoalsService;
}

interface GoalParams { goalId: string }
interface ContributionParams extends GoalParams { contributionId: string }

const uuidSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
};
const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const amountSchema = {
  type: "string",
  minLength: 1,
  maxLength: 15,
  pattern: MONEY_AMOUNT_PATTERN,
};
const nullableUuidSchema = { anyOf: [uuidSchema, { type: "null" }] };
const nullableDateSchema = { anyOf: [dateSchema, { type: "null" }] };
const goalBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "description", "targetAmount"],
  properties: {
    title: { type: "string", minLength: 1, maxLength: 120 },
    description: { type: "string", minLength: 1, maxLength: 1000 },
    targetAmount: amountSchema,
    dueDate: nullableDateSchema,
    categoryId: nullableUuidSchema,
    subcategoryId: nullableUuidSchema,
  },
};
const contributionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "date"],
  properties: {
    amount: amountSchema,
    date: dateSchema,
    description: { anyOf: [{ type: "string", maxLength: 1000 }, { type: "null" }] },
  },
};

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof InvestmentGoalError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
}

function rejectUnexpectedProperties(allowedProperties: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.body;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    if (Object.keys(value).some((key) => !allowedProperties.includes(key))) {
      return reply.code(400).send({ message: "Os dados enviados são inválidos." });
    }
  };
}

export function registerInvestmentGoalRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.get("/investment-goals", { preHandler: [app.authenticate, app.resolveWalletContext] }, async (request, reply) => {
    try {
      const items = await options.investmentGoalsService.listGoals(request.currentUser!.id, request.currentWalletId!);
      return reply.code(200).send({ items });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Body: InvestmentGoalInput }>(
    "/investment-goals",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["title", "description", "targetAmount", "dueDate", "categoryId", "subcategoryId"]),
      schema: { body: goalBodySchema },
    },
    async (request, reply) => {
      try {
        const item = await options.investmentGoalsService.createGoal(request.currentUser!.id, request.currentWalletId!, request.body);
        return reply.code(201).send(item);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Params: GoalParams }>(
    "/investment-goals/:goalId",
    { preHandler: [app.authenticate, app.resolveWalletContext], schema: { params: { type: "object", required: ["goalId"], properties: { goalId: uuidSchema } } } },
    async (request, reply) => {
      try {
        return reply.code(200).send(await options.investmentGoalsService.getGoal(request.currentUser!.id, request.currentWalletId!, request.params.goalId));
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.put<{ Params: GoalParams; Body: InvestmentGoalInput }>(
    "/investment-goals/:goalId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["title", "description", "targetAmount", "dueDate", "categoryId", "subcategoryId"]),
      schema: {
        params: { type: "object", required: ["goalId"], properties: { goalId: uuidSchema } },
        body: goalBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const item = await options.investmentGoalsService.updateGoal(request.currentUser!.id, request.currentWalletId!, request.params.goalId, request.body);
        return reply.code(200).send(item);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: GoalParams }>(
    "/investment-goals/:goalId/close",
    { preHandler: [app.authenticate, app.resolveWalletContext], schema: { params: { type: "object", required: ["goalId"], properties: { goalId: uuidSchema } } } },
    async (request, reply) => {
      try {
        return reply.code(200).send(await options.investmentGoalsService.closeGoal(request.currentUser!.id, request.currentWalletId!, request.params.goalId));
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.get<{ Params: GoalParams }>(
    "/investment-goals/:goalId/contributions",
    { preHandler: [app.authenticate, app.resolveWalletContext], schema: { params: { type: "object", required: ["goalId"], properties: { goalId: uuidSchema } } } },
    async (request, reply) => {
      try {
        const items = await options.investmentGoalsService.listContributions(request.currentUser!.id, request.currentWalletId!, request.params.goalId);
        return reply.code(200).send({ items });
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.post<{ Params: GoalParams; Body: InvestmentContributionInput }>(
    "/investment-goals/:goalId/contributions",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["amount", "date", "description"]),
      schema: {
        params: { type: "object", required: ["goalId"], properties: { goalId: uuidSchema } },
        body: contributionBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const item = await options.investmentGoalsService.createContribution(request.currentUser!.id, request.currentWalletId!, request.params.goalId, request.body);
        return reply.code(201).send(item);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.put<{ Params: ContributionParams; Body: InvestmentContributionInput }>(
    "/investment-goals/:goalId/contributions/:contributionId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["amount", "date", "description"]),
      schema: {
        params: { type: "object", required: ["goalId", "contributionId"], properties: { goalId: uuidSchema, contributionId: uuidSchema } },
        body: contributionBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const item = await options.investmentGoalsService.updateContribution(
          request.currentUser!.id,
          request.currentWalletId!,
          request.params.goalId,
          request.params.contributionId,
          request.body,
        );
        return reply.code(200).send(item);
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );

  app.delete<{ Params: ContributionParams }>(
    "/investment-goals/:goalId/contributions/:contributionId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      schema: {
        params: { type: "object", required: ["goalId", "contributionId"], properties: { goalId: uuidSchema, contributionId: uuidSchema } },
      },
    },
    async (request, reply) => {
      try {
        await options.investmentGoalsService.deleteContribution(request.currentUser!.id, request.currentWalletId!, request.params.goalId, request.params.contributionId);
        return reply.code(204).send();
      } catch (error) {
        return sendError(error, reply);
      }
    },
  );
}
