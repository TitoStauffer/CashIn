CREATE TABLE credit_cards (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  alias text NOT NULL,
  closing_day smallint NOT NULL CHECK (closing_day BETWEEN 1 AND 31),
  due_day smallint NOT NULL CHECK (due_day BETWEEN 1 AND 31),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_cards_alias_nonempty_check CHECK (btrim(alias) <> ''),
  CONSTRAINT credit_cards_id_wallet_id_key UNIQUE (id, wallet_id)
);

CREATE INDEX credit_cards_wallet_active_idx
  ON credit_cards (wallet_id, is_active, alias);

CREATE TABLE credit_card_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  credit_card_id uuid NOT NULL,
  closing_date date NOT NULL,
  due_date date NOT NULL,
  paid_date date,
  paid_amount numeric(14, 2),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT credit_card_statements_payment_pair_check
    CHECK ((paid_date IS NULL) = (paid_amount IS NULL)),
  CONSTRAINT credit_card_statements_paid_amount_positive_check
    CHECK (paid_amount IS NULL OR paid_amount > 0),
  CONSTRAINT credit_card_statements_credit_card_wallet_fkey
    FOREIGN KEY (credit_card_id, wallet_id)
    REFERENCES credit_cards (id, wallet_id),
  CONSTRAINT credit_card_statements_card_closing_date_key
    UNIQUE (credit_card_id, closing_date),
  CONSTRAINT credit_card_statements_id_wallet_id_key
    UNIQUE (id, wallet_id)
);

CREATE INDEX credit_card_statements_wallet_card_due_date_idx
  ON credit_card_statements (wallet_id, credit_card_id, due_date);

ALTER TABLE expenses
  ADD COLUMN credit_card_statement_id uuid,
  ADD CONSTRAINT expenses_credit_card_statement_wallet_fkey
    FOREIGN KEY (credit_card_statement_id, wallet_id)
    REFERENCES credit_card_statements (id, wallet_id);

CREATE INDEX expenses_credit_card_statement_wallet_idx
  ON expenses (credit_card_statement_id, wallet_id)
  WHERE credit_card_statement_id IS NOT NULL;
