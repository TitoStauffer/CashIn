CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  category_id uuid NOT NULL,
  subcategory_id uuid,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  date date NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  category_nature text NOT NULL DEFAULT 'expense' CHECK (category_nature = 'expense'),
  CONSTRAINT expenses_category_owner_nature_fkey
    FOREIGN KEY (category_id, user_id, category_nature)
    REFERENCES categories (id, user_id, nature)
    ON DELETE NO ACTION,
  CONSTRAINT expenses_subcategory_owner_category_fkey
    FOREIGN KEY (subcategory_id, user_id, category_id)
    REFERENCES subcategories (id, user_id, category_id)
    ON DELETE NO ACTION
);

CREATE INDEX expenses_user_date_created_at_idx
  ON expenses (user_id, date DESC, created_at DESC, id DESC);
