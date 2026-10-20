import Fastify, { type FastifyError, type FastifyInstance } from "fastify";
import type { Database } from "./database.js";
import { AuthService } from "./auth/auth.service.js";
import { UnconfiguredEmailSender } from "./auth/email-sender.js";
import { PostgresAuthRepository } from "./auth/postgres-auth.repository.js";
import { registerAuthRoutes } from "./auth/auth.routes.js";
import type { AuthConfiguration, AuthRepository, EmailSender } from "./auth/auth.types.js";

export interface AppOptions {
  logger?: boolean;
  emailSender?: EmailSender;
  authRepository?: AuthRepository;
  authConfiguration?: Partial<AuthConfiguration>;
  secureCookies?: boolean;
}

export function createApp(
  database: Database,
  options: AppOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });

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

  return app;
}
