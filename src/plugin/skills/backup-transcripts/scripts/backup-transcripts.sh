#!/usr/bin/env bash
set -euo pipefail

# Backup all Claude Code session transcripts as gzip archives.
# Transcripts are ephemeral — Claude Code deletes old .jsonl files.
# This script preserves them in ~/.crispy/recall/archive/ before they vanish.

ARCHIVE_DIR="${HOME}/.crispy/recall/archive"
SOURCE_DIR="${HOME}/.claude/projects"

mkdir -p "$ARCHIVE_DIR"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "No transcripts found at $SOURCE_DIR"
  exit 0
fi

count=0
skipped=0
errors=0

for f in "$SOURCE_DIR"/*/*.jsonl; do
  [ -f "$f" ] || continue
  base=$(basename "$f" .jsonl)
  project=$(basename "$(dirname "$f")")
  dest="${ARCHIVE_DIR}/${project}__${base}.jsonl.gz"

  if [ -f "$dest" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  if gzip -c "$f" > "$dest" 2>/dev/null; then
    count=$((count + 1))
  else
    errors=$((errors + 1))
    rm -f "$dest"
  fi
done

total=$(find "$ARCHIVE_DIR" -name '*.gz' 2>/dev/null | wc -l)
size=$(du -sh "$ARCHIVE_DIR" 2>/dev/null | cut -f1)

echo "Backup complete:"
echo "  New:     $count"
echo "  Skipped: $skipped (already archived)"
echo "  Errors:  $errors"
echo "  Total:   $total archives ($size)"
