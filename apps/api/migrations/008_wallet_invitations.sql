CREATE TABLE wallet_invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL,
  invited_by_user_id uuid NOT NULL,
  email_normalized varchar(320) NOT NULL,
  token_hash char(64) NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  accepted_by_user_id uuid,
  accepted_at timestamptz,
  cancelled_at timestamptz,
  expired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_invitations_status_check
    CHECK (status IN ('pending', 'accepted', 'cancelled', 'expired')),
  CONSTRAINT wallet_invitations_email_normalized_check
    CHECK (email_normalized <> '' AND email_normalized = lower(btrim(email_normalized))),
  CONSTRAINT wallet_invitations_token_hash_check
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT wallet_invitations_state_fields_check
    CHECK (
      (status = 'pending'
        AND accepted_by_user_id IS NULL AND accepted_at IS NULL
        AND cancelled_at IS NULL AND expired_at IS NULL)
      OR (status = 'accepted'
        AND accepted_by_user_id IS NOT NULL AND accepted_at IS NOT NULL
        AND cancelled_at IS NULL AND expired_at IS NULL)
      OR (status = 'cancelled'
        AND accepted_by_user_id IS NULL AND accepted_at IS NULL
        AND cancelled_at IS NOT NULL AND expired_at IS NULL)
      OR (status = 'expired'
        AND accepted_by_user_id IS NULL AND accepted_at IS NULL
        AND cancelled_at IS NULL AND expired_at IS NOT NULL
        AND expired_at >= expires_at)
    ),
  CONSTRAINT wallet_invitations_wallet_owner_fkey
    FOREIGN KEY (wallet_id, invited_by_user_id)
    REFERENCES wallets (id, owner_user_id) ON DELETE CASCADE,
  CONSTRAINT wallet_invitations_accepted_by_user_fkey
    FOREIGN KEY (accepted_by_user_id)
    REFERENCES users (id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX wallet_invitations_token_hash_uidx
  ON wallet_invitations (token_hash);

CREATE UNIQUE INDEX wallet_invitations_one_pending_per_wallet_email_uidx
  ON wallet_invitations (wallet_id, email_normalized)
  WHERE status = 'pending';

CREATE INDEX wallet_invitations_wallet_status_created_at_idx
  ON wallet_invitations (wallet_id, status, created_at DESC);
