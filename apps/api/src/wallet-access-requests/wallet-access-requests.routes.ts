import type { FastifyInstance, FastifyReply } from "fastify";
import { InMemoryRateLimiter } from "../auth/rate-limiter.js";
import { WalletAccessRequestError } from "./wallet-access-requests.errors.js";
import type { WalletAccessRequestsService } from "./wallet-access-requests.service.js";

interface RouteOptions {
  walletAccessRequestsService: WalletAccessRequestsService;
  requestRateLimit?: { maxRequests: number; windowMs: number };
}

interface WalletParams { walletId: string }
interface AccessRequestParams extends WalletParams { requestId: string }
interface SubmitRequestBody { token: string; email: string }

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof WalletAccessRequestError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
}

const uuidSchema = { type: "string", format: "uuid" } as const;

export function registerWalletAccessRequestRoutes(app: FastifyInstance, options: RouteOptions): void {
  const requestRateLimiter = new InMemoryRateLimiter(options.requestRateLimit ?? { maxRequests: 5, windowMs: 15 * 60 * 1000 });

  app.post<{ Params: WalletParams }>("/wallets/:walletId/access-links", {
    preHandler: app.authenticate,
    schema: { params: { type: "object", required: ["walletId"], properties: { walletId: uuidSchema } } },
  }, async (request, reply) => {
    try {
      const link = await options.walletAccessRequestsService.createLink(request.params.walletId, request.currentUser!.id);
      return reply.code(201).send({ link });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Body: SubmitRequestBody }>("/wallet-access-requests", {
    preHandler: async (request, reply) => {
      const decision = requestRateLimiter.consume(request.ip);
      if (!decision.allowed) {
        reply.header("Retry-After", decision.retryAfterSeconds);
        return reply.code(429).send({ message: "Muitas solicitações. Aguarde alguns minutos e tente novamente." });
      }
    },
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["token", "email"],
        properties: {
          token: { type: "string", minLength: 40, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
          email: { type: "string", format: "email", maxLength: 320 },
        },
      },
    },
  }, async (request, reply) => {
    try {
      await options.walletAccessRequestsService.submitRequest(request.body.token, request.body.email);
      return reply.code(202).send({ message: "Se o link for válido, a solicitação será encaminhada ao responsável pela carteira." });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.get<{ Params: WalletParams }>("/wallets/:walletId/access-requests", {
    preHandler: app.authenticate,
    schema: { params: { type: "object", required: ["walletId"], properties: { walletId: uuidSchema } } },
  }, async (request, reply) => {
    try {
      const items = await options.walletAccessRequestsService.listRequests(request.params.walletId, request.currentUser!.id);
      return reply.code(200).send({ items });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Params: AccessRequestParams }>("/wallets/:walletId/access-requests/:requestId/approve", {
    preHandler: app.authenticate,
    schema: {
      params: {
        type: "object",
        required: ["walletId", "requestId"],
        properties: { walletId: uuidSchema, requestId: uuidSchema },
      },
    },
  }, async (request, reply) => {
    try {
      const accessRequest = await options.walletAccessRequestsService.approveRequest(
        request.params.walletId,
        request.currentUser!.id,
        request.params.requestId,
      );
      return reply.code(200).send({
        request: accessRequest,
        message: "Solicitação aprovada. Um convite de aceite será enviado ao e-mail informado.",
      });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Params: AccessRequestParams }>("/wallets/:walletId/access-requests/:requestId/reject", {
    preHandler: app.authenticate,
    schema: {
      params: {
        type: "object",
        required: ["walletId", "requestId"],
        properties: { walletId: uuidSchema, requestId: uuidSchema },
      },
    },
  }, async (request, reply) => {
    try {
      await options.walletAccessRequestsService.rejectRequest(request.params.walletId, request.currentUser!.id, request.params.requestId);
      return reply.code(200).send({ message: "Solicitação recusada." });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.delete<{ Params: AccessRequestParams }>("/wallets/:walletId/access-requests/:requestId", {
    preHandler: app.authenticate,
    schema: {
      params: {
        type: "object",
        required: ["walletId", "requestId"],
        properties: { walletId: uuidSchema, requestId: uuidSchema },
      },
    },
  }, async (request, reply) => {
    try {
      await options.walletAccessRequestsService.cancelRequest(request.params.walletId, request.currentUser!.id, request.params.requestId);
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });
}
