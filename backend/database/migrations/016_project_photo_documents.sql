BEGIN;

-- Project photo binary uploads: metadata/keys in Postgres, bytes in private storage.
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS photo_document_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN projects.photo_document_ids IS
  'Ordered private_documents UUIDs for project photos (JPEG/PNG). Never public permanent URLs.';

COMMIT;
