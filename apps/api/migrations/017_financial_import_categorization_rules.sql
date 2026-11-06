CREATE TABLE financial_import_categorization_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  movement_type text NOT NULL CHECK (movement_type IN ('income', 'expense')),
  description text NOT NULL,
  normalized_description text NOT NULL,
  category_id uuid NOT NULL,
  subcategory_id uuid,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Constraint names stay under PostgreSQL's 63-byte identifier limit.
  CONSTRAINT financial_import_rules_description_check
    CHECK (btrim(description) <> '' AND octet_length(description) <= 512),
  CONSTRAINT financial_import_rules_normalized_description_check
    CHECK (btrim(normalized_description) <> '' AND octet_length(normalized_description) <= 512),
  CONSTRAINT financial_import_rules_wallet_type_description_key
    UNIQUE (wallet_id, movement_type, normalized_description)
);

CREATE INDEX financial_import_rules_wallet_active_idx
  ON financial_import_categorization_rules (wallet_id, is_active, movement_type);

ALTER TABLE import_items
  ADD COLUMN categorization_source text
    CONSTRAINT import_items_categorization_source_check
    CHECK (categorization_source IS NULL OR categorization_source IN ('rule', 'manual'));

-- Category references intentionally have no FK: deleting a category must leave its rule
-- visible as stale so a user can reclassify it, instead of breaking history or imports.
