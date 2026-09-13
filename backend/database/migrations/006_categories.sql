BEGIN;

CREATE TABLE IF NOT EXISTS categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL,
  description text,
  icon_url text,
  is_active boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT categories_name_nonempty CHECK (char_length(trim(name)) >= 2),
  CONSTRAINT categories_slug_format CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT categories_slug_unique UNIQUE (slug)
);

CREATE UNIQUE INDEX IF NOT EXISTS categories_name_lower_uidx
  ON categories (lower(name));

CREATE INDEX IF NOT EXISTS categories_active_order_idx
  ON categories (is_active, display_order ASC, name ASC);

DROP TRIGGER IF EXISTS categories_set_updated_at ON categories;
CREATE TRIGGER categories_set_updated_at
BEFORE UPDATE ON categories
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Seed common marketplace categories (idempotent by slug).
INSERT INTO categories (name, slug, description, icon_url, is_active, display_order)
VALUES
  ('Manufacturing', 'manufacturing', 'Factories, garments, and light industry', NULL, true, 10),
  ('Agriculture', 'agriculture', 'Farming, agro-processing, and fisheries', NULL, true, 20),
  ('Retail', 'retail', 'Shops and consumer retail', NULL, true, 30),
  ('Technology', 'technology', 'Software, IT services, and digital products', NULL, true, 40),
  ('Renewable Energy', 'renewable-energy', 'Solar, wind, and clean energy projects', NULL, true, 50)
ON CONFLICT (slug) DO NOTHING;

COMMIT;
