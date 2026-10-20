import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../app.js";
import type { AuthRepository, AuthUser, PendingAccount, StoredUser } from "../auth/auth.types.js";
import { hashToken } from "../auth/token.js";
import type { Database, QueryExecutor } from "../database.js";
import type { Wallet } from "../wallets/wallets.types.js";
import type {
  CreatedWalletInvitation,
  WalletInvitation,
  WalletInvitationRepository,
  WalletMember,
} from "../wallet-invitations/wallet-invitations.types.js";
import type {
  CreatedWalletAccessLink,
  CreatedWalletAccessRequest,
  WalletAccessRequest,
  WalletAccessRequestForApproval,
  WalletAccessRequestRepository,
} from "./wallet-access-requests.types.js";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMBER_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const WALLET_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OWNER_SESSION = "o".repeat(43);
const MEMBER_SESSION = "m".repeat(43);
const ACCESS_TOKEN = "access-token-with-adequate-length-0123456789";

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
  readonly invitations = new Map<string, WalletInvitation & { tokenHash: string }>();
  private sequence = 0;

  async createInvitation(walletId: string, ownerUserId: string, email: string, tokenHash: string, expiresAt: Date, now: Date): Promise<CreatedWalletInvitation> {
    if (walletId !== WALLET_ID || ownerUserId !== OWNER_ID) throw new Error("not owner");
    const invitation: WalletInvitation & { tokenHash: string } = {
      id: `dddddddd-dddd-4ddd-8ddd-${String(++this.sequence).padStart(12, "0")}`,
      email,
      status: "pending",
      expiresAt,
      createdAt: now,
      acceptedAt: null,
      cancelledAt: null,
      tokenHash,
    };
    this.invitations.set(invitation.id, invitation);
    return { invitation, walletName: "Família", inviterEmail: "owner@example.com" };
  }
  async listInvitations(_walletId: string, _ownerUserId: string, _now: Date): Promise<WalletInvitation[] | null> { return []; }
  async cancelInvitation(_walletId: string, _ownerUserId: string, invitationId: string, now: Date): Promise<boolean> {
    const invitation = this.invitations.get(invitationId);
    if (!invitation || invitation.status !== "pending") return false;
    invitation.status = "cancelled";
    invitation.cancelledAt = now;
    return true;
  }
  async acceptInvitation(_tokenHash: string, _userId: string, _verifiedEmail: string, _now: Date): Promise<Wallet | null> { return null; }
  async listMembers(_walletId: string, _ownerUserId: string): Promise<WalletMember[] | null> { return []; }
  async removeMember(_walletId: string, _ownerUserId: string, _userId: string): Promise<"removed" | "owner" | "missing"> { return "missing"; }
}

class TestWalletAccessRequestRepository implements WalletAccessRequestRepository {
  readonly requests = new Map<string, WalletAccessRequest>();
  readonly links: Array<{ tokenHash: string; expiresAt: Date }> = [];

  async createLink(_walletId: string, ownerUserId: string, tokenHash: string, expiresAt: Date, _now: Date): Promise<CreatedWalletAccessLink> {
    if (ownerUserId !== OWNER_ID) throw Object.assign(new Error("not found"), { statusCode: 404 });
    this.links.push({ tokenHash, expiresAt });
    return { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", expiresAt, walletName: "Família" };
  }
  async createRequest(tokenHash: string, email: string, now: Date): Promise<CreatedWalletAccessRequest | null> {
    if (tokenHash !== hashToken(ACCESS_TOKEN)) return null;
    const request: WalletAccessRequest = {
      id: REQUEST_ID, email, status: "pending", createdAt: now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      approvedAt: null, rejectedAt: null, cancelledAt: null,
    };
    this.requests.set(request.id, request);
    return { request, walletId: WALLET_ID, walletName: "Família", ownerEmail: "owner@example.com" };
  }
  async listRequests(walletId: string, ownerUserId: string, _now: Date): Promise<WalletAccessRequest[] | null> {
    return walletId === WALLET_ID && ownerUserId === OWNER_ID ? [...this.requests.values()] : null;
  }
  async findPendingRequest(walletId: string, ownerUserId: string, requestId: string, _now: Date): Promise<WalletAccessRequestForApproval | null> {
    const request = this.requests.get(requestId);
    if (walletId !== WALLET_ID || ownerUserId !== OWNER_ID || !request || request.status !== "pending") return null;
    return { id: request.id, email: request.email, createdAt: request.createdAt, expiresAt: request.expiresAt };
  }
  async approveRequest(_walletId: string, _ownerUserId: string, requestId: string, _invitationId: string, now: Date): Promise<boolean> {
    const request = this.requests.get(requestId);
    if (!request || request.status !== "pending") return false;
    request.status = "approved";
    request.approvedAt = now;
    return true;
  }
  async rejectRequest(_walletId: string, _ownerUserId: string, requestId: string, now: Date): Promise<boolean> {
    const request = this.requests.get(requestId);
    if (!request || request.status !== "pending") return false;
    request.status = "rejected";
    request.rejectedAt = now;
    return true;
  }
  async cancelRequest(_walletId: string, _ownerUserId: string, requestId: string, now: Date): Promise<boolean> {
    const request = this.requests.get(requestId);
    if (!request || request.status !== "pending") return false;
    request.status = "cancelled";
    request.cancelledAt = now;
    return true;
  }
}

function createTestDatabase(): Database {
  const executor: QueryExecutor = { query: async <Row>() => ({ rows: [] as Row[], rowCount: 0 }) };
  return { ...executor, transaction: async (work) => work(executor) };
}

function createTestApp() {
  const invitationRepository = new TestWalletInvitationRepository();
  const requestRepository = new TestWalletAccessRequestRepository();
  const sentAccessEmails: Array<{ email: string; url: string }> = [];
  const sentInvitations: Array<{ email: string; url: string }> = [];
  const app = createApp(createTestDatabase(), {
    authRepository: new TestAuthRepository(),
    walletInvitationRepository: invitationRepository,
    walletAccessRequestRepository: requestRepository,
    authConfiguration: { webBaseUrl: "https://app.example.com" },
    emailSender: {
      sendVerificationEmail: async () => undefined,
      sendWalletInvitationEmail: async (email, url) => { sentInvitations.push({ email, url }); },
      sendWalletAccessRequestEmail: async (email, _walletName, _requesterEmail, url) => { sentAccessEmails.push({ email, url }); },
    },
  });
  return { app, invitationRepository, requestRepository, sentAccessEmails, sentInvitations };
}

function cookie(token: string): string { return `cashin_session=${token}`; }

test("owner generates an opaque expiring access link without exposing its token hash", async () => {
  const { app, requestRepository } = createTestApp();
  try {
    const response = await app.inject({
      method: "POST", url: `/wallets/${WALLET_ID}/access-links`, headers: { cookie: cookie(OWNER_SESSION) },
    });
    assert.equal(response.statusCode, 201);
    const link = response.json().link;
    assert.equal(new URL(link.url).pathname, "/wallet-access-request");
    const rawToken = new URL(link.url).searchParams.get("token")!;
    assert.equal(requestRepository.links[0]?.tokenHash, hashToken(rawToken));
    assert.equal(response.body.includes(requestRepository.links[0]!.tokenHash), false);
  } finally {
    await app.close();
  }
});

test("public request submission gives the same response for valid and invalid links and notifies the owner asynchronously", async () => {
  const { app, sentAccessEmails } = createTestApp();
  try {
    const valid = await app.inject({
      method: "POST", url: "/wallet-access-requests", payload: { token: ACCESS_TOKEN, email: "Person@Example.com" },
    });
    const invalid = await app.inject({
      method: "POST", url: "/wallet-access-requests", payload: { token: "x".repeat(43), email: "person@example.com" },
    });
    assert.equal(valid.statusCode, 202);
    assert.deepEqual(valid.json(), invalid.json());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sentAccessEmails.length, 1);
    assert.equal(sentAccessEmails[0]?.email, "owner@example.com");
    assert.equal(new URL(sentAccessEmails[0]!.url).pathname, "/wallet-sharing");
    assert.equal(new URL(sentAccessEmails[0]!.url).searchParams.get("walletId"), WALLET_ID);
  } finally {
    await app.close();
  }
});

test("only the owner can approve or reject; approval creates an invitation and cancellation only affects pending requests", async () => {
  const { app, requestRepository, sentInvitations } = createTestApp();
  try {
    requestRepository.requests.set(REQUEST_ID, {
      id: REQUEST_ID, email: "person@example.com", status: "pending", createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000), approvedAt: null, rejectedAt: null, cancelledAt: null,
    });
    const forbidden = await app.inject({
      method: "POST", url: `/wallets/${WALLET_ID}/access-requests/${REQUEST_ID}/approve`,
      headers: { cookie: cookie(MEMBER_SESSION) },
    });
    assert.equal(forbidden.statusCode, 404);

    const approved = await app.inject({
      method: "POST", url: `/wallets/${WALLET_ID}/access-requests/${REQUEST_ID}/approve`,
      headers: { cookie: cookie(OWNER_SESSION) },
    });
    assert.equal(approved.statusCode, 200);
    assert.equal(approved.json().request.status, "approved");
    assert.equal(sentInvitations.length, 0);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(sentInvitations[0]?.email, "person@example.com");
    assert.equal(new URL(sentInvitations[0]!.url).pathname, "/wallet-invite");

    const cancelled = await app.inject({
      method: "DELETE", url: `/wallets/${WALLET_ID}/access-requests/${REQUEST_ID}`,
      headers: { cookie: cookie(OWNER_SESSION) },
    });
    assert.equal(cancelled.statusCode, 404);

    requestRepository.requests.set(REQUEST_ID, {
      id: REQUEST_ID, email: "other@example.com", status: "pending", createdAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000), approvedAt: null, rejectedAt: null, cancelledAt: null,
    });
    const rejected = await app.inject({
      method: "POST", url: `/wallets/${WALLET_ID}/access-requests/${REQUEST_ID}/reject`,
      headers: { cookie: cookie(OWNER_SESSION) },
    });
    assert.equal(rejected.statusCode, 200);
    assert.equal(requestRepository.requests.get(REQUEST_ID)?.status, "rejected");
  } finally {
    await app.close();
  }
});
