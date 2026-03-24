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
$RECALL_CLI "your query here"

# Read a specific session by ID (paginated)
$RECALL_CLI <session-id>

# Full CLI usage (pagination, filtering, context, and more)
$RECALL_CLI --help
```

Always read into promising search results — snippets are just previews.

## Sub-agent pattern (recommended for deep research)

For questions requiring multiple searches or reading session content, launch a sub-agent.
The agent prompt **must** include full CLI instructions — sub-agents don't see this skill file.

```
Agent(prompt: "You have a recall CLI for searching and reading past session transcripts.
Use ONLY `$RECALL_CLI` for all transcript access — do NOT read .jsonl files directly,
do NOT use Grep/Glob/find to locate transcripts.

First run `$RECALL_CLI --help` to learn the full CLI usage.
Then: search first, read into promising sessions for real content (snippets are just previews).

Task: [describe what to find]. Run these searches: [list queries].
Cross-reference results and summarize findings.",
mode: "auto")
```
