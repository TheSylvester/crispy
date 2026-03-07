---
paths:
  - ".claude/**"
---

## .claude/ folder is gitignored but snapshot-committed

The `.claude/` directory is in `.gitignore`, so git won't track changes
automatically. Local copies are never affected by pulls or branch switches.

When the user modifies files in `.claude/` (commands, rules, skills) and wants
them in the repo:

1. **Force-add** the specific files: `git add -f .claude/path/to/file`
2. **Never add** `settings.local.json` — it's personal config
3. **Commit normally** — the files will be in that commit's tree
4. Future local edits won't show up in `git status` (still ignored)
5. To push updates later, repeat: `git add -f` then commit
