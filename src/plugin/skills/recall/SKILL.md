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

# Read a specific session by ID
Bash(command: "node $RECALL_CLI <session-id>")

# Read a specific turn with context
Bash(command: "node $RECALL_CLI <session-id> <message-id> --context 3")

# Browse recent sessions
Bash(command: "node $RECALL_CLI --list")

# Full usage
Bash(command: "node $RECALL_CLI --help")
```

## Sub-agent pattern (recommended for deep research)

For questions requiring multiple searches or reading session content, launch a sub-agent:

```
Agent(prompt: "Use `node $RECALL_CLI \"query\"` to search session transcripts.
Run these searches: [list queries]. Cross-reference results and summarize findings.",
mode: "auto")
```

## Options

| Flag | Description |
|------|-------------|
| `--limit N` | Result ceiling (default: 200 for search, 10 for read) |
| `--raw` | JSON output for programmatic use |
| `--list` | Browse sessions by recency |
| `--since DATE` | Filter sessions after this date (ISO format) |
| `--offset N` | Pagination offset for read/list |
| `--context N` | Surrounding turns when reading a specific message (0-5) |
| `--help` | Full usage reference |
