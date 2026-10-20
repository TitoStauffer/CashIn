export interface AuthUser {
  id: string;
  email: string;
}

export interface StoredUser extends AuthUser {
  passwordHash: string;
  emailVerifiedAt: Date | null;
}

export interface PendingAccount {
  user: AuthUser;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<StoredUser | null>;
  createPendingAccount(
    email: string,
    passwordHash: string,
    verificationTokenHash: string,
    verificationTokenExpiresAt: Date,
  ): Promise<PendingAccount | null>;
  deleteUnverifiedUser(userId: string): Promise<void>;
  verifyEmail(tokenHash: string, now: Date): Promise<boolean>;
  createSession(userId: string, tokenHash: string, expiresAt: Date): Promise<void>;
  findUserBySession(tokenHash: string, now: Date): Promise<AuthUser | null>;
  deleteSession(tokenHash: string): Promise<void>;
}

export interface EmailSender {
  sendVerificationEmail(email: string, confirmationUrl: string): Promise<void>;
  sendWalletInvitationEmail?(
    email: string,
    invitationUrl: string,
    walletName: string,
    inviterEmail: string,
  ): Promise<void>;
}

export interface AuthConfiguration {
  webBaseUrl: string;
  verificationTokenTtlHours: number;
  sessionTtlDays: number;
}
