import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { CreditCardError } from "./credit-cards.errors.js";
import type { CreditCardsService } from "./credit-cards.service.js";

interface RouteOptions { creditCardsService: CreditCardsService }
interface CardParams { creditCardId: string }
interface StatementParams extends CardParams { statementId: string }
interface CardQuery { from?: string; to?: string }
interface CardBody { nickname: string; closingDay: number; dueDay: number }
interface CardPatch { nickname?: string; closingDay?: number; dueDay?: number; isActive?: boolean }
interface PayBody { date: string }

const uuidSchema = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
const daySchema = { type: "integer", minimum: 1, maximum: 31 };

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof CreditCardError) return reply.code(error.statusCode).send({ message: error.message });
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

const cardParamsSchema = {
  type: "object",
  required: ["creditCardId"],
  properties: { creditCardId: uuidSchema },
};

export function registerCreditCardRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.get("/credit-cards", { preHandler: [app.authenticate, app.resolveWalletContext] }, async (request, reply) => {
    try {
      const items = await options.creditCardsService.list(request.currentWalletId!);
      return reply.code(200).send({ items });
    } catch (error) { return sendError(error, reply); }
  });

  app.post<{ Body: CardBody }>("/credit-cards", {
    preHandler: [app.authenticate, app.resolveWalletContext],
    preValidation: rejectUnexpectedProperties(["nickname", "closingDay", "dueDay"]),
    schema: {
      body: {
        type: "object", additionalProperties: false, required: ["nickname", "closingDay", "dueDay"],
        properties: { nickname: { type: "string", minLength: 1, maxLength: 100 }, closingDay: daySchema, dueDay: daySchema },
      },
    },
  }, async (request, reply) => {
    try {
      const item = await options.creditCardsService.create(request.currentWalletId!, request.body);
      return reply.code(201).send(item);
    } catch (error) { return sendError(error, reply); }
  });

  app.patch<{ Params: CardParams; Body: CardPatch }>("/credit-cards/:creditCardId", {
    preHandler: [app.authenticate, app.resolveWalletContext],
    preValidation: rejectUnexpectedProperties(["nickname", "closingDay", "dueDay", "isActive"]),
    schema: {
      params: cardParamsSchema,
      body: {
        type: "object", additionalProperties: false, minProperties: 1,
        properties: { nickname: { type: "string", minLength: 1, maxLength: 100 }, closingDay: daySchema, dueDay: daySchema, isActive: { type: "boolean" } },
      },
    },
  }, async (request, reply) => {
    try {
      const item = await options.creditCardsService.update(request.currentWalletId!, request.params.creditCardId, request.body);
      return reply.code(200).send(item);
    } catch (error) { return sendError(error, reply); }
  });

  app.get<{ Params: CardParams; Querystring: CardQuery }>("/credit-cards/:creditCardId/statements", {
    preHandler: [app.authenticate, app.resolveWalletContext],
    preValidation: rejectUnexpectedQueryProperties(["from", "to"]),
    schema: {
      params: cardParamsSchema,
      querystring: { type: "object", additionalProperties: false, properties: { from: dateSchema, to: dateSchema } },
    },
  }, async (request, reply) => {
    try {
      const items = await options.creditCardsService.listStatements(
        request.currentWalletId!, request.params.creditCardId, request.query.from, request.query.to,
      );
      return reply.code(200).send({ items });
    } catch (error) { return sendError(error, reply); }
  });

  app.post<{ Params: StatementParams; Body: PayBody }>("/credit-cards/:creditCardId/statements/:statementId/pay", {
    preHandler: [app.authenticate, app.resolveWalletContext],
    preValidation: rejectUnexpectedProperties(["date"]),
    schema: {
      params: {
        type: "object", required: ["creditCardId", "statementId"],
        properties: { creditCardId: uuidSchema, statementId: uuidSchema },
      },
      body: { type: "object", additionalProperties: false, required: ["date"], properties: { date: dateSchema } },
    },
  }, async (request, reply) => {
    try {
      const item = await options.creditCardsService.payStatement(
        request.currentWalletId!, request.params.creditCardId, request.params.statementId, request.body.date,
      );
      return reply.code(200).send(item);
    } catch (error) { return sendError(error, reply); }
  });
}
