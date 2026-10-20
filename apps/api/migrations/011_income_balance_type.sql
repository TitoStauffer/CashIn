ALTER TABLE incomes
  ADD COLUMN balance_type text NOT NULL DEFAULT 'cash',
  ADD CONSTRAINT incomes_balance_type_check
    CHECK (
      balance_type IN (
        'cash',
        'food_benefit',
        'meal_benefit',
        'home_office_benefit'
      )
    );
