import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { IncomeError } from "./incomes.errors.js";
import type { IncomesService } from "./incomes.service.js";
import type { IncomeInput } from "./incomes.types.js";
import { MONEY_AMOUNT_PATTERN } from "../shared/money.js";

interface RouteOptions {
  incomesService: IncomesService;
}

interface IncomeParams {
  incomeId: string;
}

interface IncomeQuery {
  from?: string;
  to?: string;
}

const uuidSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
};

const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const incomeBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["amount", "date", "categoryId"],
  properties: {
    amount: { type: "string", minLength: 1, maxLength: 15, pattern: MONEY_AMOUNT_PATTERN },
    date: dateSchema,
    description: { anyOf: [{ type: "string" }, { type: "null" }] },
    categoryId: uuidSchema,
    subcategoryId: { anyOf: [uuidSchema, { type: "null" }] },
  },
};

function sendIncomeError(error: unknown, reply: FastifyReply) {
  if (error instanceof IncomeError) {
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

function rejectUnexpectedQueryProperties(allowedProperties: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.query;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    if (Object.keys(value).some((key) => !allowedProperties.includes(key))) {
      return reply.code(400).send({ message: "Os parâmetros enviados são inválidos." });
    }
  };
}

export function registerIncomeRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.get<{ Querystring: IncomeQuery }>(
    "/incomes",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedQueryProperties(["from", "to"]),
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { from: dateSchema, to: dateSchema },
        },
      },
    },
    async (request, reply) => {
      try {
        const items = await options.incomesService.listIncomes(
          request.currentUser!.id,
          request.currentWalletId!,
          request.query.from,
          request.query.to,
        );
        return reply.code(200).send({ items });
      } catch (error) {
        return sendIncomeError(error, reply);
      }
    },
  );

  app.post<{ Body: IncomeInput }>(
    "/incomes",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["amount", "date", "description", "categoryId", "subcategoryId"]),
      schema: { body: incomeBodySchema },
    },
    async (request, reply) => {
      try {
        const item = await options.incomesService.createIncome(request.currentUser!.id, request.currentWalletId!, request.body);
        return reply.code(201).send(item);
      } catch (error) {
        return sendIncomeError(error, reply);
      }
    },
  );

  app.put<{ Params: IncomeParams; Body: IncomeInput }>(
    "/incomes/:incomeId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      preValidation: rejectUnexpectedProperties(["amount", "date", "description", "categoryId", "subcategoryId"]),
      schema: {
        params: { type: "object", required: ["incomeId"], properties: { incomeId: uuidSchema } },
        body: incomeBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const item = await options.incomesService.updateIncome(
          request.currentUser!.id,
          request.currentWalletId!,
          request.params.incomeId,
          request.body,
        );
        return reply.code(200).send(item);
      } catch (error) {
        return sendIncomeError(error, reply);
      }
    },
  );

  app.delete<{ Params: IncomeParams }>(
    "/incomes/:incomeId",
    {
      preHandler: [app.authenticate, app.resolveWalletContext],
      schema: { params: { type: "object", required: ["incomeId"], properties: { incomeId: uuidSchema } } },
    },
    async (request, reply) => {
      try {
        await options.incomesService.deleteIncome(request.currentUser!.id, request.currentWalletId!, request.params.incomeId);
        return reply.code(204).send();
      } catch (error) {
        return sendIncomeError(error, reply);
      }
    },
  );
}
