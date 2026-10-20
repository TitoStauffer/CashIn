import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AuthError } from "./auth.errors.js";
import type { AuthService } from "./auth.service.js";
import type { AuthUser } from "./auth.types.js";
import { InMemoryRateLimiter } from "./rate-limiter.js";

export const SESSION_COOKIE_NAME = "cashin_session";

interface AuthRouteOptions {
  authService: AuthService;
  secureCookies: boolean;
}

interface RegisterBody {
  email: string;
  password: string;
}

interface VerifyBody {
  token: string;
}

interface LoginBody {
  email: string;
  password: string;
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser: AuthUser | null;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

function getSessionToken(request: FastifyRequest): string | null {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) return null;

  const sessionCookie = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!sessionCookie) return null;

  const token = sessionCookie.slice(SESSION_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{40,}$/.test(token) ? token : null;
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const secureAttribute = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secureAttribute}`;
}

function clearSessionCookie(secure: boolean): string {
  const secureAttribute = secure ? "; Secure" : "";
  return `${SESSION_COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secureAttribute}`;
}

function handleAuthError(error: unknown, reply: FastifyReply) {
  if (error instanceof AuthError) {
    return reply.code(error.statusCode).send({ message: error.message });
  }
  return reply.code(500).send({ message: "Não foi possível concluir a solicitação." });
}

export function registerAuthRoutes(app: FastifyInstance, options: AuthRouteOptions): void {
  const registrationRateLimiter = new InMemoryRateLimiter({ maxRequests: 5, windowMs: 15 * 60 * 1000 });
  const loginRateLimiter = new InMemoryRateLimiter({ maxRequests: 10, windowMs: 15 * 60 * 1000 });

  app.decorateRequest("currentUser", null);
  app.decorate("authenticate", async (request, reply) => {
    const token = getSessionToken(request);
    const user = token ? await options.authService.getUserForSession(token) : null;
    if (!user) {
      reply.code(401).send({ message: "Autenticação necessária." });
      return;
    }
    request.currentUser = user;
  });

  app.post<{ Body: RegisterBody }>(
    "/auth/register",
    {
      preHandler: async (request, reply) => {
        const decision = registrationRateLimiter.consume(request.ip);
        if (!decision.allowed) {
          reply.header("Retry-After", decision.retryAfterSeconds);
          return reply.code(429).send({
            message: "Muitas tentativas de cadastro. Aguarde alguns minutos e tente novamente.",
          });
        }
      },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            password: { type: "string", minLength: 8, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        await options.authService.register(request.body.email, request.body.password);
        return reply.code(202).send({
          message: "Email enviado, favor confirmar seu cadastro",
        });
      } catch (error) {
        return handleAuthError(error, reply);
      }
    },
  );

  app.post<{ Body: VerifyBody }>(
    "/auth/verify-email",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["token"],
          properties: { token: { type: "string", minLength: 40, maxLength: 128 } },
        },
      },
    },
    async (request, reply) => {
      try {
        await options.authService.verifyEmail(request.body.token);
        return reply.code(200).send({ message: "E-mail confirmado com sucesso." });
      } catch (error) {
        return handleAuthError(error, reply);
      }
    },
  );

  app.post<{ Body: LoginBody }>(
    "/auth/login",
    {
      preHandler: async (request, reply) => {
        const decision = loginRateLimiter.consume(request.ip);
        if (!decision.allowed) {
          reply.header("Retry-After", decision.retryAfterSeconds);
          return reply.code(429).send({
            message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
          });
        }
      },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: { type: "string", format: "email", maxLength: 320 },
            password: { type: "string", minLength: 1, maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const session = await options.authService.login(request.body.email, request.body.password);
        const maxAge = Math.floor((session.expiresAt.getTime() - Date.now()) / 1000);
        reply.header("Set-Cookie", sessionCookie(session.token, maxAge, options.secureCookies));
        return reply.code(200).send({ user: session.user });
      } catch (error) {
        return handleAuthError(error, reply);
      }
    },
  );

  app.get("/auth/me", { preHandler: app.authenticate }, async (request) => ({
    user: request.currentUser,
  }));

  app.post("/auth/logout", async (request, reply) => {
    try {
      await options.authService.logout(getSessionToken(request));
      reply.header("Set-Cookie", clearSessionCookie(options.secureCookies));
      return reply.code(204).send();
    } catch {
      return handleAuthError(new Error("Logout failed"), reply);
    }
  });
}
