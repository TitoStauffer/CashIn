ALTER TABLE payment_methods
  DROP CONSTRAINT payment_methods_nature_check,
  ADD CONSTRAINT payment_methods_nature_check
    CHECK (
      nature IN (
        'immediate',
        'credit_card',
        'food_benefit',
        'meal_benefit',
        'food_meal_benefit',
        'home_office_benefit'
      )
    );

ALTER TABLE incomes
  DROP CONSTRAINT incomes_balance_type_check,
  ADD CONSTRAINT incomes_balance_type_check
    CHECK (
      balance_type IN (
        'cash',
        'food_benefit',
        'meal_benefit',
        'food_meal_benefit',
        'home_office_benefit'
      )
    );

ALTER TABLE expenses
  DROP CONSTRAINT expenses_payment_method_nature_check,
  ADD CONSTRAINT expenses_payment_method_nature_check
    CHECK (
      payment_method_nature IN (
        'immediate',
        'credit_card',
        'food_benefit',
        'meal_benefit',
        'food_meal_benefit',
        'home_office_benefit'
      )
    );

UPDATE payment_methods
SET nature = 'food_meal_benefit', is_active = false, updated_at = now()
WHERE name_normalized IN ('vale-alimentacao', 'vale-refeicao')
  AND nature IN ('food_benefit', 'meal_benefit');

DO $$
DECLARE
  target_wallet_id uuid;
  benefit_name text;
  name_suffix bigint;
BEGIN
  FOR target_wallet_id IN
    SELECT wallet.id
    FROM wallets AS wallet
    WHERE NOT EXISTS (
      SELECT 1 FROM payment_methods AS method
      WHERE method.wallet_id = wallet.id
        AND method.nature = 'food_meal_benefit'
        AND method.is_active
    )
  LOOP
    name_suffix := 0;
    LOOP
      benefit_name := 'Cartão de benefícios (VA/VR)';
      IF name_suffix > 0 THEN
        benefit_name := benefit_name || ' (' || name_suffix || ')';
      END IF;

      -- Preserve colliding methods and try names until the unique index accepts one.
      INSERT INTO payment_methods (wallet_id, name, nature)
      VALUES (target_wallet_id, benefit_name, 'food_meal_benefit')
      ON CONFLICT (wallet_id, name_normalized) DO NOTHING;
      EXIT WHEN FOUND;
      name_suffix := name_suffix + 1;
    END LOOP;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION seed_default_payment_methods(target_wallet_id uuid)
RETURNS void
LANGUAGE sql
AS $$
  INSERT INTO payment_methods (wallet_id, name, nature)
  VALUES
    (target_wallet_id, 'Crédito', 'credit_card'),
    (target_wallet_id, 'Débito', 'immediate'),
    (target_wallet_id, 'Pix', 'immediate'),
    (target_wallet_id, 'Cartão de benefícios (VA/VR)', 'food_meal_benefit'),
    (target_wallet_id, 'Auxílio Home Office', 'home_office_benefit')
  ON CONFLICT (wallet_id, name_normalized) DO NOTHING;
$$;
