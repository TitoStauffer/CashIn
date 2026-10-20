import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ExpenseError } from "./expenses.errors.js";
import type { ExpensesService } from "./expenses.service.js";
import type { ExpenseInput } from "./expenses.types.js";
import { MONEY_AMOUNT_PATTERN } from "../shared/money.js";

interface RouteOptions {
  expensesService: ExpensesService;
}

interface ExpenseParams {
  expenseId: string;
}

interface ExpenseQuery {
  from?: string;
  to?: string;
}

const uuidSchema = {
  type: "string",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
};

const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const expenseBodySchema = {
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

function sendExpenseError(error: unknown, reply: FastifyReply) {
  if (error instanceof ExpenseError) {
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

export function registerExpenseRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.get<{ Querystring: ExpenseQuery }>(
    "/expenses",
    {
      preHandler: app.authenticate,
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
        const items = await options.expensesService.listExpenses(
          request.currentUser!.id,
          request.query.from,
          request.query.to,
        );
        return reply.code(200).send({ items });
      } catch (error) {
        return sendExpenseError(error, reply);
      }
    },
  );

  app.post<{ Body: ExpenseInput }>(
    "/expenses",
    {
      preHandler: app.authenticate,
      preValidation: rejectUnexpectedProperties(["amount", "date", "description", "categoryId", "subcategoryId"]),
      schema: { body: expenseBodySchema },
    },
    async (request, reply) => {
      try {
        const item = await options.expensesService.createExpense(request.currentUser!.id, request.body);
        return reply.code(201).send(item);
      } catch (error) {
        return sendExpenseError(error, reply);
      }
    },
  );

  app.put<{ Params: ExpenseParams; Body: ExpenseInput }>(
    "/expenses/:expenseId",
    {
      preHandler: app.authenticate,
      preValidation: rejectUnexpectedProperties(["amount", "date", "description", "categoryId", "subcategoryId"]),
      schema: {
        params: { type: "object", required: ["expenseId"], properties: { expenseId: uuidSchema } },
        body: expenseBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const item = await options.expensesService.updateExpense(
          request.currentUser!.id,
          request.params.expenseId,
          request.body,
        );
        return reply.code(200).send(item);
      } catch (error) {
        return sendExpenseError(error, reply);
      }
    },
  );

  app.delete<{ Params: ExpenseParams }>(
    "/expenses/:expenseId",
    {
      preHandler: app.authenticate,
      schema: { params: { type: "object", required: ["expenseId"], properties: { expenseId: uuidSchema } } },
    },
    async (request, reply) => {
      try {
        await options.expensesService.deleteExpense(request.currentUser!.id, request.params.expenseId);
        return reply.code(204).send();
      } catch (error) {
        return sendExpenseError(error, reply);
      }
    },
  );
}
