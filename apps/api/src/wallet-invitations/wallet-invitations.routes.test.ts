import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { hashToken } from "../auth/token.js";
import type { Database, QueryExecutor } from "../database.js";
import { WalletInvitationError } from "./wallet-invitations.errors.js";
import type {
  CreatedWalletInvitation,
  WalletInvitation,
  WalletInvitationRepository,
  WalletMember,
} from "./wallet-invitations.types.js";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SHARED_WALLET_ID = "22222222-2222-4222-8222-222222222222";
const OWNER_SESSION = "a".repeat(43);
const MEMBER_SESSION = "b".repeat(43);

class TestAuthRepository implements AuthRepository {
  async findUserByEmail(_email: string): Promise<StoredUser | null> { return null; }
  async createPendingAccount(_email: string, _passwordHash: string, _tokenHash: string, _expiresAt: Date): Promise<PendingAccount | null> { return null; }
  async deleteUnverifiedUser(_userId: string): Promise<void> {}
  async verifyEmail(_tokenHash: string, _now: Date): Promise<boolean> { return false; }
  async createSession(_userId: string, _tokenHash: string, _expiresAt: Date): Promise<void> {}
  async findUserBySession(tokenHash: string): Promise<AuthUser | null> {
    if (tokenHash === hashToken(OWNER_SESSION)) return { id: OWNER_ID, email: "owner@example.com" };
    if (tokenHash === hashToken(MEMBER_SESSION)) return { id: MEMBER_ID, email: "member@example.com" };
    return null;
  }
  async deleteSession(_tokenHash: string): Promise<void> {}
}

class TestWalletInvitationRepository implements WalletInvitationRepository {
  readonly invitations = new Map<string, WalletInvitation & { tokenHash: string }>;
  readonly members: WalletMember[] = [
    { id: OWNER_ID, email: "owner@example.com", role: "owner", createdAt: new Date("2026-01-01T00:00:00Z") },
  ];
  readonly walletIds = new Set([SHARED_WALLET_ID]);
  private nextId = 1;

  async createInvitation(walletId: string, ownerUserId: string, email: string, tokenHash: string, expiresAt: Date, now: Date): Promise<CreatedWalletInvitation> {
    if (walletId !== SHARED_WALLET_ID || ownerUserId !== OWNER_ID) {
      throw new WalletInvitationError("Carteira não encontrada.", 404);
    }
    if ([...this.invitations.values()].some((item) => item.email === email && item.status === "pending")) {
      throw Object.assign(new Error(), { code: "23505" });
    }
    const invitation = {
      id: `dddddddd-dddd-4ddd-8ddd-${String(this.nextId++).padStart(12, "0")}`,
      email,
      status: "pending" as const,
      expiresAt,
      createdAt: now,
      acceptedAt: null,
      cancelledAt: null,
      tokenHash,
    };
    this.invitations.set(invitation.id, invitation);
    return { invitation, walletName: "Família", inviterEmail: "owner@example.com" };
  }

  async listInvitations(walletId: string, ownerUserId: string, _now: Date): Promise<WalletInvitation[] | null> {
    if (walletId !== SHARED_WALLET_ID || ownerUserId !== OWNER_ID) return null;
    return [...this.invitations.values()].map(({ tokenHash: _tokenHash, ...item }) => item);
  }

  async cancelInvitation(walletId: string, ownerUserId: string, invitationId: string, now: Date): Promise<boolean> {
    if (walletId !== SHARED_WALLET_ID || ownerUserId !== OWNER_ID) return false;
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.status !== "pending") return false;
    invitation.status = "cancelled";
    invitation.cancelledAt = now;
    return true;
  }

  async acceptInvitation(tokenHash: string, userId: string, email: string, now: Date) {
    const invitation = [...this.invitations.values()].find((item) => item.tokenHash === tokenHash);
    if (!invitation || invitation.status !== "pending" || invitation.expiresAt <= now || invitation.email !== email) return null;
    const member = userId === MEMBER_ID ? "member@example.com" : null;
    if (!member) return null;
    invitation.status = "accepted";
    invitation.acceptedAt = now;
    this.members.push({ id: userId, email: member, role: "member", createdAt: now });
    return { id: SHARED_WALLET_ID, name: "Família", isPersonal: false, role: "member" as const };
  }

  async listMembers(walletId: string, ownerUserId: string): Promise<WalletMember[] | null> {
    return walletId === SHARED_WALLET_ID && ownerUserId === OWNER_ID ? this.members : null;
  }

  async removeMember(walletId: string, ownerUserId: string, userId: string): Promise<"removed" | "owner" | "missing"> {
    if (walletId !== SHARED_WALLET_ID || ownerUserId !== OWNER_ID) return "missing";
    if (userId === OWNER_ID) return "owner";
    const index = this.members.findIndex((member) => member.id === userId && member.role === "member");
    if (index < 0) return "missing";
    this.members.splice(index, 1);
    return "removed";
  }
}

function createDatabase(): Database {
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  return { ...executor, transaction: async (work) => work(executor) };
}

function createTestApp(repository = new TestWalletInvitationRepository()) {
  const sentEmails: Array<{ email: string; url: string }> = [];
  const app = createApp(createDatabase(), {
    authRepository: new TestAuthRepository(),
    walletInvitationRepository: repository,
    emailSender: {
      sendVerificationEmail: async () => undefined,
      sendWalletInvitationEmail: async (email, url) => { sentEmails.push({ email, url }); },
    },
  });
  return { app, repository, sentEmails };
}

function authCookie(token: string): string { return `cashin_session=${token}`; }

test("owner creates and lists an email invitation without exposing its token", async () => {
  const { app, sentEmails } = createTestApp();
  try {
    const response = await app.inject({
      method: "POST",
      url: `/wallets/${SHARED_WALLET_ID}/invites`,
      headers: { cookie: authCookie(OWNER_SESSION) },
      payload: { email: "New.Member@Example.com" },
    });
    assert.equal(response.statusCode, 202);
    assert.equal(response.json().invitation.email, "new.member@example.com");
    assert.equal(response.json().invitation.token, undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sentEmails.length, 1);
    assert.equal(sentEmails[0]?.email, "new.member@example.com");
    const inviteUrl = new URL(sentEmails[0]!.url);
    assert.equal(inviteUrl.pathname, "/wallet-invite");
    assert.ok(inviteUrl.searchParams.get("token"));

    const list = await app.inject({
      method: "GET",
      url: `/wallets/${SHARED_WALLET_ID}/invites`,
      headers: { cookie: authCookie(OWNER_SESSION) },
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().items[0].status, "pending");
    assert.equal(list.body.includes(inviteUrl.searchParams.get("token")!), false);
  } finally {
    await app.close();
  }
});

test("member cannot administer invites; acceptance requires matching account email and consumes once", async () => {
  const { app, repository, sentEmails } = createTestApp();
  try {
    const forbidden = await app.inject({
      method: "POST",
      url: `/wallets/${SHARED_WALLET_ID}/invites`,
      headers: { cookie: authCookie(MEMBER_SESSION) },
      payload: { email: "other@example.com" },
    });
    assert.equal(forbidden.statusCode, 404);

    const created = await app.inject({
      method: "POST",
      url: `/wallets/${SHARED_WALLET_ID}/invites`,
      headers: { cookie: authCookie(OWNER_SESSION) },
      payload: { email: "member@example.com" },
    });
    assert.equal(created.statusCode, 202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const token = new URL(sentEmails[0]!.url).searchParams.get("token")!;

    const memberInviteList = await app.inject({
      method: "GET",
      url: `/wallets/${SHARED_WALLET_ID}/invites`,
      headers: { cookie: authCookie(MEMBER_SESSION) },
    });
    assert.equal(memberInviteList.statusCode, 404);

    const accepted = await app.inject({
      method: "POST",
      url: "/wallet-invitations/accept",
      headers: { cookie: authCookie(MEMBER_SESSION) },
      payload: { token },
    });
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual(accepted.json().wallet, {
      id: SHARED_WALLET_ID,
      name: "Família",
      isPersonal: false,
      role: "member",
    });

    const reused = await app.inject({
      method: "POST",
      url: "/wallet-invitations/accept",
      headers: { cookie: authCookie(MEMBER_SESSION) },
      payload: { token },
    });
    assert.equal(reused.statusCode, 400);

    const members = await app.inject({
      method: "GET",
      url: `/wallets/${SHARED_WALLET_ID}/members`,
      headers: { cookie: authCookie(OWNER_SESSION) },
    });
    assert.equal(members.statusCode, 200);
    assert.equal(members.json().items.some((member: WalletMember) => member.id === MEMBER_ID), true);
    assert.equal(repository.members.length, 2);
  } finally {
    await app.close();
  }
});

test("invitation cancellation and owner member-removal permissions are enforced", async () => {
  const { app, sentEmails } = createTestApp();
  try {
    const created = await app.inject({
      method: "POST",
      url: `/wallets/${SHARED_WALLET_ID}/invites`,
      headers: { cookie: authCookie(OWNER_SESSION) },
      payload: { email: "member@example.com" },
    });
    assert.equal(created.statusCode, 202);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const inviteId = created.json().invitation.id;

    const memberCancel = await app.inject({
      method: "DELETE",
      url: `/wallets/${SHARED_WALLET_ID}/invites/${inviteId}`,
      headers: { cookie: authCookie(MEMBER_SESSION) },
    });
    assert.equal(memberCancel.statusCode, 404);

    const cancel = await app.inject({
      method: "DELETE",
      url: `/wallets/${SHARED_WALLET_ID}/invites/${inviteId}`,
      headers: { cookie: authCookie(OWNER_SESSION) },
    });
    assert.equal(cancel.statusCode, 204);
    const canceledAcceptance = await app.inject({
      method: "POST",
      url: "/wallet-invitations/accept",
      headers: { cookie: authCookie(MEMBER_SESSION) },
      payload: { token: new URL(sentEmails[0]!.url).searchParams.get("token") },
    });
    assert.equal(canceledAcceptance.statusCode, 400);

    const selfRemove = await app.inject({
      method: "DELETE",
      url: `/wallets/${SHARED_WALLET_ID}/members/${OWNER_ID}`,
      headers: { cookie: authCookie(OWNER_SESSION) },
    });
    assert.equal(selfRemove.statusCode, 400);

    const removeMemberAsMember = await app.inject({
      method: "DELETE",
      url: `/wallets/${SHARED_WALLET_ID}/members/${MEMBER_ID}`,
      headers: { cookie: authCookie(MEMBER_SESSION) },
    });
    assert.equal(removeMemberAsMember.statusCode, 404);
  } finally {
    await app.close();
  }
});
