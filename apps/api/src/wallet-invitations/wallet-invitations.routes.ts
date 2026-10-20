import type { FastifyInstance, FastifyReply } from "fastify";
import { WalletInvitationError } from "./wallet-invitations.errors.js";
import type { WalletInvitationsService } from "./wallet-invitations.service.js";
import { InMemoryRateLimiter } from "../auth/rate-limiter.js";

interface RouteOptions {
  walletInvitationsService: WalletInvitationsService;
}

interface WalletParams { walletId: string }
interface InvitationParams extends WalletParams { inviteId: string }
interface MemberParams extends WalletParams { userId: string }
interface CreateInvitationBody { email: string }
interface AcceptInvitationBody { token: string }

function sendError(error: unknown, reply: FastifyReply) {
  if (error instanceof WalletInvitationError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
}

const uuidSchema = { type: "string", format: "uuid" } as const;

export function registerWalletInvitationRoutes(app: FastifyInstance, options: RouteOptions): void {
  const inviteRateLimiter = new InMemoryRateLimiter({ maxRequests: 10, windowMs: 15 * 60 * 1000 });
  app.get<{ Params: WalletParams }>("/wallets/:walletId/invites", {
    preHandler: app.authenticate,
    schema: { params: { type: "object", required: ["walletId"], properties: { walletId: uuidSchema } } },
  }, async (request, reply) => {
    try {
      const items = await options.walletInvitationsService.listInvitations(
        request.params.walletId,
        request.currentUser!.id,
      );
      return reply.code(200).send({ items });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Params: WalletParams; Body: CreateInvitationBody }>("/wallets/:walletId/invites", {
    preHandler: [app.authenticate, async (request, reply) => {
      const decision = inviteRateLimiter.consume(request.currentUser!.id);
      if (!decision.allowed) {
        reply.header("Retry-After", decision.retryAfterSeconds);
        return reply.code(429).send({ message: "Muitos convites enviados. Aguarde alguns minutos e tente novamente." });
      }
    }],
    schema: {
      params: { type: "object", required: ["walletId"], properties: { walletId: uuidSchema } },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["email"],
        properties: { email: { type: "string", format: "email", maxLength: 320 } },
      },
    },
  }, async (request, reply) => {
    try {
      const invitation = await options.walletInvitationsService.createInvitation(
        request.params.walletId,
        request.currentUser!.id,
        request.body.email,
      );
      return reply.code(202).send({
        invitation,
        message: "Convite registrado. O e-mail será enviado em instantes.",
      });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.delete<{ Params: InvitationParams }>("/wallets/:walletId/invites/:inviteId", {
    preHandler: app.authenticate,
    schema: {
      params: {
        type: "object",
        required: ["walletId", "inviteId"],
        properties: { walletId: uuidSchema, inviteId: uuidSchema },
      },
    },
  }, async (request, reply) => {
    try {
      await options.walletInvitationsService.cancelInvitation(
        request.params.walletId,
        request.currentUser!.id,
        request.params.inviteId,
      );
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.get<{ Params: WalletParams }>("/wallets/:walletId/members", {
    preHandler: app.authenticate,
    schema: { params: { type: "object", required: ["walletId"], properties: { walletId: uuidSchema } } },
  }, async (request, reply) => {
    try {
      const items = await options.walletInvitationsService.listMembers(
        request.params.walletId,
        request.currentUser!.id,
      );
      return reply.code(200).send({ items });
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.delete<{ Params: MemberParams }>("/wallets/:walletId/members/:userId", {
    preHandler: app.authenticate,
    schema: {
      params: {
        type: "object",
        required: ["walletId", "userId"],
        properties: { walletId: uuidSchema, userId: uuidSchema },
      },
    },
  }, async (request, reply) => {
    try {
      await options.walletInvitationsService.removeMember(
        request.params.walletId,
        request.currentUser!.id,
        request.params.userId,
      );
      return reply.code(204).send();
    } catch (error) {
      return sendError(error, reply);
    }
  });

  app.post<{ Body: AcceptInvitationBody }>("/wallet-invitations/accept", {
    preHandler: app.authenticate,
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["token"],
        properties: { token: { type: "string", minLength: 40, maxLength: 128 } },
      },
    },
  }, async (request, reply) => {
    try {
      const wallet = await options.walletInvitationsService.acceptInvitation(
        request.body.token,
        request.currentUser!.id,
        request.currentUser!.email,
      );
      return reply.code(200).send({ wallet, message: "Convite aceito com sucesso." });
    } catch (error) {
      return sendError(error, reply);
    }
  });
}
