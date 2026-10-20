import type { EmailSender } from "../auth/auth.types.js";
import { createOpaqueToken, hashToken } from "../auth/token.js";
import { WalletInvitationError } from "./wallet-invitations.errors.js";
import type {
  WalletInvitation,
  WalletInvitationConfiguration,
  WalletInvitationRepository,
} from "./wallet-invitations.types.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class WalletInvitationsService {
  constructor(
    private readonly repository: WalletInvitationRepository,
    private readonly emailSender: EmailSender,
    private readonly configuration: WalletInvitationConfiguration,
    private readonly now: () => Date = () => new Date(),
    private readonly onEmailDeliveryFailure: (error: unknown) => void = () => undefined,
  ) {}

  async createInvitation(walletId: string, ownerUserId: string, rawEmail: string): Promise<WalletInvitation> {
    const prepared = await this.prepareInvitation(walletId, ownerUserId, rawEmail);
    prepared.sendInvitationEmail();
    return prepared.invitation;
  }

  async prepareInvitation(
    walletId: string,
    ownerUserId: string,
    rawEmail: string,
  ): Promise<{ invitation: WalletInvitation; sendInvitationEmail: () => void }> {
    const email = rawEmail.trim().toLowerCase();
    if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
      throw new WalletInvitationError("Informe um endereço de e-mail válido.", 400);
    }

    const token = createOpaqueToken();
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.configuration.invitationTokenTtlHours * 60 * 60 * 1000);
    let created;
    try {
      created = await this.repository.createInvitation(
        walletId,
        ownerUserId,
        email,
        hashToken(token),
        expiresAt,
        now,
      );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new WalletInvitationError("Já existe um convite pendente para este e-mail.", 409);
      }
      throw error;
    }

    return {
      invitation: created.invitation,
      sendInvitationEmail: () => {
        const invitationUrl = new URL("/wallet-invite", this.configuration.webBaseUrl);
        invitationUrl.searchParams.set("token", token);
        setImmediate(() => {
          if (!this.emailSender.sendWalletInvitationEmail) {
            this.onEmailDeliveryFailure(new Error("Wallet invitation email is not configured"));
            return;
          }
          void this.emailSender
            .sendWalletInvitationEmail(email, invitationUrl.toString(), created.walletName, created.inviterEmail)
            .catch((error: unknown) => this.onEmailDeliveryFailure(error));
        });
      },
    };
  }

  async listInvitations(walletId: string, ownerUserId: string): Promise<WalletInvitation[]> {
    const invitations = await this.repository.listInvitations(walletId, ownerUserId, this.now());
    if (!invitations) throw new WalletInvitationError("Carteira não encontrada.", 404);
    return invitations;
  }

  async cancelInvitation(walletId: string, ownerUserId: string, invitationId: string): Promise<void> {
    const cancelled = await this.repository.cancelInvitation(walletId, ownerUserId, invitationId, this.now());
    if (!cancelled) throw new WalletInvitationError("Convite pendente não encontrado.", 404);
  }

  async acceptInvitation(token: string, userId: string, email: string) {
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) {
      throw new WalletInvitationError("O convite é inválido ou expirou.", 400);
    }
    const wallet = await this.repository.acceptInvitation(hashToken(token), userId, email.trim().toLowerCase(), this.now());
    if (!wallet) throw new WalletInvitationError("O convite é inválido, expirou ou não corresponde ao e-mail da conta.", 400);
    return wallet;
  }

  async listMembers(walletId: string, ownerUserId: string) {
    const members = await this.repository.listMembers(walletId, ownerUserId);
    if (!members) throw new WalletInvitationError("Carteira não encontrada.", 404);
    return members;
  }

  async removeMember(walletId: string, ownerUserId: string, userId: string): Promise<void> {
    const result = await this.repository.removeMember(walletId, ownerUserId, userId);
    if (result === "owner") throw new WalletInvitationError("A propriedade da carteira não pode ser removida.", 400);
    if (result === "missing") throw new WalletInvitationError("Membro não encontrado nesta carteira.", 404);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
