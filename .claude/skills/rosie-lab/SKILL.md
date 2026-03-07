---
name: rosie-lab
description: >
  Prompt experimentation harness for testing Rosie-style analysis prompts
  against real session data. Use when the user wants to test extraction prompts,
  experiment with Rosie prompt changes, or analyze a session turn with a custom prompt.
---

# rosie-lab

Fork a real session at any turn, inject a custom analysis prompt, and see what comes back — no persistence, no side effects.

## Usage

```bash
/rosie-lab <session-id> <turn-or-uuid> ["inline prompt"]
/rosie-lab <session-id> <turn-or-uuid> --prompt-file ./my-prompt.md
/rosie-lab <session-id> <turn-or-uuid>   # uses built-in default prompt
```

### Arguments

- **Arg 1** — Session ID (required). Partial match supported (e.g. `3d0cc977`).
- **Arg 2** — Turn number (integer) or message UUID (string with hyphens). Auto-detected: pure integer → turn number; otherwise → UUID.
- **Arg 3+** — Inline prompt text (positional, optional).
- **`--prompt-file`** — Path to a `.md` file containing the prompt (overrides inline text).
- **`--model`** — Model to use (default: `claude-haiku-4-5`). E.g. `--model claude-sonnet-4-5`.
- If no prompt is given, uses the built-in default Rosie prompt (with `<status>` field).

### Examples

```bash
# Default Rosie prompt at turn 5
/rosie-lab 3d0cc977 5

# Custom inline prompt
/rosie-lab 869bb036 7 "What projects are being discussed?"

# Prompt from file
/rosie-lab 869bb036 7 --prompt-file ./my-prompt.md

# Fork at a specific message UUID
/rosie-lab 3d0cc977 a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

## How it works

1. Resolves the session's JSONL file from `~/.claude/projects/`.
2. If a turn number is given, finds the Nth human-typed user message UUID (filtering out tool-result messages).
3. Writes the prompt to a temp file.
4. Invokes `super-agent --fork --resume <session> --resume-at <uuid> --no-persist --no-chrome` with the prompt.
5. Streams the response to stdout. No session state is modified.

## Run the script

```bash
${SKILL_ROOT}/scripts/rosie-lab "$@"
```
