import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { Database, QueryExecutor } from "../database.js";
import type { AuthRepository, AuthUser, StoredUser } from "./auth.types.js";

interface VerificationRecord {
  userId: string;
  expiresAt: Date;
  usedAt: Date | null;
}

interface SessionRecord {
  userId: string;
  expiresAt: Date;
}

class MemoryAuthRepository implements AuthRepository {
  readonly users = new Map<string, StoredUser>();
  readonly verificationTokens = new Map<string, VerificationRecord>();
  readonly sessions = new Map<string, SessionRecord>();
  private nextId = 1;

  async findUserByEmail(email: string): Promise<StoredUser | null> {
    return [...this.users.values()].find((user) => user.email === email) ?? null;
  }

  async createPendingAccount(
    email: string,
    passwordHash: string,
    verificationTokenHash: string,
    verificationTokenExpiresAt: Date,
  ) {
    if (await this.findUserByEmail(email)) return null;
    const user: StoredUser = {
      id: String(this.nextId++),
      email,
      passwordHash,
      emailVerifiedAt: null,
    };
    this.users.set(user.id, user);
    this.verificationTokens.set(verificationTokenHash, {
      userId: user.id,
      expiresAt: verificationTokenExpiresAt,
      usedAt: null,
    });
    return { user: { id: user.id, email: user.email } };
  }

  async deleteUnverifiedUser(userId: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user?.emailVerifiedAt) this.users.delete(userId);
    for (const [hash, token] of this.verificationTokens) {
      if (token.userId === userId) this.verificationTokens.delete(hash);
    }
  }

  async verifyEmail(tokenHash: string, now: Date): Promise<boolean> {
    const token = this.verificationTokens.get(tokenHash);
    const user = token ? this.users.get(token.userId) : null;
    if (!token || !user || token.usedAt || token.expiresAt <= now || user.emailVerifiedAt) {
      return false;
    }
    token.usedAt = now;
    user.emailVerifiedAt = now;
    return true;
  }

  async createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void> {
    this.sessions.set(tokenHash, { userId, expiresAt });
  }

  async findUserBySession(tokenHash: string, now: Date): Promise<AuthUser | null> {
    const session = this.sessions.get(tokenHash);
    const user = session ? this.users.get(session.userId) : null;
    if (!session || !user || session.expiresAt <= now || !user.emailVerifiedAt) return null;
    return { id: user.id, email: user.email };
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.sessions.delete(tokenHash);
  }
}

function createTestDatabase(): Database {
  const executor: QueryExecutor = {
    query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }),
  };
  return {
    ...executor,
    transaction: async (work) => work(executor),
  };
}

test("registration, one-time verification, login, session lookup, and logout work end to end", async () => {
  const repository = new MemoryAuthRepository();
  const sentMessages: Array<{ email: string; url: string }> = [];
  const app = createApp(createTestDatabase(), {
    authRepository: repository,
    emailSender: {
      sendVerificationEmail: async (email, url) => {
        sentMessages.push({ email, url });
      },
    },
  });

  const registration = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "Person@Example.com", password: "Abcdef1!secure" },
  });
  assert.equal(registration.statusCode, 202);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(registration.json(), {
    message: "Email enviado, favor confirmar seu cadastro",
  });
  assert.equal(registration.body.includes("token"), false);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0]?.email, "person@example.com");

  const confirmationUrl = new URL(sentMessages[0]!.url);
  const token = confirmationUrl.searchParams.get("token");
  assert.ok(token);
  assert.equal(confirmationUrl.pathname, "/verify-email");

  const unconfirmedLogin = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "person@example.com", password: "Abcdef1!secure" },
  });
  assert.equal(unconfirmedLogin.statusCode, 401);
  assert.deepEqual(unconfirmedLogin.json(), { message: "E-mail ou senha inválidos." });

  const verification = await app.inject({
    method: "POST",
    url: "/auth/verify-email",
    payload: { token },
  });
  assert.equal(verification.statusCode, 200);

  const repeatedVerification = await app.inject({
    method: "POST",
    url: "/auth/verify-email",
    payload: { token },
  });
  assert.equal(repeatedVerification.statusCode, 400);

  const login = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email: "PERSON@example.com", password: "Abcdef1!secure" },
  });
  assert.equal(login.statusCode, 200);
  const sessionCookie = login.headers["set-cookie"];
  assert.ok(sessionCookie);
  assert.match(String(sessionCookie), /HttpOnly/);
  assert.match(String(sessionCookie), /SameSite=Lax/);
  assert.doesNotMatch(String(sessionCookie), /Secure/);
  assert.deepEqual(login.json(), {
    user: { id: "1", email: "person@example.com" },
  });

  const cookieHeader = String(sessionCookie).split(";")[0];
  const currentUser = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieHeader } });
  assert.equal(currentUser.statusCode, 200);
  assert.deepEqual(currentUser.json(), { user: { id: "1", email: "person@example.com" } });

  const logout = await app.inject({
    method: "POST",
    url: "/auth/logout",
    headers: { cookie: cookieHeader },
  });
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers["set-cookie"]), /Max-Age=0/);

  const afterLogout = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: cookieHeader } });
  assert.equal(afterLogout.statusCode, 401);
  await app.close();
});

test("invalid confirmation tokens are rejected and malformed requests use Portuguese errors", async () => {
  const app = createApp(createTestDatabase(), { authRepository: new MemoryAuthRepository() });

  const invalidToken = await app.inject({
    method: "POST",
    url: "/auth/verify-email",
    payload: { token: "a".repeat(43) },
  });
  assert.equal(invalidToken.statusCode, 400);
  assert.deepEqual(invalidToken.json(), { message: "O link de confirmação é inválido ou expirou." });

  const invalidPassword = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "person@example.com", password: "short" },
  });
  assert.equal(invalidPassword.statusCode, 400);
  assert.deepEqual(invalidPassword.json(), { message: "Os dados enviados são inválidos." });

  const weakPassword = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "person@example.com", password: "abcdefgh" },
  });
  assert.equal(weakPassword.statusCode, 400);
  assert.match(weakPassword.json().message, /maiúscula, uma letra minúscula, um número e um caractere especial/);
  await app.close();
});

test("registration responds before email delivery and failed delivery removes pending account", async () => {
  const repository = new MemoryAuthRepository();
  const app = createApp(createTestDatabase(), {
    authRepository: repository,
    emailSender: {
      sendVerificationEmail: async () => {
        throw new Error("provider response containing private details");
      },
    },
  });

  const response = await app.inject({
    method: "POST",
    url: "/auth/register",
    payload: { email: "person@example.com", password: "Abcdef1!secure" },
  });
  assert.equal(response.statusCode, 202);
  assert.equal(response.body.includes("private details"), false);
  assert.equal(response.body.includes("token"), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(repository.users.size, 0);
  await app.close();
});

test("registration limits requests per IP before additional password hashing or email delivery", async () => {
  const repository = new MemoryAuthRepository();
  const sentMessages: string[] = [];
  const app = createApp(createTestDatabase(), {
    authRepository: repository,
    emailSender: {
      sendVerificationEmail: async (email) => {
        sentMessages.push(email);
      },
    },
  });
  const payload = { email: "person@example.com", password: "Abcdef1!secure" };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await app.inject({ method: "POST", url: "/auth/register", payload });
    assert.equal(response.statusCode, 202);
  }

  await new Promise<void>((resolve) => setImmediate(resolve));
  const blockedResponse = await app.inject({ method: "POST", url: "/auth/register", payload });
  assert.equal(blockedResponse.statusCode, 429);
  assert.ok(Number(blockedResponse.headers["retry-after"]) > 0);
  assert.deepEqual(blockedResponse.json(), {
    message: "Muitas tentativas de cadastro. Aguarde alguns minutos e tente novamente.",
  });
  assert.equal(repository.users.size, 1);
  assert.equal(sentMessages.length, 1);
  await app.close();
});

test("login limits attempts by IP temporarily without locking an account", async () => {
  const app = createApp(createTestDatabase(), { authRepository: new MemoryAuthRepository() });
  const payload = { email: "person@example.com", password: "WrongPassword1!" };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const response = await app.inject({ method: "POST", url: "/auth/login", payload });
    assert.equal(response.statusCode, 401);
  }

  const blockedResponse = await app.inject({ method: "POST", url: "/auth/login", payload });
  assert.equal(blockedResponse.statusCode, 429);
  assert.ok(Number(blockedResponse.headers["retry-after"]) > 0);
  assert.deepEqual(blockedResponse.json(), {
    message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
  });

  const otherIpResponse = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload,
    remoteAddress: "203.0.113.10",
  });
  assert.equal(otherIpResponse.statusCode, 401);
  await app.close();
});
