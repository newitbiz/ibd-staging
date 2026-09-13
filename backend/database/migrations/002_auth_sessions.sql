BEGIN;

CREATE TABLE IF NOT EXISTS otp_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('registration', 'login', 'password_reset')),
  destination text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS otp_challenges_user_idx ON otp_challenges(user_id, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx ON password_reset_tokens(user_id, created_at DESC);

ALTER TABLE refresh_tokens
  ADD COLUMN IF NOT EXISTS replaced_by uuid REFERENCES refresh_tokens(id),
  ADD COLUMN IF NOT EXISTS family_id uuid;

UPDATE refresh_tokens
SET family_id = id
WHERE family_id IS NULL;

CREATE INDEX IF NOT EXISTS refresh_tokens_user_idx ON refresh_tokens(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family_id);

COMMIT;
