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

INSERT INTO payment_methods (wallet_id, name, nature)
SELECT wallet.id, 'Cartão de benefícios (VA/VR)', 'food_meal_benefit'
FROM wallets AS wallet
ON CONFLICT (wallet_id, name_normalized) DO NOTHING;

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
