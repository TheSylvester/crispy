---
name: Backup Transcripts
description: This skill should be used when the user asks to "backup transcripts", "archive sessions", "save session history", "backup before Claude deletes", "preserve transcripts", or mentions protecting session data from deletion.
---

# Backup Claude Code Transcripts

Archive all Claude Code session transcripts as gzip files before Claude Code deletes them. Transcripts are ephemeral — Claude Code periodically cleans up old `.jsonl` files. This skill preserves them in `~/.crispy/recall/archive/`.

## When to Use

- Before any operation that might lose transcript data
- Periodically to ensure new sessions are backed up
- When the user mentions transcript preservation or data loss concerns

## Usage

```bash
${SKILL_ROOT}/scripts/backup-transcripts.sh
```

## What It Does

1. Scans all `.jsonl` transcripts in `~/.claude/projects/`
2. Compresses each to `~/.crispy/recall/archive/<project>__<session>.jsonl.gz`
3. Skips files already archived (idempotent — safe to run repeatedly)
4. Reports counts: new, skipped, errors, total archive size

## Notes

- Compressed transcripts achieve 85-95% size reduction (JSONL is highly compressible)
- Archives are named `<project-hash>__<session-uuid>.jsonl.gz` for uniqueness
- The archive survives even after Claude Code deletes the originals
- Future: these archives will feed a deep-index FTS5 search (see `recall-coverage-gaps.md`)
