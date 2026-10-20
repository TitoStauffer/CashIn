import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { FinancialSummaryError } from "./financial-summary.errors.js";
import type { FinancialSummaryService } from "./financial-summary.service.js";

interface RouteOptions { financialSummaryService: FinancialSummaryService }
interface SummaryQuery { from?: string; to?: string }
const dateSchema = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };

function rejectUnexpectedQueryProperties(allowedProperties: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.query;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    if (Object.keys(value).some((key) => !allowedProperties.includes(key))) {
      return reply.code(400).send({ message: "Os parâmetros enviados são inválidos." });
    }
  };
}

export function registerFinancialSummaryRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.get<{ Querystring: SummaryQuery }>(
    "/financial-summary",
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
        const summary = await options.financialSummaryService.getSummary(
          request.currentUser!.id,
          request.query.from,
          request.query.to,
        );
        return reply.code(200).send(summary);
      } catch (error) {
        if (error instanceof FinancialSummaryError) {
          return reply.code(error.statusCode).send({ message: error.message });
        }
        return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
      }
    },
  );
}
