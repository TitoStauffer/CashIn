CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name text NOT NULL CHECK (btrim(name) <> ''),
  nature text NOT NULL CHECK (nature IN ('income', 'expense', 'investment_goal')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_id_user_id_key UNIQUE (id, user_id),
  CONSTRAINT categories_id_user_id_nature_key UNIQUE (id, user_id, nature)
);

CREATE UNIQUE INDEX categories_user_nature_name_uidx
  ON categories (user_id, nature, lower(btrim(name)));

CREATE TABLE subcategories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  category_id uuid NOT NULL,
  name text NOT NULL CHECK (btrim(name) <> ''),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subcategories_id_user_id_category_id_key
    UNIQUE (id, user_id, category_id),
  CONSTRAINT subcategories_category_owner_fkey
    FOREIGN KEY (category_id, user_id)
    REFERENCES categories (id, user_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX subcategories_user_category_name_uidx
  ON subcategories (user_id, category_id, lower(btrim(name)));

CREATE FUNCTION prevent_category_nature_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.nature IS DISTINCT FROM OLD.nature THEN
    RAISE EXCEPTION 'Category nature is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER categories_nature_immutable
  BEFORE UPDATE OF nature ON categories
  FOR EACH ROW
  EXECUTE FUNCTION prevent_category_nature_change();

COMMENT ON TABLE categories IS
  'Future financial movement and investment goal tables must reference categories and subcategories with ON DELETE RESTRICT (or NO ACTION), so category deletion cascades only to unreferenced subcategories.';

COMMENT ON TABLE subcategories IS
  'Nature is inherited from the parent category. Future financial movement and investment goal tables must reference subcategories with ON DELETE RESTRICT (or NO ACTION).';
