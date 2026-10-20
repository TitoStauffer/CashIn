CREATE TABLE wallet_access_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_access_links_token_hash_check
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT wallet_access_links_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT wallet_access_links_revoked_at_check
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT wallet_access_links_wallet_owner_fkey
    FOREIGN KEY (wallet_id, owner_user_id)
    REFERENCES wallets (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT wallet_access_links_id_wallet_owner_key
    UNIQUE (id, wallet_id, owner_user_id)
);

CREATE UNIQUE INDEX wallet_access_links_token_hash_uidx
  ON wallet_access_links (token_hash);

CREATE INDEX wallet_access_links_wallet_owner_expiry_idx
  ON wallet_access_links (wallet_id, owner_user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE wallet_invitations
  ADD CONSTRAINT wallet_invitations_id_wallet_owner_email_key
    UNIQUE (id, wallet_id, invited_by_user_id, email_normalized);

CREATE TABLE wallet_access_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  access_link_id uuid NOT NULL,
  email_normalized varchar(320) NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  rejected_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  wallet_invitation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_access_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired')),
  CONSTRAINT wallet_access_requests_email_normalized_check
    CHECK (email_normalized <> '' AND email_normalized = lower(btrim(email_normalized))),
  CONSTRAINT wallet_access_requests_expiry_check
    CHECK (expires_at > created_at),
  CONSTRAINT wallet_access_requests_state_fields_check
    CHECK (
      (status = 'pending'
        AND approved_at IS NULL AND rejected_at IS NULL
        AND cancelled_at IS NULL AND expired_at IS NULL
        AND wallet_invitation_id IS NULL)
      OR (status = 'approved'
        AND approved_at IS NOT NULL AND rejected_at IS NULL
        AND cancelled_at IS NULL AND expired_at IS NULL
        AND wallet_invitation_id IS NOT NULL)
      OR (status = 'rejected'
        AND approved_at IS NULL AND rejected_at IS NOT NULL
        AND cancelled_at IS NULL AND expired_at IS NULL
        AND wallet_invitation_id IS NULL)
      OR (status = 'cancelled'
        AND approved_at IS NULL AND rejected_at IS NULL
        AND cancelled_at IS NOT NULL AND expired_at IS NULL
        AND wallet_invitation_id IS NULL)
      OR (status = 'expired'
        AND approved_at IS NULL AND rejected_at IS NULL
        AND cancelled_at IS NULL AND expired_at IS NOT NULL
        AND expired_at >= expires_at
        AND wallet_invitation_id IS NULL)
    ),
  CONSTRAINT wallet_access_requests_wallet_owner_fkey
    FOREIGN KEY (wallet_id, owner_user_id)
    REFERENCES wallets (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT wallet_access_requests_link_fkey
    FOREIGN KEY (access_link_id, wallet_id, owner_user_id)
    REFERENCES wallet_access_links (id, wallet_id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT wallet_access_requests_invitation_fkey
    FOREIGN KEY (wallet_invitation_id, wallet_id, owner_user_id, email_normalized)
    REFERENCES wallet_invitations (id, wallet_id, invited_by_user_id, email_normalized)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX wallet_access_requests_one_pending_per_wallet_email_uidx
  ON wallet_access_requests (wallet_id, email_normalized)
  WHERE status = 'pending';

CREATE INDEX wallet_access_requests_wallet_status_created_at_idx
  ON wallet_access_requests (wallet_id, status, created_at DESC, id DESC);

CREATE INDEX wallet_access_requests_expiry_idx
  ON wallet_access_requests (expires_at)
  WHERE status = 'pending';
