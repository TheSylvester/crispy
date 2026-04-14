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

## Tips

- **Search is cheap, reading is expensive.** Run 3-5 varied queries before committing to reading sessions.
- **Message IDs are stable.** You can reference them across searches.
- **Use `--since` to scope.** Both search and list modes accept `--since YYYY-MM-DD`.
- **Raw JSON output** (`--raw`) is available for programmatic processing.
