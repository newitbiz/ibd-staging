BEGIN;

-- Per-user dashboard card layouts (admin / investor / owner shells).
-- Additive / idempotent. Staging only.

CREATE TABLE IF NOT EXISTS dashboard_layouts (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_shell text NOT NULL CHECK (role_shell IN ('admin', 'investor', 'owner')),
  card_order jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_shell)
);

CREATE INDEX IF NOT EXISTS dashboard_layouts_user_idx
  ON dashboard_layouts (user_id);

COMMENT ON TABLE dashboard_layouts IS
  'Per-user ordered dashboard card keys for each role shell. Reordering never changes permissions or financials.';

COMMIT;
