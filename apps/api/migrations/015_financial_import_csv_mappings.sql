CREATE TABLE financial_import_csv_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  name text NOT NULL,
  configuration jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT financial_import_csv_mappings_id_wallet_id_key UNIQUE (id, wallet_id),
  CONSTRAINT financial_import_csv_mappings_name_check
    CHECK (btrim(name) <> '' AND octet_length(name) <= 255),
  CONSTRAINT financial_import_csv_mappings_configuration_check
    CHECK (
      jsonb_typeof(configuration) = 'object'
      AND octet_length(configuration::text) <= 65536
      AND configuration ?& ARRAY[
        'delimiter',
        'encoding',
        'hasHeader',
        'dateFormat',
        'numberFormat',
        'columns'
      ]
      AND (configuration - ARRAY[
        'delimiter', 'encoding', 'hasHeader', 'dateFormat', 'numberFormat', 'columns'
      ]) = '{}'::jsonb
      AND jsonb_typeof(configuration -> 'delimiter') = 'string'
      AND configuration ->> 'delimiter' IN (',', ';')
      AND jsonb_typeof(configuration -> 'encoding') = 'string'
      AND configuration ->> 'encoding' IN ('utf-8', 'windows-1252', 'iso-8859-1')
      AND jsonb_typeof(configuration -> 'hasHeader') = 'boolean'
      AND jsonb_typeof(configuration -> 'dateFormat') = 'string'
      AND configuration ->> 'dateFormat' IN ('dd/MM/yyyy', 'MM/dd/yyyy', 'yyyy-MM-dd')
      AND jsonb_typeof(configuration -> 'numberFormat') = 'string'
      AND configuration ->> 'numberFormat' IN ('pt-BR', 'en-US')
      AND jsonb_typeof(configuration -> 'columns') = 'object'
      AND configuration -> 'columns' ?& ARRAY[
        'date', 'description', 'amount', 'credit', 'debit', 'externalId'
      ]
      AND ((configuration -> 'columns') - ARRAY[
        'date', 'description', 'amount', 'credit', 'debit', 'externalId'
      ]) = '{}'::jsonb
      AND jsonb_typeof(configuration -> 'columns' -> 'date') = 'number'
      AND (configuration -> 'columns' ->> 'date') ~ '^[0-9]+$'
      AND (
        NOT (configuration -> 'columns' ? 'description')
        OR jsonb_typeof(configuration -> 'columns' -> 'description') = 'null'
        OR (
          jsonb_typeof(configuration -> 'columns' -> 'description') = 'number'
          AND (configuration -> 'columns' ->> 'description') ~ '^[0-9]+$'
        )
      )
      AND (
        NOT (configuration -> 'columns' ? 'externalId')
        OR jsonb_typeof(configuration -> 'columns' -> 'externalId') = 'null'
        OR (
          jsonb_typeof(configuration -> 'columns' -> 'externalId') = 'number'
          AND (configuration -> 'columns' ->> 'externalId') ~ '^[0-9]+$'
        )
      )
      AND (
        NOT (configuration -> 'columns' ? 'amount')
        OR jsonb_typeof(configuration -> 'columns' -> 'amount') = 'null'
        OR (
          jsonb_typeof(configuration -> 'columns' -> 'amount') = 'number'
          AND (configuration -> 'columns' ->> 'amount') ~ '^[0-9]+$'
        )
      )
      AND (
        NOT (configuration -> 'columns' ? 'credit')
        OR jsonb_typeof(configuration -> 'columns' -> 'credit') = 'null'
        OR (
          jsonb_typeof(configuration -> 'columns' -> 'credit') = 'number'
          AND (configuration -> 'columns' ->> 'credit') ~ '^[0-9]+$'
        )
      )
      AND (
        NOT (configuration -> 'columns' ? 'debit')
        OR jsonb_typeof(configuration -> 'columns' -> 'debit') = 'null'
        OR (
          jsonb_typeof(configuration -> 'columns' -> 'debit') = 'number'
          AND (configuration -> 'columns' ->> 'debit') ~ '^[0-9]+$'
        )
      )
      AND (
        jsonb_typeof(configuration -> 'columns' -> 'amount') = 'number'
      ) <> (
        jsonb_typeof(configuration -> 'columns' -> 'credit') = 'number'
        AND jsonb_typeof(configuration -> 'columns' -> 'debit') = 'number'
      )
    )
);

CREATE UNIQUE INDEX financial_import_csv_mappings_wallet_name_uidx
  ON financial_import_csv_mappings (wallet_id, lower(btrim(name)));

CREATE INDEX financial_import_csv_mappings_wallet_updated_at_idx
  ON financial_import_csv_mappings (wallet_id, updated_at DESC, id DESC);

CREATE INDEX financial_import_csv_mappings_creator_created_at_idx
  ON financial_import_csv_mappings (created_by_user_id, created_at DESC, id DESC);
