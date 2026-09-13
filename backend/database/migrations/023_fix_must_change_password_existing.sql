BEGIN;

-- Existing staging users must NOT be forced through the admin-created password gate.
-- Only accounts explicitly created by admin (created_by_admin=true) keep must_change_password.
UPDATE users
SET must_change_password = false,
    updated_at = now()
WHERE COALESCE(created_by_admin, false) = false
  AND must_change_password = true;

COMMIT;
