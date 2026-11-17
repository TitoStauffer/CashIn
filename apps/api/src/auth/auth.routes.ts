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
  inviteToken?: string;
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
    currentWalletId: string | null;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    resolveWalletContext: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,}$/;
const BEARER_PATTERN = /^Bearer ([^\s]+)$/i;

// The session token travels in one of two places: the HttpOnly cookie, set for the browser, or the
// `Authorization: Bearer` header, sent by native clients such as the mobile app, which keep the token
// in the device's secure storage. When the header is present it is the only source considered, even
// when it is malformed: falling back to a cookie would let a request authenticate as a session other
// than the one it names.
function getSessionToken(request: FastifyRequest): string | null {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) return bearerToken(authorization);
  return cookieToken(request.headers.cookie);
}

function bearerToken(authorization: string): string | null {
  const token = BEARER_PATTERN.exec(authorization)?.[1];
  return token !== undefined && SESSION_TOKEN_PATTERN.test(token) ? token : null;
}

function cookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;

  const sessionCookie = cookieHeader
    .split(";")
    .map((cookie) => cookie.trim())
    .find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  if (!sessionCookie) return null;

  const token = sessionCookie.slice(SESSION_COOKIE_NAME.length + 1);
  return SESSION_TOKEN_PATTERN.test(token) ? token : null;
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
            inviteToken: { type: "string", minLength: 40, maxLength: 128, pattern: "^[A-Za-z0-9_-]+$" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        await options.authService.register(request.body.email, request.body.password, request.body.inviteToken);
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

  // One budget per IP for both ways of logging in: a separate limiter for the token login would double
  // the attempts an attacker gets against a password.
  const loginRouteOptions = {
    preHandler: async (request: FastifyRequest, reply: FastifyReply) => {
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
  };

  app.post<{ Body: LoginBody }>(
    "/auth/login",
    loginRouteOptions,
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

  // The login for native clients: the same session as `/auth/login`, but the token comes back in the
  // body, for the client to keep in secure storage and send as `Authorization: Bearer`. No cookie is
  // set, and the browser login never returns the token in its body. `no-store` keeps the response,
  // which is a credential, out of any cache between the client and the API.
  app.post<{ Body: LoginBody }>("/auth/token", loginRouteOptions, async (request, reply) => {
    try {
      const session = await options.authService.login(request.body.email, request.body.password);
      reply.header("Cache-Control", "no-store");
      return reply.code(200).send({
        user: session.user,
        token: session.token,
        expiresAt: session.expiresAt.toISOString(),
      });
    } catch (error) {
      return handleAuthError(error, reply);
    }
  });

  app.get("/auth/me",{ preHandler: app.authenticate }, async (request) => ({
    user: request.currentUser,
  }));

  app.post("/auth/logout", async (request, reply) => {
    const token = getSessionToken(request);
    try {
      // With the header, the logout acts on the bearer session only, and a success means that session
      // existed and is now gone. A header that resolves no session (malformed, unknown, expired or
      // already ended) ends nothing, so it gets a 401. And the cookie is never cleared on this path: a
      // cookie session next to the header is not the one being ended, and clearing it would tell the
      // browser it logged out while that session stays open on the server.
      if (request.headers.authorization !== undefined) {
        if (token === null || !(await options.authService.getUserForSession(token))) {
          return reply.code(401).send({ message: "Autenticação necessária." });
        }
        await options.authService.logout(token);
        return reply.code(204).send();
      }

      // Without the header, the browser logout is unchanged: idempotent, and the cookie is cleared.
      await options.authService.logout(token);
      reply.header("Set-Cookie", clearSessionCookie(options.secureCookies));
      return reply.code(204).send();
    } catch {
      return handleAuthError(new Error("Logout failed"), reply);
    }
  });
}
