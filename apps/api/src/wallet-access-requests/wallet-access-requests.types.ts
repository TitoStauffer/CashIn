export type WalletAccessRequestStatus = "pending" | "approved" | "rejected" | "cancelled" | "expired" | "accepted";

export interface WalletAccessLink {
  id: string;
  url: string;
  expiresAt: Date;
}

export interface WalletAccessRequest {
  id: string;
  email: string;
  status: WalletAccessRequestStatus;
  createdAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
  rejectedAt: Date | null;
  cancelledAt: Date | null;
}

export interface CreatedWalletAccessLink {
  id: string;
  expiresAt: Date;
  walletName: string;
}

export interface CreatedWalletAccessRequest {
  request: WalletAccessRequest;
  walletId: string;
  walletName: string;
  ownerEmail: string;
}

export interface WalletAccessRequestForApproval {
  id: string;
  email: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface WalletAccessRequestRepository {
  createLink(walletId: string, ownerUserId: string, tokenHash: string, expiresAt: Date, now: Date): Promise<CreatedWalletAccessLink>;
  createRequest(tokenHash: string, email: string, now: Date): Promise<CreatedWalletAccessRequest | null>;
  listRequests(walletId: string, ownerUserId: string, now: Date): Promise<WalletAccessRequest[] | null>;
  findPendingRequest(walletId: string, ownerUserId: string, requestId: string, now: Date): Promise<WalletAccessRequestForApproval | null>;
  approveRequest(walletId: string, ownerUserId: string, requestId: string, invitationId: string, now: Date): Promise<boolean>;
  rejectRequest(walletId: string, ownerUserId: string, requestId: string, now: Date): Promise<boolean>;
  cancelRequest(walletId: string, ownerUserId: string, requestId: string, now: Date): Promise<boolean>;
}

export interface WalletAccessRequestConfiguration {
  webBaseUrl: string;
  accessLinkTtlHours: number;
  requestRateLimit: { maxRequests: number; windowMs: number };
}
