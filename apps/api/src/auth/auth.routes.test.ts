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

test("registration carries a wallet invitation token only into the confirmation link", async () => {
  const sentMessages: Array<{ email: string; url: string }> = [];
  const app = createApp(createTestDatabase(), {
    authRepository: new MemoryAuthRepository(),
    emailSender: {
      sendVerificationEmail: async (email, url) => { sentMessages.push({ email, url }); },
    },
  });

  const inviteToken = "i".repeat(43);
  try {
    const response = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { email: "member@example.com", password: "Abcdef1!secure", inviteToken },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.body.includes(inviteToken), false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const confirmationUrl = new URL(sentMessages[0]!.url);
    assert.equal(confirmationUrl.searchParams.get("invite"), inviteToken);
    assert.ok(confirmationUrl.searchParams.get("token"));
  } finally {
    await app.close();
  }
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

const VERIFIED_PASSWORD = "Abcdef1!secure";

function createAppWithMailbox(repository = new MemoryAuthRepository()) {
  const sentMessages: Array<{ url: string }> = [];
  const app = createApp(createTestDatabase(), {
    authRepository: repository,
    emailSender: { sendVerificationEmail: async (_email, url) => { sentMessages.push({ url }); } },
  });
  return { app, sentMessages, repository };
}

// A verified account created through the real registration and confirmation routes, so the token login
// is exercised against the same password hashing and session creation as the browser login.
async function createVerifiedAccount(app: ReturnType<typeof createApp>, sentMessages: Array<{ url: string }>, email: string) {
  await app.inject({ method: "POST", url: "/auth/register", payload: { email, password: VERIFIED_PASSWORD } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const token = new URL(sentMessages.at(-1)!.url).searchParams.get("token");
  const verification = await app.inject({ method: "POST", url: "/auth/verify-email", payload: { token } });
  assert.equal(verification.statusCode, 200);
}

test("the token login returns the session in the body, without a cookie, and the bearer header authenticates it", async () => {
  const { app, sentMessages, repository } = createAppWithMailbox();
  try {
    await createVerifiedAccount(app, sentMessages, "mobile@example.com");

    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      payload: { email: "MOBILE@example.com", password: VERIFIED_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    assert.equal(login.headers["set-cookie"], undefined);
    assert.equal(login.headers["cache-control"], "no-store");
    const body = login.json() as { user: AuthUser; token: string; expiresAt: string };
    assert.deepEqual(body.user, { id: "1", email: "mobile@example.com" });
    assert.match(body.token, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(body.expiresAt) > Date.now());
    assert.equal(repository.sessions.size, 1);

    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(me.statusCode, 200);
    assert.deepEqual(me.json(), { user: { id: "1", email: "mobile@example.com" } });

    // The scheme is case-insensitive (RFC 9110); the token is not.
    const lowerScheme = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `bearer ${body.token}` } });
    assert.equal(lowerScheme.statusCode, 200);

    const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(logout.statusCode, 204);
    assert.equal(repository.sessions.size, 0);

    const afterLogout = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${body.token}` } });
    assert.equal(afterLogout.statusCode, 401);
    assert.deepEqual(afterLogout.json(), { message: "Autenticação necessária." });
  } finally {
    await app.close();
  }
});

test("the browser login never returns the session token in its body", async () => {
  const { app, sentMessages, repository } = createAppWithMailbox();
  try {
    await createVerifiedAccount(app, sentMessages, "browser@example.com");
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "browser@example.com", password: VERIFIED_PASSWORD },
    });
    assert.equal(login.statusCode, 200);
    const cookieToken = String(login.headers["set-cookie"]).split(";")[0]!.split("=")[1]!;
    assert.equal(repository.sessions.size, 1);
    assert.equal(login.body.includes(cookieToken), false);
    assert.deepEqual(Object.keys(login.json() as object), ["user"]);
  } finally {
    await app.close();
  }
});

test("malformed, unknown and expired bearer tokens are rejected with 401", async () => {
  const { app, sentMessages, repository } = createAppWithMailbox();
  try {
    await createVerifiedAccount(app, sentMessages, "expired@example.com");
    const login = await app.inject({
      method: "POST",
      url: "/auth/token",
      payload: { email: "expired@example.com", password: VERIFIED_PASSWORD },
    });
    const { token } = login.json() as { token: string };

    const rejected = [
      "",
      "Bearer",
      `Bearer ${token} extra`,
      `Basic ${token}`,
      `Token ${token}`,
      `Bearer ${"a".repeat(39)}`,
      `Bearer ${token.slice(0, 20)}!${token.slice(21)}`,
      `Bearer ${"b".repeat(43)}`,
    ];
    for (const authorization of rejected) {
      const response = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization } });
      assert.equal(response.statusCode, 401, `authorization "${authorization}" must be rejected`);
    }

    // The session row is still there, but its expiry has passed.
    for (const session of repository.sessions.values()) session.expiresAt = new Date(Date.now() - 1000);
    const expired = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } });
    assert.equal(expired.statusCode, 401);
  } finally {
    await app.close();
  }
});

// The format check runs before the database: a header that cannot be a session token must not cost a
// session lookup. A 401 alone would not prove it, since an unknown token is refused by the lookup too.
test("bearer values that cannot be a session token never reach the session lookup", async () => {
  const repository = new MemoryAuthRepository();
  let lookups = 0;
  const findUserBySession = repository.findUserBySession.bind(repository);
  repository.findUserBySession = async (tokenHash, now) => {
    lookups += 1;
    return findUserBySession(tokenHash, now);
  };
  const app = createApp(createTestDatabase(), { authRepository: repository });
  try {
    for (const authorization of [`Bearer ${"a".repeat(39)}`, `Bearer ${"a".repeat(42)}!`, "Bearer"]) {
      const response = await app.inject({ method: "GET", url: "/auth/me", headers: { authorization } });
      assert.equal(response.statusCode, 401);
    }
    assert.equal(lookups, 0);

    // The counter is live: a well-formed but unknown token does reach the lookup.
    await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${"a".repeat(43)}` } });
    assert.equal(lookups, 1);
  } finally {
    await app.close();
  }
});

test("when the bearer header and the cookie arrive together, only the header is considered", async () => {
  const { app, sentMessages } = createAppWithMailbox();
  try {
    await createVerifiedAccount(app, sentMessages, "first@example.com");
    await createVerifiedAccount(app, sentMessages, "second@example.com");
    const browser = await app.inject({ method: "POST", url: "/auth/login", payload: { email: "first@example.com", password: VERIFIED_PASSWORD } });
    const cookie = String(browser.headers["set-cookie"]).split(";")[0]!;
    const mobile = await app.inject({ method: "POST", url: "/auth/token", payload: { email: "second@example.com", password: VERIFIED_PASSWORD } });
    const { token } = mobile.json() as { token: string };

    const both = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie, authorization: `Bearer ${token}` } });
    assert.equal(both.statusCode, 200);
    assert.equal((both.json() as { user: AuthUser }).user.email, "second@example.com");

    // A malformed header does not fall back to the valid cookie next to it.
    const malformed = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie, authorization: "Bearer invalido" } });
    assert.equal(malformed.statusCode, 401);

    // Without the header, the cookie keeps working exactly as before.
    const cookieOnly = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    assert.equal((cookieOnly.json() as { user: AuthUser }).user.email, "first@example.com");

    // A logout naming an invalid bearer ends nothing, so it is refused: no 204, no cleared cookie, and
    // the cookie session next to it is still open.
    const invalidLogout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, authorization: "Bearer invalido" } });
    assert.equal(invalidLogout.statusCode, 401);
    assert.deepEqual(invalidLogout.json(), { message: "Autenticação necessária." });
    assert.equal(invalidLogout.headers["set-cookie"], undefined);
    assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode, 200);

    // A well-formed bearer that resolves no session ends nothing either.
    const unknownLogout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, authorization: `Bearer ${"c".repeat(43)}` } });
    assert.equal(unknownLogout.statusCode, 401);
    assert.equal(unknownLogout.headers["set-cookie"], undefined);
    assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode, 200);

    // A valid bearer next to another session's cookie ends the bearer session only, and leaves the
    // cookie alone: the browser was not told it logged out, and its session is still open.
    const bearerLogout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, authorization: `Bearer ${token}` } });
    assert.equal(bearerLogout.statusCode, 204);
    assert.equal(bearerLogout.headers["set-cookie"], undefined);
    assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers: { authorization: `Bearer ${token}` } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode, 200);

    // Repeating the bearer logout finds the session already ended: 401, not a second success.
    const repeated = await app.inject({ method: "POST", url: "/auth/logout", headers: { authorization: `Bearer ${token}` } });
    assert.equal(repeated.statusCode, 401);

    // The browser logout without the header is unchanged: 204 and the cookie cleared, even with no session.
    const browserLogout = await app.inject({ method: "POST", url: "/auth/logout" });
    assert.equal(browserLogout.statusCode, 204);
    assert.match(String(browserLogout.headers["set-cookie"]), /Max-Age=0/);
  } finally {
    await app.close();
  }
});

test("the token login shares the per-IP attempt budget of the browser login", async () => {
  const app = createApp(createTestDatabase(), { authRepository: new MemoryAuthRepository() });
  const payload = { email: "person@example.com", password: "WrongPassword1!" };
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await app.inject({ method: "POST", url: "/auth/login", payload })).statusCode, 401);
      assert.equal((await app.inject({ method: "POST", url: "/auth/token", payload })).statusCode, 401);
    }

    const blocked = await app.inject({ method: "POST", url: "/auth/token", payload });
    assert.equal(blocked.statusCode, 429);
    assert.ok(Number(blocked.headers["retry-after"]) > 0);
    assert.deepEqual(blocked.json(), {
      message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente.",
    });
    assert.equal((await app.inject({ method: "POST", url: "/auth/login", payload })).statusCode, 429);

    const otherIp = await app.inject({ method: "POST", url: "/auth/token", payload, remoteAddress: "203.0.113.10" });
    assert.equal(otherIp.statusCode, 401);
  } finally {
    await app.close();
  }
});

test("the token login refuses unverified accounts and malformed requests with the browser login messages", async () => {
  const { app } = createAppWithMailbox();
  try {
    await app.inject({ method: "POST", url: "/auth/register", payload: { email: "pending@example.com", password: VERIFIED_PASSWORD } });
    const unverified = await app.inject({ method: "POST", url: "/auth/token", payload: { email: "pending@example.com", password: VERIFIED_PASSWORD } });
    assert.equal(unverified.statusCode, 401);
    assert.deepEqual(unverified.json(), { message: "E-mail ou senha inválidos." });
    assert.equal(unverified.body.includes("token"), false);

    const malformed = await app.inject({ method: "POST", url: "/auth/token", payload: { email: "not-an-email" } });
    assert.equal(malformed.statusCode, 400);
    assert.deepEqual(malformed.json(), { message: "Os dados enviados são inválidos." });
  } finally {
    await app.close();
  }
});
