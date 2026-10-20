import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { PaymentMethodError } from "./payment-methods.errors.js";
import type { PaymentMethodsService } from "./payment-methods.service.js";
import { PAYMENT_METHOD_NATURES, type PaymentMethodNature } from "./payment-methods.types.js";

interface RouteOptions { paymentMethodsService: PaymentMethodsService }
interface PaymentMethodParams { paymentMethodId: string }
interface CreatePaymentMethodBody { name: string; nature: PaymentMethodNature }
interface UpdatePaymentMethodBody { name?: string; nature?: PaymentMethodNature; isActive?: boolean }

const uuidSchema = { type: "string", pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$" };
const nameSchema = { type: "string", minLength: 1, maxLength: 100 };

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof PaymentMethodError) return reply.code(error.statusCode).send({ message: error.message });
  return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
}

function rejectUnexpectedProperties(allowedProperties: string[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const value = request.body;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return;
    if (Object.keys(value).some((key) => !allowedProperties.includes(key))) return reply.code(400).send({ message: "Os dados enviados são inválidos." });
  };
}

export function registerPaymentMethodRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.get("/payment-methods", { preHandler: [app.authenticate, app.resolveWalletContext] }, async (request, reply) => {
    try {
      const items = await options.paymentMethodsService.list(request.currentUser!.id, request.currentWalletId!);
      return reply.code(200).send({ items });
    } catch (error) { return sendError(error, reply); }
  });

  app.post<{ Body: CreatePaymentMethodBody }>("/payment-methods", {
    preHandler: [app.authenticate, app.resolveWalletContext],
    preValidation: rejectUnexpectedProperties(["name", "nature"]),
    schema: { body: { type: "object", additionalProperties: false, required: ["name", "nature"], properties: { name: nameSchema, nature: { type: "string", enum: [...PAYMENT_METHOD_NATURES] } } } },
  }, async (request, reply) => {
    try {
      const item = await options.paymentMethodsService.create(request.currentUser!.id, request.currentWalletId!, request.body.name, request.body.nature);
      return reply.code(201).send(item);
    } catch (error) { return sendError(error, reply); }
  });

  app.patch<{ Params: PaymentMethodParams; Body: UpdatePaymentMethodBody }>("/payment-methods/:paymentMethodId", {
    preHandler: [app.authenticate, app.resolveWalletContext],
    preValidation: rejectUnexpectedProperties(["name", "nature", "isActive"]),
    schema: {
      params: { type: "object", required: ["paymentMethodId"], properties: { paymentMethodId: uuidSchema } },
      body: { type: "object", additionalProperties: false, minProperties: 1, properties: { name: nameSchema, nature: { type: "string", enum: [...PAYMENT_METHOD_NATURES] }, isActive: { type: "boolean" } } },
    },
  }, async (request, reply) => {
    try {
      const item = await options.paymentMethodsService.update(request.currentUser!.id, request.currentWalletId!, request.params.paymentMethodId, request.body);
      return reply.code(200).send(item);
    } catch (error) { return sendError(error, reply); }
  });
}
