#!/usr/bin/env sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

backup_directory="${BACKUP_DIRECTORY:-./backups}"
mkdir -p "$backup_directory"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_path="$backup_directory/grow_bangladesh_$timestamp.dump"
pg_dump --format=custom --no-owner --no-privileges --file="$output_path" "$DATABASE_URL"
echo "$output_path"
