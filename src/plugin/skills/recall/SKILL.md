---
name: recall
description: Search, read, and browse past session transcripts. Use when recalling past work, finding sessions by topic, reading specific sessions, or investigating what was discussed.
allowed-tools: Bash, Agent, Read
---

# Recall

Unified tool for session transcript memory — search, read, and browse.

## The two-step pattern

**Step 1: Search.** Every search result includes a matched message ID.

```bash
$RECALL_CLI "your query here"
```

**Step 2: Read the matched message.** Do NOT read the session from the top.

```bash
$RECALL_CLI <session-id> <message-id>
```

This auto-centers on the match with ~30% context before and ~70% after,
filling up to the output budget. The footer tells you the exact `--offset`
to continue reading forward.

**NEVER start a session read from the top after searching.** The search
already found the relevant message — go directly to it. Only use
`$RECALL_CLI <id>` (no message-id) when you genuinely need to start
from the beginning of a session.

## Confidence tags

Search results are tagged by how they were found:
- `[FTS5+SEMANTIC]` — Both keyword and meaning matched. High confidence.
- `[SEMANTIC-ONLY]` — Found by meaning, not exact words. Vocabulary mismatch discovery.
- `[FTS5-ONLY]` — Exact keyword match only. May be coincidental.

## Sub-agent pattern (recommended for deep research)

For questions requiring multiple searches or reading session content, launch a sub-agent.
The agent prompt **must** include full CLI instructions — sub-agents don't see this skill file.

```
Agent(prompt: "You have a recall CLI for searching and reading past session transcripts.
Use ONLY `$RECALL_CLI` for all transcript access — do NOT read .jsonl files directly,
do NOT use Grep/Glob/find to locate transcripts.

CLI usage:
  $RECALL_CLI \"query\"                    Search (returns session IDs + matched message IDs)
  $RECALL_CLI <session-id> <message-id>   Read centered on matched message (use this after search)
  $RECALL_CLI <session-id>                Read from beginning (only when you need full arc)
  $RECALL_CLI <session-id> --offset N     Continue reading from offset N (shown in output footer)
  $RECALL_CLI --list --since YYYY-MM-DD   List recent sessions
  $RECALL_CLI --help                      Full flag reference

DATE HANDLING: Any date the user mentions MUST become a flag — never search text:
  --since YYYY-MM-DD   Only sessions on or after this date
  --until YYYY-MM-DD   Only sessions on or before this date (inclusive)
  --recent             Boost recent sessions (use when user says 'recently', 'latest')
  Example: \"what happened April 10\" → $RECALL_CLI --list --since 2026-04-10 --until 2026-04-10

CRITICAL READING RULE: After searching, ALWAYS read the matched message:
  $RECALL_CLI <session-id> <message-id>
This auto-centers on the match and shows surrounding turns. The output
footer shows the --offset to continue reading forward. NEVER read sessions
from the beginning after a search — the match is already found for you.

Task: [describe what to find]. Run these searches: [list queries].
Search EXHAUSTIVELY — do not stop after the first promising result. Run all
listed queries, read into multiple results, and only report findings after
you have checked every search path. Cross-reference results and summarize.",
mode: "auto")
```

## Other reading modes

| Mode | Command | When to use |
|------|---------|-------------|
| **Matched message** | `$RECALL_CLI <id> <msg-id>` | **Always use this after search** — auto-centers on match |
| Full session | `$RECALL_CLI <id>` | Only when you need the overall arc, not a specific answer |
| Continue | `$RECALL_CLI <id> --offset N` | Continue from where the last read left off |
| Newest first | `$RECALL_CLI <id> --reverse` | Looking for recent content in a long session |

## Date handling

**Any date or time indication from the user MUST be translated into date flags.**
Do NOT put dates into the search query text — dates in FTS5 produce false matches.

```bash
# Single day — use --since and --until together
$RECALL_CLI --list --since 2026-04-10 --until 2026-04-10
$RECALL_CLI "scroll bug" --since 2026-04-10 --until 2026-04-10

# Open range — just one flag
$RECALL_CLI "recall improvements" --since 2026-04-01
$RECALL_CLI "old bug" --until 2026-03-15
```

- `--since DATE` — only sessions on or after this date
- `--until DATE` — only sessions on or before this date (inclusive of the day)
- Both accept ISO-8601 dates (YYYY-MM-DD)
- Both work in search and list modes

**Example:** "What did we work on April 10?" →
`$RECALL_CLI --list --since 2026-04-10 --until 2026-04-10` to find all sessions,
then search with topic keywords + date flags if needed.

## Recency boost

When the user says "recently", "latest", "last few days", or otherwise indicates
they want recent results, add `--recent` to strongly boost newer sessions:

```bash
$RECALL_CLI "scroll bug fix" --recent
```

This increases the recency decay from ~50% penalty at 50 days to ~50% at 10 days,
pushing recent sessions to the top of results. Combine with `--since` for best results.

## Tips

- **Search is cheap, reading is expensive.** Run 3-5 varied queries before committing to reading sessions.
- **Message IDs are stable.** You can reference them across searches.
- **Use `--since` / `--until` to scope.** Both search and list modes accept date flags.
- **Raw JSON output** (`--raw`) is available for programmatic processing.
