ALTER TABLE import_items
  ADD COLUMN duplicate_override_allowed boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT import_items_duplicate_override_allowed_check
    CHECK (NOT duplicate_override_allowed OR validation_status = 'duplicate');

CREATE INDEX import_items_wallet_external_id_imported_idx
  ON import_items (wallet_id, external_id)
  WHERE validation_status = 'imported'
    AND external_id IS NOT NULL;

CREATE INDEX import_items_wallet_record_hash_imported_idx
  ON import_items (wallet_id, record_hash)
  WHERE validation_status = 'imported'
    AND record_hash IS NOT NULL;
