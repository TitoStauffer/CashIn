-- Transfers between wallets (DEV-58): money leaving one wallet and arriving in another is never
-- income nor expense, so a transfer is its own record instead of a pair of movements. The transfer
-- holds the money once, which is what keeps the two cash balances right even when only one of the
-- two bank statements has been imported.
--
-- Each side of a transfer is a line of some wallet's statement. The sides may arrive in any order,
-- or never arrive at all when the other wallet has no statement to import, so the transfer exists on
-- its own and an imported line points at it. The side an item represents is its own wallet: the item
-- is the outgoing side when its wallet is from_wallet_id, and the incoming side when it is
-- to_wallet_id.

CREATE TABLE wallet_transfers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  to_wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  amount numeric(14, 2) NOT NULL,
  date date NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallet_transfers_amount_positive_check CHECK (amount > 0),
  CONSTRAINT wallet_transfers_amount_precision_check
    CHECK (amount < 1000000000000 AND amount = trunc(amount, 2)),
  CONSTRAINT wallet_transfers_distinct_wallets_check CHECK (from_wallet_id <> to_wallet_id),
  CONSTRAINT wallet_transfers_description_check
    CHECK (description IS NULL OR octet_length(description) <= 4000)
);

-- A wallet reads its transfers from both ends: what left it and what arrived in it.
CREATE INDEX wallet_transfers_from_wallet_date_idx ON wallet_transfers (from_wallet_id, date);
CREATE INDEX wallet_transfers_to_wallet_date_idx ON wallet_transfers (to_wallet_id, date);

-- A reconciled line points at the wallet on the other end, chosen by the user before the import is
-- confirmed, and then at the transfer it created or completed. Unlike the other links in this table,
-- the foreign key cannot be scoped by wallet_id: a transfer belongs to two wallets, and the item's
-- wallet is only one of them. The queries always scope by the item's wallet, and the reconciliation
-- refuses a transfer whose two ends do not include it.
ALTER TABLE import_items
  DROP CONSTRAINT import_items_result_shape_check,
  ADD COLUMN transfer_counterpart_wallet_id uuid REFERENCES wallets (id) ON DELETE SET NULL,
  ADD COLUMN wallet_transfer_id uuid REFERENCES wallet_transfers (id) ON DELETE SET NULL,
  ADD COLUMN resulting_wallet_transfer_id uuid
    REFERENCES wallet_transfers (id) ON DELETE SET NULL,
  -- Only an outgoing or incoming line of a bank statement can be a transfer between wallets, and the
  -- counterpart is never the item's own wallet.
  ADD CONSTRAINT import_items_transfer_counterpart_check
    CHECK (
      transfer_counterpart_wallet_id IS NULL
      OR (type = 'transfer' AND transfer_counterpart_wallet_id <> wallet_id)
    ),
  -- Settling a card statement and mirroring another wallet are different destinations for the same
  -- classification, so a transfer never carries both links at once.
  ADD CONSTRAINT import_items_transfer_single_destination_check
    CHECK (
      credit_card_statement_id IS NULL
      OR (transfer_counterpart_wallet_id IS NULL AND wallet_transfer_id IS NULL)
    ),
  -- A pending transfer is only ever chosen together with the wallet on its other end.
  ADD CONSTRAINT import_items_chosen_transfer_check
    CHECK (wallet_transfer_id IS NULL OR transfer_counterpart_wallet_id IS NOT NULL),
  ADD CONSTRAINT import_items_result_shape_check
    CHECK (
      (resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_wallet_transfer_id IS NULL
        AND resulting_updated_at IS NULL)
      OR
      (type IN ('income', 'expense', 'card_credit', 'transfer')
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_wallet_transfer_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'income'
        AND validation_status = 'imported'
        AND resulting_income_id IS NOT NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_wallet_transfer_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'expense'
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NOT NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_wallet_transfer_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'card_credit'
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NOT NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_wallet_transfer_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'transfer'
        AND validation_status = 'imported'
        AND credit_card_statement_id IS NOT NULL
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NOT NULL
        AND resulting_wallet_transfer_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'transfer'
        AND validation_status = 'imported'
        AND transfer_counterpart_wallet_id IS NOT NULL
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_wallet_transfer_id IS NOT NULL
        AND resulting_updated_at IS NOT NULL)
    );

CREATE INDEX import_items_chosen_wallet_transfer_idx
  ON import_items (wallet_transfer_id)
  WHERE wallet_transfer_id IS NOT NULL;

CREATE INDEX import_items_transfer_counterpart_idx
  ON import_items (transfer_counterpart_wallet_id)
  WHERE transfer_counterpart_wallet_id IS NOT NULL;

-- One imported line per side of a transfer: without this, two lines of the same wallet could claim
-- the same transfer and the money would be reconciled twice.
CREATE UNIQUE INDEX import_items_wallet_transfer_side_key
  ON import_items (resulting_wallet_transfer_id, wallet_id)
  WHERE resulting_wallet_transfer_id IS NOT NULL;
