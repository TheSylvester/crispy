---
name: recall
description: Search, read, and browse past session transcripts. Use when recalling past work, finding sessions by topic, reading specific sessions, or investigating what was discussed.
allowed-tools: Bash, Agent, Read
---

# Recall

Unified tool for session transcript memory — search, read, and browse.

## Quick start

```bash
# Search for sessions about a topic
Bash(command: "node $RECALL_CLI \"your query here\"")

# Read a specific session by ID (shows paginated messages)
Bash(command: "node $RECALL_CLI <session-id>")

# Read a specific turn with context
Bash(command: "node $RECALL_CLI <session-id> <message-id> --context 3")

# Browse recent sessions
Bash(command: "node $RECALL_CLI --list")

# Full usage
Bash(command: "node $RECALL_CLI --help")
```

## Reading sessions

After search finds relevant session IDs, **read into them** to get actual content:

```bash
# Read first 20 messages of a session
node $RECALL_CLI a1b2c3d4

# Paginate through a long session
node $RECALL_CLI a1b2c3d4 --offset 20

# Read a specific message turn with surrounding context
node $RECALL_CLI a1b2c3d4 e5f6a7b8 --context 3
```

The read output includes a pagination footer when more messages are available:
`--- Use --offset 20 to see more ---`

**Always follow up searches by reading the most promising sessions.** Snippets in search results are just previews — the full session content has the real context.

## Search pagination

Search results are paginated at 75 sessions per page. When more sessions match, you'll see:
`--- Showing 1-75 of 305 sessions. Next page: --offset 75 ---`

**If the first page doesn't contain what you're looking for, paginate.** The answer may be on a later page — especially for broad queries.

## Sub-agent pattern (recommended for deep research)

For questions requiring multiple searches or reading session content, launch a sub-agent:

```
Agent(prompt: "Use `node $RECALL_CLI \"query\"` to search session transcripts.
Then use `node $RECALL_CLI <session-id>` to read promising sessions.
Run these searches: [list queries]. Cross-reference results and summarize findings.",
mode: "auto")
```

## Options

| Flag | Description |
|------|-------------|
| `--limit N` | Result ceiling (search: 200, list: 50, read: 20) |
| `--offset N` | Pagination offset (search: sessions, read: messages; default 0) |
| `--raw` | JSON output for programmatic use |
| `--list` | Browse sessions by recency |
| `--since DATE` | Filter sessions after this date (ISO format) |
| `--context N` | Surrounding turns when reading a specific message (0-5) |
| `--help` | Full usage reference |
