-- Statement payments: a statement may be paid in full or in parts, and a payment may come from a
-- reconciled bank statement line. credit_card_statements.paid_date keeps meaning "settled in full",
-- so every rule that blocks changes to a paid statement stays valid, while the amount paid is held
-- only by this table: a single source of truth for the money.

CREATE TABLE credit_card_statement_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  credit_card_statement_id uuid NOT NULL,
  amount numeric(14, 2) NOT NULL,
  date date NOT NULL,
  source text NOT NULL DEFAULT 'manual',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_card_statement_payments_amount_positive_check CHECK (amount > 0),
  CONSTRAINT credit_card_statement_payments_source_check
    CHECK (source IN ('manual', 'bank_statement')),
  CONSTRAINT credit_card_statement_payments_statement_wallet_fkey
    FOREIGN KEY (credit_card_statement_id, wallet_id)
    REFERENCES credit_card_statements (id, wallet_id) ON DELETE CASCADE,
  CONSTRAINT credit_card_statement_payments_id_wallet_id_key UNIQUE (id, wallet_id)
);

CREATE INDEX credit_card_statement_payments_statement_idx
  ON credit_card_statement_payments (credit_card_statement_id, wallet_id);

CREATE INDEX credit_card_statement_payments_wallet_date_idx
  ON credit_card_statement_payments (wallet_id, date);

-- Existing settlements become their own payment row, so the ledger holds every payment.
INSERT INTO credit_card_statement_payments (wallet_id, user_id, credit_card_statement_id, amount, date, source, created_at, updated_at)
SELECT statement.wallet_id,
       wallet.owner_user_id,
       statement.id,
       statement.paid_amount,
       statement.paid_date,
       'manual',
       statement.updated_at,
       statement.updated_at
FROM credit_card_statements AS statement
JOIN wallets AS wallet ON wallet.id = statement.wallet_id
WHERE statement.paid_date IS NOT NULL
  AND statement.paid_amount IS NOT NULL;

-- paid_amount would be a second source of truth for the amount paid, so it is dropped after the
-- settlements above are migrated. The amount paid is now the sum of the statement's payments.
ALTER TABLE credit_card_statements
  DROP CONSTRAINT credit_card_statements_payment_pair_check,
  DROP CONSTRAINT credit_card_statements_paid_amount_positive_check,
  DROP COLUMN paid_amount;

-- A reconciled bank statement line points at the statement it pays and, once imported, at the
-- payment row it created.
ALTER TABLE import_items
  DROP CONSTRAINT import_items_result_shape_check,
  ADD COLUMN credit_card_statement_id uuid,
  ADD COLUMN resulting_statement_payment_id uuid,
  ADD CONSTRAINT import_items_statement_reconciliation_check
    CHECK (credit_card_statement_id IS NULL OR type = 'transfer'),
  ADD CONSTRAINT import_items_statement_wallet_fkey
    FOREIGN KEY (credit_card_statement_id, wallet_id)
    REFERENCES credit_card_statements (id, wallet_id) ON DELETE SET NULL (credit_card_statement_id),
  ADD CONSTRAINT import_items_resulting_statement_payment_wallet_fkey
    FOREIGN KEY (resulting_statement_payment_id, wallet_id)
    REFERENCES credit_card_statement_payments (id, wallet_id)
    ON DELETE SET NULL (resulting_statement_payment_id),
  ADD CONSTRAINT import_items_result_shape_check
    CHECK (
      (resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_updated_at IS NULL)
      OR
      (type IN ('income', 'expense', 'card_credit', 'transfer')
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'income'
        AND validation_status = 'imported'
        AND resulting_income_id IS NOT NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'expense'
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NOT NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'card_credit'
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NOT NULL
        AND resulting_statement_payment_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'transfer'
        AND validation_status = 'imported'
        AND credit_card_statement_id IS NOT NULL
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_statement_payment_id IS NOT NULL
        AND resulting_updated_at IS NOT NULL)
    );

CREATE INDEX import_items_credit_card_statement_idx
  ON import_items (credit_card_statement_id, wallet_id)
  WHERE credit_card_statement_id IS NOT NULL;

CREATE INDEX import_items_resulting_statement_payment_idx
  ON import_items (resulting_statement_payment_id)
  WHERE resulting_statement_payment_id IS NOT NULL;
