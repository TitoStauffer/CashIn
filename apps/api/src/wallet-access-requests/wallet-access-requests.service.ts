import type { EmailSender } from "../auth/auth.types.js";
import { createOpaqueToken, hashToken } from "../auth/token.js";
import type { WalletInvitationsService } from "../wallet-invitations/wallet-invitations.service.js";
import { WalletAccessRequestError } from "./wallet-access-requests.errors.js";
import type {
  WalletAccessRequest,
  WalletAccessRequestConfiguration,
  WalletAccessRequestRepository,
} from "./wallet-access-requests.types.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class WalletAccessRequestsService {
  constructor(
    private readonly repository: WalletAccessRequestRepository,
    private readonly invitationsService: WalletInvitationsService,
    private readonly emailSender: EmailSender,
    private readonly configuration: WalletAccessRequestConfiguration,
    private readonly now: () => Date = () => new Date(),
    private readonly onEmailDeliveryFailure: (error: unknown) => void = () => undefined,
  ) {}

  async createLink(walletId: string, ownerUserId: string) {
    const token = createOpaqueToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.configuration.accessLinkTtlHours * 60 * 60 * 1000);
    const created = await this.repository.createLink(walletId, ownerUserId, hashToken(token), expiresAt, now);
    const url = new URL("/wallet-access-request", this.configuration.webBaseUrl);
    url.searchParams.set("token", token);
    return { id: created.id, url: url.toString(), expiresAt: created.expiresAt };
  }

  async submitRequest(token: string, rawEmail: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token) || email.length > 320 || !EMAIL_PATTERN.test(email)) return;
    let created;
    try {
      created = await this.repository.createRequest(hashToken(token), email, this.now());
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    if (!created) return;

    const requestsUrl = new URL("/wallet-sharing", this.configuration.webBaseUrl);
    requestsUrl.searchParams.set("walletId", created.walletId);
    setImmediate(() => {
      if (!this.emailSender.sendWalletAccessRequestEmail) {
        this.onEmailDeliveryFailure(new Error("Wallet access request email is not configured"));
        return;
      }
      void this.emailSender
        .sendWalletAccessRequestEmail(created.ownerEmail, created.walletName, email, requestsUrl.toString())
        .catch((error: unknown) => this.onEmailDeliveryFailure(error));
    });
  }

  async listRequests(walletId: string, ownerUserId: string): Promise<WalletAccessRequest[]> {
    const requests = await this.repository.listRequests(walletId, ownerUserId, this.now());
    if (!requests) throw new WalletAccessRequestError("Carteira não encontrada.", 404);
    return requests;
  }

  async approveRequest(walletId: string, ownerUserId: string, requestId: string): Promise<WalletAccessRequest> {
    const now = this.now();
    const request = await this.repository.findPendingRequest(walletId, ownerUserId, requestId, now);
    if (!request) throw new WalletAccessRequestError("Solicitação pendente não encontrada.", 404);

    const prepared = await this.invitationsService.prepareInvitation(walletId, ownerUserId, request.email);
    const approved = await this.repository.approveRequest(walletId, ownerUserId, requestId, prepared.invitation.id, now);
    if (!approved) {
      await this.invitationsService.cancelInvitation(walletId, ownerUserId, prepared.invitation.id);
      throw new WalletAccessRequestError("Solicitação pendente não encontrada.", 404);
    }
    prepared.sendInvitationEmail();
    return {
      id: request.id,
      email: request.email,
      status: "approved",
      createdAt: request.createdAt,
      expiresAt: request.expiresAt,
      approvedAt: now,
      rejectedAt: null,
      cancelledAt: null,
    };
  }

  async rejectRequest(walletId: string, ownerUserId: string, requestId: string): Promise<void> {
    const rejected = await this.repository.rejectRequest(walletId, ownerUserId, requestId, this.now());
    if (!rejected) throw new WalletAccessRequestError("Solicitação pendente não encontrada.", 404);
  }

  async cancelRequest(walletId: string, ownerUserId: string, requestId: string): Promise<void> {
    const cancelled = await this.repository.cancelRequest(walletId, ownerUserId, requestId, this.now());
    if (!cancelled) throw new WalletAccessRequestError("Solicitação pendente não encontrada.", 404);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
