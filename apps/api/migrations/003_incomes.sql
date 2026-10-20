CREATE TABLE incomes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category_id uuid NOT NULL,
  subcategory_id uuid,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  date date NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  category_nature text NOT NULL DEFAULT 'income' CHECK (category_nature = 'income'),
  CONSTRAINT incomes_category_owner_nature_fkey
    FOREIGN KEY (category_id, user_id, category_nature)
    REFERENCES categories (id, user_id, nature)
    ON DELETE NO ACTION,
  CONSTRAINT incomes_subcategory_owner_category_fkey
    FOREIGN KEY (subcategory_id, user_id, category_id)
    REFERENCES subcategories (id, user_id, category_id)
    ON DELETE NO ACTION
);

CREATE INDEX incomes_user_date_created_at_idx
  ON incomes (user_id, date DESC, created_at DESC, id DESC);
