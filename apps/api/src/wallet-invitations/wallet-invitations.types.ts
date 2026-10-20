import type { Wallet } from "../wallets/wallets.types.js";

export type WalletInvitationStatus = "pending" | "accepted" | "cancelled" | "expired";

export interface WalletInvitation {
  id: string;
  email: string;
  status: WalletInvitationStatus;
  expiresAt: Date;
  createdAt: Date;
  acceptedAt: Date | null;
  cancelledAt: Date | null;
}

export interface WalletMember {
  id: string;
  email: string;
  role: "owner" | "member";
  createdAt: Date;
}

export interface CreatedWalletInvitation {
  invitation: WalletInvitation;
  walletName: string;
  inviterEmail: string;
}

export interface WalletInvitationRepository {
  createInvitation(
    walletId: string,
    ownerUserId: string,
    email: string,
    tokenHash: string,
    expiresAt: Date,
    now: Date,
  ): Promise<CreatedWalletInvitation>;
  listInvitations(walletId: string, ownerUserId: string, now: Date): Promise<WalletInvitation[] | null>;
  cancelInvitation(walletId: string, ownerUserId: string, invitationId: string, now: Date): Promise<boolean>;
  acceptInvitation(tokenHash: string, userId: string, verifiedEmail: string, now: Date): Promise<Wallet | null>;
  listMembers(walletId: string, ownerUserId: string): Promise<WalletMember[] | null>;
  removeMember(walletId: string, ownerUserId: string, userId: string): Promise<"removed" | "owner" | "missing">;
}

export interface WalletInvitationConfiguration {
  webBaseUrl: string;
  invitationTokenTtlHours: number;
}
