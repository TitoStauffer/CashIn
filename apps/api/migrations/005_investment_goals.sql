-- Keep the legacy investment_goal value valid while introducing investment.
ALTER TABLE categories
  DROP CONSTRAINT categories_nature_check,
  ADD CONSTRAINT categories_nature_check
    CHECK (nature IN ('income', 'expense', 'investment_goal', 'investment'));

CREATE TABLE investment_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title text NOT NULL CHECK (btrim(title) <> ''),
  description text,
  target_amount numeric(14, 2) NOT NULL CHECK (target_amount > 0),
  due_date date,
  closed_at timestamptz,
  category_id uuid,
  subcategory_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  category_nature text NOT NULL DEFAULT 'investment'
    CHECK (category_nature IN ('investment', 'investment_goal')),
  CONSTRAINT investment_goals_id_user_id_key UNIQUE (id, user_id),
  CONSTRAINT investment_goals_category_owner_nature_fkey
    FOREIGN KEY (category_id, user_id, category_nature)
    REFERENCES categories (id, user_id, nature)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT investment_goals_subcategory_owner_category_fkey
    FOREIGN KEY (subcategory_id, user_id, category_id)
    REFERENCES subcategories (id, user_id, category_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX investment_goals_user_created_at_idx
  ON investment_goals (user_id, created_at DESC, id DESC);

CREATE TABLE investment_contributions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  goal_id uuid NOT NULL,
  amount numeric(14, 2) NOT NULL CHECK (amount > 0),
  date date NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT investment_contributions_goal_owner_fkey
    FOREIGN KEY (goal_id, user_id)
    REFERENCES investment_goals (id, user_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX investment_contributions_user_goal_date_idx
  ON investment_contributions (user_id, goal_id, date DESC, created_at DESC, id DESC);

COMMENT ON TABLE investment_goals IS
  'Investment goals are owned by a user. A NULL closed_at means active; a timestamp means closed. Referenced categories cannot be deleted.';

COMMENT ON TABLE investment_contributions IS
  'Contributions belong to the same user as their investment goal. A goal cannot be deleted while contributions reference it.';
