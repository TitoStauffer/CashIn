CREATE TABLE wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  is_personal boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wallets_id_owner_user_id_key UNIQUE (id, owner_user_id)
);

CREATE UNIQUE INDEX wallets_one_personal_per_owner_uidx
  ON wallets (owner_user_id) WHERE is_personal;
CREATE UNIQUE INDEX wallets_owner_name_uidx
  ON wallets (owner_user_id, lower(btrim(name)));

CREATE TABLE wallet_members (
  wallet_id uuid NOT NULL REFERENCES wallets (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, user_id)
);

CREATE INDEX wallet_members_user_wallet_idx ON wallet_members (user_id, wallet_id);

CREATE FUNCTION add_wallet_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO wallet_members (wallet_id, user_id, role)
  VALUES (NEW.id, NEW.owner_user_id, 'owner');
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallets_add_owner_membership
  AFTER INSERT ON wallets
  FOR EACH ROW
  EXECUTE FUNCTION add_wallet_owner_membership();

CREATE FUNCTION protect_wallet_owner_membership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.role = 'owner' AND EXISTS (
    SELECT 1 FROM wallets AS wallet
    WHERE wallet.id = OLD.wallet_id AND wallet.owner_user_id = OLD.user_id
  ) THEN
    RAISE EXCEPTION 'Wallet owner membership cannot be removed or changed';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_members_protect_owner
  BEFORE UPDATE OR DELETE ON wallet_members
  FOR EACH ROW
  EXECUTE FUNCTION protect_wallet_owner_membership();

INSERT INTO wallets (owner_user_id, name, is_personal)
SELECT id, 'Pessoal', true
FROM users;

CREATE FUNCTION create_personal_wallet_for_user()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO wallets (owner_user_id, name, is_personal)
  VALUES (NEW.id, 'Pessoal', true);
  RETURN NEW;
END;
$$;

CREATE TRIGGER users_create_personal_wallet
  AFTER INSERT ON users
  FOR EACH ROW
  EXECUTE FUNCTION create_personal_wallet_for_user();

ALTER TABLE categories ADD COLUMN wallet_id uuid;
ALTER TABLE subcategories ADD COLUMN wallet_id uuid;
ALTER TABLE incomes ADD COLUMN wallet_id uuid;
ALTER TABLE expenses ADD COLUMN wallet_id uuid;
ALTER TABLE investment_goals ADD COLUMN wallet_id uuid;
ALTER TABLE investment_contributions ADD COLUMN wallet_id uuid;

UPDATE categories AS category
SET wallet_id = wallet.id
FROM wallets AS wallet
WHERE wallet.owner_user_id = category.user_id AND wallet.is_personal;

UPDATE subcategories AS subcategory
SET wallet_id = category.wallet_id
FROM categories AS category
WHERE category.id = subcategory.category_id;

UPDATE incomes AS movement
SET wallet_id = wallet.id
FROM wallets AS wallet
WHERE wallet.owner_user_id = movement.user_id AND wallet.is_personal;

UPDATE expenses AS movement
SET wallet_id = wallet.id
FROM wallets AS wallet
WHERE wallet.owner_user_id = movement.user_id AND wallet.is_personal;

UPDATE investment_goals AS goal
SET wallet_id = wallet.id
FROM wallets AS wallet
WHERE wallet.owner_user_id = goal.user_id AND wallet.is_personal;

UPDATE investment_contributions AS contribution
SET wallet_id = goal.wallet_id
FROM investment_goals AS goal
WHERE goal.id = contribution.goal_id;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM categories WHERE wallet_id IS NULL)
    OR EXISTS (SELECT 1 FROM subcategories WHERE wallet_id IS NULL)
    OR EXISTS (SELECT 1 FROM incomes WHERE wallet_id IS NULL)
    OR EXISTS (SELECT 1 FROM expenses WHERE wallet_id IS NULL)
    OR EXISTS (SELECT 1 FROM investment_goals WHERE wallet_id IS NULL)
    OR EXISTS (SELECT 1 FROM investment_contributions WHERE wallet_id IS NULL) THEN
    RAISE EXCEPTION 'Wallet backfill incomplete; no financial rows were changed permanently';
  END IF;

  IF EXISTS (
    SELECT 1 FROM subcategories AS subcategory
    JOIN categories AS category ON category.id = subcategory.category_id
    WHERE subcategory.wallet_id <> category.wallet_id
  ) OR EXISTS (
    SELECT 1 FROM incomes AS movement
    JOIN categories AS category ON category.id = movement.category_id
    WHERE movement.wallet_id <> category.wallet_id
  ) OR EXISTS (
    SELECT 1 FROM expenses AS movement
    JOIN categories AS category ON category.id = movement.category_id
    WHERE movement.wallet_id <> category.wallet_id
  ) OR EXISTS (
    SELECT 1 FROM investment_contributions AS contribution
    JOIN investment_goals AS goal ON goal.id = contribution.goal_id
    WHERE contribution.wallet_id <> goal.wallet_id
  ) THEN
    RAISE EXCEPTION 'Existing financial references cross wallet boundaries';
  END IF;
END;
$$;

ALTER TABLE categories ALTER COLUMN wallet_id SET NOT NULL;
ALTER TABLE subcategories ALTER COLUMN wallet_id SET NOT NULL;
ALTER TABLE incomes ALTER COLUMN wallet_id SET NOT NULL;
ALTER TABLE expenses ALTER COLUMN wallet_id SET NOT NULL;
ALTER TABLE investment_goals ALTER COLUMN wallet_id SET NOT NULL;
ALTER TABLE investment_contributions ALTER COLUMN wallet_id SET NOT NULL;

ALTER TABLE categories
  ADD CONSTRAINT categories_wallet_fkey FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE;
ALTER TABLE subcategories
  ADD CONSTRAINT subcategories_wallet_fkey FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE;
ALTER TABLE incomes
  ADD CONSTRAINT incomes_wallet_fkey FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_wallet_fkey FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE;
ALTER TABLE investment_goals
  ADD CONSTRAINT investment_goals_wallet_fkey FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE;
ALTER TABLE investment_contributions
  ADD CONSTRAINT investment_contributions_wallet_fkey FOREIGN KEY (wallet_id) REFERENCES wallets (id) ON DELETE CASCADE;

ALTER TABLE categories
  ADD CONSTRAINT categories_id_wallet_id_key UNIQUE (id, wallet_id),
  ADD CONSTRAINT categories_id_wallet_id_nature_key UNIQUE (id, wallet_id, nature);
ALTER TABLE subcategories
  ADD CONSTRAINT subcategories_id_wallet_id_category_id_key UNIQUE (id, wallet_id, category_id);
ALTER TABLE investment_goals
  ADD CONSTRAINT investment_goals_id_wallet_id_key UNIQUE (id, wallet_id);

ALTER TABLE subcategories DROP CONSTRAINT subcategories_category_owner_fkey;
ALTER TABLE subcategories
  ADD CONSTRAINT subcategories_category_wallet_fkey
    FOREIGN KEY (category_id, wallet_id)
    REFERENCES categories (id, wallet_id) ON DELETE CASCADE;

ALTER TABLE incomes DROP CONSTRAINT incomes_category_owner_nature_fkey;
ALTER TABLE incomes DROP CONSTRAINT incomes_subcategory_owner_category_fkey;
ALTER TABLE incomes
  ADD CONSTRAINT incomes_category_wallet_nature_fkey
    FOREIGN KEY (category_id, wallet_id, category_nature)
    REFERENCES categories (id, wallet_id, nature) ON DELETE NO ACTION,
  ADD CONSTRAINT incomes_subcategory_wallet_category_fkey
    FOREIGN KEY (subcategory_id, wallet_id, category_id)
    REFERENCES subcategories (id, wallet_id, category_id) ON DELETE NO ACTION;

ALTER TABLE expenses DROP CONSTRAINT expenses_category_owner_nature_fkey;
ALTER TABLE expenses DROP CONSTRAINT expenses_subcategory_owner_category_fkey;
ALTER TABLE expenses
  ADD CONSTRAINT expenses_category_wallet_nature_fkey
    FOREIGN KEY (category_id, wallet_id, category_nature)
    REFERENCES categories (id, wallet_id, nature) ON DELETE NO ACTION,
  ADD CONSTRAINT expenses_subcategory_wallet_category_fkey
    FOREIGN KEY (subcategory_id, wallet_id, category_id)
    REFERENCES subcategories (id, wallet_id, category_id) ON DELETE NO ACTION;

ALTER TABLE investment_goals DROP CONSTRAINT investment_goals_category_owner_nature_fkey;
ALTER TABLE investment_goals DROP CONSTRAINT investment_goals_subcategory_owner_category_fkey;
ALTER TABLE investment_goals
  ADD CONSTRAINT investment_goals_category_wallet_nature_fkey
    FOREIGN KEY (category_id, wallet_id, category_nature)
    REFERENCES categories (id, wallet_id, nature)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT investment_goals_subcategory_wallet_category_fkey
    FOREIGN KEY (subcategory_id, wallet_id, category_id)
    REFERENCES subcategories (id, wallet_id, category_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE investment_contributions DROP CONSTRAINT investment_contributions_goal_owner_fkey;
ALTER TABLE investment_contributions
  ADD CONSTRAINT investment_contributions_goal_wallet_fkey
    FOREIGN KEY (goal_id, wallet_id)
    REFERENCES investment_goals (id, wallet_id)
    ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

DROP INDEX categories_user_nature_name_normalized_uidx;
DROP INDEX subcategories_user_category_name_normalized_uidx;
DROP INDEX investment_goals_user_title_normalized_uidx;

DO $$
DECLARE
  conflict_details text;
BEGIN
  SELECT string_agg(conflict, '; ' ORDER BY conflict)
  INTO conflict_details
  FROM (
    SELECT format('categories wallet=%s ids=%s count=%s', wallet_id,
      array_agg(id ORDER BY id), count(*)) AS conflict
    FROM categories
    GROUP BY wallet_id, nature, name_normalized HAVING count(*) > 1
    UNION ALL
    SELECT format('subcategories wallet=%s ids=%s count=%s', wallet_id,
      array_agg(id ORDER BY id), count(*))
    FROM subcategories
    GROUP BY wallet_id, category_id, name_normalized HAVING count(*) > 1
    UNION ALL
    SELECT format('investment_goals wallet=%s ids=%s count=%s', wallet_id,
      array_agg(id ORDER BY id), count(*))
    FROM investment_goals
    GROUP BY wallet_id, title_normalized HAVING count(*) > 1
    LIMIT 10
  ) AS conflicts;

  IF conflict_details IS NOT NULL THEN
    RAISE EXCEPTION 'Existing wallet uniqueness conflicts; no records were merged or deleted: %', conflict_details;
  END IF;
END;
$$;

CREATE UNIQUE INDEX categories_wallet_nature_name_normalized_uidx
  ON categories (wallet_id, nature, name_normalized);
CREATE UNIQUE INDEX subcategories_wallet_category_name_normalized_uidx
  ON subcategories (wallet_id, category_id, name_normalized);
CREATE UNIQUE INDEX investment_goals_wallet_title_normalized_uidx
  ON investment_goals (wallet_id, title_normalized);

CREATE INDEX categories_wallet_nature_name_idx ON categories (wallet_id, nature, lower(name));
CREATE INDEX incomes_wallet_date_created_at_idx
  ON incomes (wallet_id, date DESC, created_at DESC, id DESC);
CREATE INDEX expenses_wallet_date_created_at_idx
  ON expenses (wallet_id, date DESC, created_at DESC, id DESC);
CREATE INDEX investment_goals_wallet_created_at_idx
  ON investment_goals (wallet_id, created_at DESC, id DESC);
CREATE INDEX investment_contributions_wallet_goal_date_idx
  ON investment_contributions (wallet_id, goal_id, date DESC, created_at DESC, id DESC);
