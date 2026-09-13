BEGIN;

-- Extend support_cases / support_messages for Admin messaging centre.
-- Internal notes must never be returned to end users.

ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS category text
  CHECK (category IS NULL OR category IN (
    'general', 'project', 'investment', 'payment', 'kyc', 'disbursement', 'other'
  ));
ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS related_application_id uuid REFERENCES investment_applications(id);
ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS related_payment_id uuid;
ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS unread_for_user integer NOT NULL DEFAULT 0;
ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS unread_for_staff integer NOT NULL DEFAULT 0;
ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS reopened_at timestamptz;
ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS last_message_at timestamptz;
ALTER TABLE support_cases ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Allow reopen path: ensure status check includes existing values (already has open/under_review/waiting_user/resolved/closed).

ALTER TABLE support_messages ADD COLUMN IF NOT EXISTS is_internal_note boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS support_cases_assigned_idx
  ON support_cases (assigned_to, status, opened_at DESC);
CREATE INDEX IF NOT EXISTS support_cases_unread_staff_idx
  ON support_cases (unread_for_staff DESC, last_message_at DESC NULLS LAST);

COMMENT ON COLUMN support_messages.is_internal_note IS
  'Staff-only note. Never expose to investors/owners in API responses.';

COMMIT;
