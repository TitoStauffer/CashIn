ALTER TABLE expenses
  ADD COLUMN payment_method_nature text;

UPDATE expenses AS expense
SET payment_method_nature = payment_method.nature
FROM payment_methods AS payment_method
WHERE payment_method.id = expense.payment_method_id
  AND payment_method.wallet_id = expense.wallet_id;

ALTER TABLE expenses
  ADD CONSTRAINT expenses_payment_method_nature_check
    CHECK (
      payment_method_nature IN (
        'immediate',
        'credit_card',
        'food_benefit',
        'meal_benefit',
        'home_office_benefit'
      )
    );
