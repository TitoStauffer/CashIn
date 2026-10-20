CREATE TABLE payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  name text NOT NULL,
  name_normalized text NOT NULL,
  nature text NOT NULL CHECK (
    nature IN (
      'immediate',
      'credit_card',
      'food_benefit',
      'meal_benefit',
      'home_office_benefit'
    )
  ),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_methods_name_trimmed_nonempty_check
    CHECK (btrim(name) <> '' AND name_normalized <> ''),
  CONSTRAINT payment_methods_id_wallet_id_key UNIQUE (id, wallet_id),
  CONSTRAINT payment_methods_id_wallet_id_nature_key UNIQUE (id, wallet_id, nature)
);

CREATE FUNCTION set_payment_method_normalized_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.name_normalized := normalize_financial_name(NEW.name);
  RETURN NEW;
END;
$$;

CREATE TRIGGER payment_methods_set_normalized_name
  BEFORE INSERT OR UPDATE ON payment_methods
  FOR EACH ROW
  EXECUTE FUNCTION set_payment_method_normalized_name();

CREATE UNIQUE INDEX payment_methods_wallet_name_normalized_uidx
  ON payment_methods (wallet_id, name_normalized);

CREATE FUNCTION seed_default_payment_methods(target_wallet_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO payment_methods (wallet_id, name, nature)
  VALUES
    (target_wallet_id, 'Crédito', 'credit_card'),
    (target_wallet_id, 'Débito', 'immediate'),
    (target_wallet_id, 'Pix', 'immediate'),
    (target_wallet_id, 'Vale-Alimentação', 'food_benefit'),
    (target_wallet_id, 'Vale-Refeição', 'meal_benefit'),
    (target_wallet_id, 'Auxílio Home Office', 'home_office_benefit')
  ON CONFLICT (wallet_id, name_normalized) DO NOTHING;
$$;

ALTER TABLE expenses
  ADD COLUMN payment_method_id uuid,
  ADD CONSTRAINT expenses_payment_method_wallet_fkey
    FOREIGN KEY (payment_method_id, wallet_id)
    REFERENCES payment_methods (id, wallet_id);

CREATE INDEX expenses_payment_method_wallet_idx
  ON expenses (payment_method_id, wallet_id);

SELECT seed_default_payment_methods(wallet.id)
FROM wallets AS wallet;

CREATE FUNCTION seed_wallet_payment_methods()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM seed_default_payment_methods(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallets_seed_default_payment_methods
  AFTER INSERT ON wallets
  FOR EACH ROW
  EXECUTE FUNCTION seed_wallet_payment_methods();
