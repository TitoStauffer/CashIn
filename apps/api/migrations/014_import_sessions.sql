ALTER TABLE incomes
  ADD CONSTRAINT incomes_id_wallet_id_key UNIQUE (id, wallet_id);

ALTER TABLE expenses
  ADD CONSTRAINT expenses_id_wallet_id_key UNIQUE (id, wallet_id);

CREATE TABLE import_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  format text NOT NULL CHECK (format IN ('ofx', 'csv')),
  original_filename text NOT NULL,
  file_size_bytes bigint NOT NULL,
  file_hash text NOT NULL,
  status text NOT NULL DEFAULT 'processing'
    CHECK (status IN ('processing', 'preview', 'completed', 'failed', 'undone')),
  item_count integer NOT NULL DEFAULT 0,
  valid_count integer NOT NULL DEFAULT 0,
  duplicate_count integer NOT NULL DEFAULT 0,
  invalid_count integer NOT NULL DEFAULT 0,
  uncategorized_count integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_message text,
  confirmed_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_sessions_id_wallet_id_key UNIQUE (id, wallet_id),
  CONSTRAINT import_sessions_filename_check
    CHECK (btrim(original_filename) <> '' AND octet_length(original_filename) <= 512),
  CONSTRAINT import_sessions_file_size_check
    CHECK (file_size_bytes > 0 AND file_size_bytes <= 10485760),
  CONSTRAINT import_sessions_file_hash_check
    CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT import_sessions_item_count_check
    CHECK (item_count BETWEEN 0 AND 10000),
  CONSTRAINT import_sessions_counter_ranges_check
    CHECK (
      valid_count >= 0
      AND duplicate_count >= 0
      AND invalid_count >= 0
      AND uncategorized_count >= 0
      AND imported_count >= 0
      AND valid_count + duplicate_count + invalid_count
        + uncategorized_count + imported_count <= item_count
    ),
  CONSTRAINT import_sessions_source_metadata_check
    CHECK (jsonb_typeof(source_metadata) = 'object'),
  CONSTRAINT import_sessions_status_timestamps_check
    CHECK (
      (status = 'processing'
        AND confirmed_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
        AND undone_at IS NULL)
      OR
      (status = 'preview'
        AND confirmed_at IS NULL
        AND completed_at IS NULL
        AND failed_at IS NULL
        AND undone_at IS NULL)
      OR
      (status = 'completed'
        AND confirmed_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND failed_at IS NULL
        AND undone_at IS NULL)
      OR
      (status = 'failed'
        AND completed_at IS NULL
        AND failed_at IS NOT NULL
        AND undone_at IS NULL)
      OR
      (status = 'undone'
        AND confirmed_at IS NOT NULL
        AND completed_at IS NOT NULL
        AND failed_at IS NULL
        AND undone_at IS NOT NULL)
    )
);

CREATE INDEX import_sessions_wallet_created_at_idx
  ON import_sessions (wallet_id, created_at DESC, id DESC);

CREATE INDEX import_sessions_wallet_status_updated_at_idx
  ON import_sessions (wallet_id, status, updated_at DESC, id DESC);

CREATE INDEX import_sessions_created_by_user_idx
  ON import_sessions (created_by_user_id, created_at DESC, id DESC);

CREATE TABLE import_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  import_session_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  sequence integer NOT NULL,
  transaction_date date NOT NULL,
  description text,
  signed_amount numeric NOT NULL,
  type text NOT NULL CHECK (type IN ('income', 'expense', 'transfer')),
  category_id uuid,
  subcategory_id uuid,
  category_nature text CHECK (category_nature IN ('income', 'expense')),
  validation_status text NOT NULL DEFAULT 'valid'
    CHECK (validation_status IN ('valid', 'duplicate', 'invalid', 'uncategorized', 'imported')),
  error_message text,
  external_id text,
  record_hash text,
  resulting_income_id uuid,
  resulting_expense_id uuid,
  resulting_updated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_items_session_wallet_fkey
    FOREIGN KEY (import_session_id, wallet_id)
    REFERENCES import_sessions (id, wallet_id) ON DELETE CASCADE,
  CONSTRAINT import_items_session_sequence_key UNIQUE (import_session_id, sequence),
  CONSTRAINT import_items_sequence_check CHECK (sequence BETWEEN 1 AND 10000),
  CONSTRAINT import_items_description_check
    CHECK (description IS NULL OR octet_length(description) <= 4000),
  CONSTRAINT import_items_signed_amount_precision_check
    CHECK (
      signed_amount <> 0
      AND abs(signed_amount) < 1000000000000
      AND signed_amount = trunc(signed_amount, 2)
    ),
  CONSTRAINT import_items_category_shape_check
    CHECK (
      (type = 'transfer'
        AND category_id IS NULL
        AND subcategory_id IS NULL
        AND category_nature IS NULL)
      OR
      (type IN ('income', 'expense')
        AND category_nature IS NOT NULL
        AND category_nature = type
        AND (subcategory_id IS NULL OR category_id IS NOT NULL))
    ),
  CONSTRAINT import_items_category_wallet_nature_fkey
    FOREIGN KEY (category_id, wallet_id, category_nature)
    REFERENCES categories (id, wallet_id, nature) ON DELETE NO ACTION,
  CONSTRAINT import_items_subcategory_wallet_category_fkey
    FOREIGN KEY (subcategory_id, wallet_id, category_id)
    REFERENCES subcategories (id, wallet_id, category_id) ON DELETE NO ACTION,
  CONSTRAINT import_items_invalid_reason_check
    CHECK (
      validation_status <> 'invalid'
      OR (error_message IS NOT NULL AND btrim(error_message) <> '')
    ),
  CONSTRAINT import_items_external_id_check
    CHECK (external_id IS NULL OR (btrim(external_id) <> '' AND octet_length(external_id) <= 512)),
  CONSTRAINT import_items_record_hash_check
    CHECK (record_hash IS NULL OR record_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT import_items_result_shape_check
    CHECK (
      (resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_updated_at IS NULL)
      OR
      (type IN ('income', 'expense')
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'income'
        AND validation_status = 'imported'
        AND resulting_income_id IS NOT NULL
        AND resulting_expense_id IS NULL
        AND resulting_updated_at IS NOT NULL)
      OR
      (type = 'expense'
        AND validation_status = 'imported'
        AND resulting_income_id IS NULL
        AND resulting_expense_id IS NOT NULL
        AND resulting_updated_at IS NOT NULL)
    ),
  CONSTRAINT import_items_resulting_income_wallet_fkey
    FOREIGN KEY (resulting_income_id, wallet_id)
    REFERENCES incomes (id, wallet_id)
    ON DELETE SET NULL (resulting_income_id),
  CONSTRAINT import_items_resulting_expense_wallet_fkey
    FOREIGN KEY (resulting_expense_id, wallet_id)
    REFERENCES expenses (id, wallet_id)
    ON DELETE SET NULL (resulting_expense_id)
);

CREATE INDEX import_items_session_status_sequence_idx
  ON import_items (import_session_id, validation_status, sequence);

CREATE INDEX import_items_wallet_transaction_date_idx
  ON import_items (wallet_id, transaction_date DESC, id DESC);

CREATE INDEX import_items_resulting_income_idx
  ON import_items (resulting_income_id)
  WHERE resulting_income_id IS NOT NULL;

CREATE INDEX import_items_resulting_expense_idx
  ON import_items (resulting_expense_id)
  WHERE resulting_expense_id IS NOT NULL;
