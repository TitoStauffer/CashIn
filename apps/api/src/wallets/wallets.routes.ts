import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { WalletError } from "./wallets.errors.js";
import type { WalletsService } from "./wallets.service.js";

interface RouteOptions {
  walletsService: WalletsService;
}

interface CreateWalletBody {
  name: string;
}

function sendWalletError(error: unknown, reply: FastifyReply) {
  if (error instanceof WalletError) return reply.code(error.statusCode).send({ message: error.message });
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

export function registerWalletRoutes(app: FastifyInstance, options: RouteOptions): void {
  app.get("/wallets", { preHandler: app.authenticate }, async (request, reply) => {
    try {
      const items = await options.walletsService.listWallets(request.currentUser!.id);
      return reply.code(200).send({ items });
    } catch (error) {
      return sendWalletError(error, reply);
    }
  });

  app.post<{ Body: CreateWalletBody }>("/wallets", {
    preHandler: app.authenticate,
    preValidation: rejectUnexpectedProperties(["name"]),
    schema: {
      body: {
        type: "object",
        additionalProperties: false,
        required: ["name"],
        properties: { name: { type: "string", minLength: 1, maxLength: 100 } },
      },
    },
  }, async (request, reply) => {
    try {
      const wallet = await options.walletsService.createWallet(request.currentUser!.id, request.body.name);
      return reply.code(201).send(wallet);
    } catch (error) {
      return sendWalletError(error, reply);
    }
  });
}
