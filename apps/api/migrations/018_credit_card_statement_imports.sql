-- Credit card statement imports: purchases become credit card expenses, while refunds and
-- chargebacks become statement credits that reduce the statement total without being income.

CREATE TABLE credit_card_statement_credits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  credit_card_statement_id uuid NOT NULL,
  original_expense_id uuid,
  amount numeric(14, 2) NOT NULL,
  date date NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_card_statement_credits_amount_positive_check CHECK (amount > 0),
  CONSTRAINT credit_card_statement_credits_description_check
    CHECK (description IS NULL OR octet_length(description) <= 4000),
  CONSTRAINT credit_card_statement_credits_statement_wallet_fkey
    FOREIGN KEY (credit_card_statement_id, wallet_id)
    REFERENCES credit_card_statements (id, wallet_id),
  CONSTRAINT credit_card_statement_credits_original_expense_wallet_fkey
    FOREIGN KEY (original_expense_id, wallet_id)
    REFERENCES expenses (id, wallet_id)
    ON DELETE SET NULL (original_expense_id),
  CONSTRAINT credit_card_statement_credits_id_wallet_id_key UNIQUE (id, wallet_id)
);

CREATE INDEX credit_card_statement_credits_statement_idx
  ON credit_card_statement_credits (credit_card_statement_id, wallet_id);

CREATE INDEX credit_card_statement_credits_original_expense_idx
  ON credit_card_statement_credits (original_expense_id)
  WHERE original_expense_id IS NOT NULL;

ALTER TABLE import_sessions
  ADD COLUMN kind text NOT NULL DEFAULT 'bank_statement',
  ADD COLUMN credit_card_id uuid,
  ADD CONSTRAINT import_sessions_kind_check
    CHECK (kind IN ('bank_statement', 'credit_card_statement')),
  ADD CONSTRAINT import_sessions_kind_credit_card_check
    CHECK ((kind = 'credit_card_statement') = (credit_card_id IS NOT NULL)),
  ADD CONSTRAINT import_sessions_credit_card_wallet_fkey
    FOREIGN KEY (credit_card_id, wallet_id)
    REFERENCES credit_cards (id, wallet_id);

CREATE INDEX import_sessions_wallet_credit_card_idx
  ON import_sessions (wallet_id, credit_card_id)
  WHERE credit_card_id IS NOT NULL;

ALTER TABLE import_items
  DROP CONSTRAINT import_items_type_check,
  DROP CONSTRAINT import_items_category_shape_check,
  DROP CONSTRAINT import_items_result_shape_check,
  ADD COLUMN statement_closing_date date,
  ADD COLUMN resulting_card_credit_id uuid,
  ADD CONSTRAINT import_items_type_check
    CHECK (type IN ('income', 'expense', 'transfer', 'card_credit')),
  ADD CONSTRAINT import_items_category_shape_check
    CHECK (
      (type IN ('transfer', 'card_credit')
        AND category_id IS NULL
        AND subcategory_id IS NULL
        AND category_nature IS NULL)
      OR
      (type IN ('income', 'expense')
        AND category_nature IS NOT NULL
        AND category_nature = type
        AND (subcategory_id IS NULL OR category_id IS NOT NULL))
    ),
  ADD CONSTRAINT import_items_result_shape_check
    CHECK (
      (resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_updated_at IS NULL)
      OR
      (type IN ('income', 'expense', 'card_credit')
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'income'
        AND validation_status = 'imported'
        AND resulting_income_id IS NOT NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'expense'
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NOT NULL
        AND resulting_card_credit_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'card_credit'
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_card_credit_id IS NOT NULL
        AND resulting_updated_at IS NOT NULL)
    ),
  ADD CONSTRAINT import_items_resulting_card_credit_wallet_fkey
    FOREIGN KEY (resulting_card_credit_id, wallet_id)
    REFERENCES credit_card_statement_credits (id, wallet_id)
    ON DELETE SET NULL (resulting_card_credit_id);

CREATE INDEX import_items_resulting_card_credit_idx
  ON import_items (resulting_card_credit_id)
  WHERE resulting_card_credit_id IS NOT NULL;
