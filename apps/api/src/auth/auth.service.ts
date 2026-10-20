import { AuthError } from "./auth.errors.js";
import type { AuthConfiguration, AuthRepository, AuthUser, EmailSender } from "./auth.types.js";
import { hashPassword, verifyPassword } from "./password-hasher.js";
import { isPasswordPolicyValid, PASSWORD_POLICY_MESSAGE } from "./password-policy.js";
import { createOpaqueToken, hashToken } from "./token.js";

export interface AuthSession {
  user: AuthUser;
  token: string;
  expiresAt: Date;
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly emailSender: EmailSender,
    private readonly configuration: AuthConfiguration,
    private readonly now: () => Date = () => new Date(),
    private readonly onEmailDeliveryFailure: (error: unknown) => void = () => undefined,
  ) {}

  async register(email: string, password: string, inviteToken?: string): Promise<void> {
    if (!isPasswordPolicyValid(password)) {
      throw new AuthError(PASSWORD_POLICY_MESSAGE, 400);
    }
    if (inviteToken !== undefined && !/^[A-Za-z0-9_-]{40,128}$/.test(inviteToken)) {
      throw new AuthError("O convite é inválido ou expirou.", 400);
    }

    const normalizedEmail = email.trim().toLowerCase();
    const passwordHash = await hashPassword(password);
    const verificationToken = createOpaqueToken();
    const now = this.now();
    const pendingAccount = await this.repository.createPendingAccount(
      normalizedEmail,
      passwordHash,
      hashToken(verificationToken),
      new Date(now.getTime() + this.configuration.verificationTokenTtlHours * 60 * 60 * 1000),
    );

    // A duplicate registration receives the same response and cannot replace an existing password.
    if (!pendingAccount) return;

    const confirmationUrl = new URL("/verify-email", this.configuration.webBaseUrl);
    confirmationUrl.searchParams.set("token", verificationToken);
    if (inviteToken) confirmationUrl.searchParams.set("invite", inviteToken);

    setImmediate(() => {
      void this.deliverVerificationEmail(
        pendingAccount.user.id,
        normalizedEmail,
        confirmationUrl.toString(),
      );
    });
  }

  async verifyEmail(token: string): Promise<void> {
    const verified = await this.repository.verifyEmail(hashToken(token), this.now());
    if (!verified) throw new AuthError("O link de confirmação é inválido ou expirou.", 400);
  }

  async login(email: string, password: string): Promise<AuthSession> {
    const user = await this.repository.findUserByEmail(email.trim().toLowerCase());
    const passwordMatches = user
      ? await verifyPassword(password, user.passwordHash)
      : await hashPassword(password).then(() => false);

    if (!user || !passwordMatches || !user.emailVerifiedAt) {
      throw new AuthError("E-mail ou senha inválidos.", 401);
    }

    const token = createOpaqueToken();
    const expiresAt = new Date(this.now().getTime() + this.configuration.sessionTtlDays * 24 * 60 * 60 * 1000);
    await this.repository.createSession(user.id, hashToken(token), expiresAt);
    return { user: { id: user.id, email: user.email }, token, expiresAt };
  }

  async getUserForSession(token: string): Promise<AuthUser | null> {
    return this.repository.findUserBySession(hashToken(token), this.now());
  }

  async logout(token: string | null): Promise<void> {
    if (token) await this.repository.deleteSession(hashToken(token));
  }

  private async deliverVerificationEmail(
    userId: string,
    email: string,
    confirmationUrl: string,
  ): Promise<void> {
    try {
      await this.emailSender.sendVerificationEmail(email, confirmationUrl);
    } catch (error) {
      try {
        await this.repository.deleteUnverifiedUser(userId);
      } catch (cleanupError) {
        this.onEmailDeliveryFailure(cleanupError);
      }
      this.onEmailDeliveryFailure(error);
    }
  }
}
