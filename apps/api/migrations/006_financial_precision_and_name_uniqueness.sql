SELECT pg_advisory_xact_lock(6052252091476);

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;

CREATE FUNCTION normalize_financial_name(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
RETURNS NULL ON NULL INPUT
AS $$
  SELECT lower(public.unaccent('public.unaccent'::regdictionary, btrim(input)))
$$;

ALTER TABLE categories
  ADD COLUMN name_normalized text;

ALTER TABLE subcategories
  ADD COLUMN name_normalized text;

ALTER TABLE investment_goals
  ADD COLUMN title_normalized text;

CREATE FUNCTION set_category_normalized_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.name_normalized := normalize_financial_name(NEW.name);
  RETURN NEW;
END;
$$;

CREATE FUNCTION set_goal_normalized_title()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.title_normalized := normalize_financial_name(NEW.title);
  RETURN NEW;
END;
$$;

CREATE TRIGGER categories_set_normalized_name
  BEFORE INSERT OR UPDATE ON categories
  FOR EACH ROW
  EXECUTE FUNCTION set_category_normalized_name();

CREATE TRIGGER subcategories_set_normalized_name
  BEFORE INSERT OR UPDATE ON subcategories
  FOR EACH ROW
  EXECUTE FUNCTION set_category_normalized_name();

CREATE TRIGGER investment_goals_set_normalized_title
  BEFORE INSERT OR UPDATE ON investment_goals
  FOR EACH ROW
  EXECUTE FUNCTION set_goal_normalized_title();

UPDATE categories SET name_normalized = normalize_financial_name(name);
UPDATE subcategories SET name_normalized = normalize_financial_name(name);
UPDATE investment_goals SET title_normalized = normalize_financial_name(title);

ALTER TABLE categories
  ALTER COLUMN name_normalized SET NOT NULL,
  ADD CONSTRAINT categories_name_normalized_nonempty_check
    CHECK (name_normalized <> '');

ALTER TABLE subcategories
  ALTER COLUMN name_normalized SET NOT NULL,
  ADD CONSTRAINT subcategories_name_normalized_nonempty_check
    CHECK (name_normalized <> '');

ALTER TABLE investment_goals
  ALTER COLUMN title_normalized SET NOT NULL,
  ADD CONSTRAINT investment_goals_title_normalized_nonempty_check
    CHECK (title_normalized <> '');

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM categories
    GROUP BY user_id, nature, name_normalized
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate category names after accent-insensitive normalization; resolve duplicates before applying migration 006';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM subcategories
    GROUP BY user_id, category_id, name_normalized
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate subcategory names after accent-insensitive normalization; resolve duplicates before applying migration 006';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM investment_goals
    GROUP BY user_id, title_normalized
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate investment goal names after accent-insensitive normalization; resolve duplicates before applying migration 006';
  END IF;
END;
$$;

DROP INDEX categories_user_nature_name_uidx;
DROP INDEX subcategories_user_category_name_uidx;

CREATE UNIQUE INDEX categories_user_nature_name_normalized_uidx
  ON categories (user_id, nature, name_normalized);

CREATE UNIQUE INDEX subcategories_user_category_name_normalized_uidx
  ON subcategories (user_id, category_id, name_normalized);

CREATE UNIQUE INDEX investment_goals_user_title_normalized_uidx
  ON investment_goals (user_id, title_normalized);

ALTER TABLE incomes
  DROP CONSTRAINT incomes_amount_check,
  ALTER COLUMN amount TYPE numeric USING amount::numeric,
  ADD CONSTRAINT incomes_amount_precision_check
    CHECK (amount > 0 AND amount < 1000000000000 AND amount = trunc(amount, 2));

ALTER TABLE expenses
  DROP CONSTRAINT expenses_amount_check,
  ALTER COLUMN amount TYPE numeric USING amount::numeric,
  ADD CONSTRAINT expenses_amount_precision_check
    CHECK (amount > 0 AND amount < 1000000000000 AND amount = trunc(amount, 2));

ALTER TABLE investment_goals
  DROP CONSTRAINT investment_goals_target_amount_check,
  ALTER COLUMN target_amount TYPE numeric USING target_amount::numeric,
  ADD CONSTRAINT investment_goals_target_amount_precision_check
    CHECK (target_amount > 0 AND target_amount < 1000000000000 AND target_amount = trunc(target_amount, 2));

ALTER TABLE investment_contributions
  DROP CONSTRAINT investment_contributions_amount_check,
  ALTER COLUMN amount TYPE numeric USING amount::numeric,
  ADD CONSTRAINT investment_contributions_amount_precision_check
    CHECK (amount > 0 AND amount < 1000000000000 AND amount = trunc(amount, 2));
