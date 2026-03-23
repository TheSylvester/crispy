---
name: clear-and-execute
description: >
  Clear the current context and continue in a fresh session with a prompt.
  Use when the user says "clear and execute", "fresh context", "clean slate",
  "start fresh with this context", "context is getting long", or when an agent
  proposes transitioning to a new session to shed context bloat. Accepts a
  prompt file path as argument, or distills one from the conversation.
---

# Clear and Execute

Clear the current session and rotate into a fresh one that executes a prompt.
If a prompt file is provided, use it directly. Otherwise, distill one from
the conversation first.

## Usage

```
/clear-and-execute <prompt-file>     — rotate and execute the given prompt file
/clear-and-execute                   — distill from conversation, then rotate
/clear-and-execute <specific-task>   — distill focused on a specific task
```

## Instructions

### If a prompt file path is provided

Skip straight to the rotation step — the prompt is already written.

### If no prompt file is provided

#### 1. Distill the conversation

Build a concise prompt that gives the next session everything it needs:

```
## Context

[2-5 bullet points: key decisions, constraints, current state]

## Files Modified

[List of file paths with one-line descriptions of changes]

## Current Task

[What to do next — specific and actionable]

## Constraints

[Any constraints or preferences from the conversation]
```

Discard exploration that led nowhere, superseded approaches, verbose tool
outputs, and completed sub-tasks that don't inform the current task.

#### 2. Save the prompt

Save to `.ai-reference/prompts/`:

```
.ai-reference/prompts/YYYYMMDD-HHMMSS-clear-execute-<task-slug>.md
```

#### 3. Confirm with the user

Show the prompt and ask: "Ready to clear context and continue with this?"

Wait for confirmation before proceeding.

### Execute rotation

Use `crispy-rotate` to rotate the session:

```bash
PROMPT_FILE="<prompt-file>" $CRISPY_ROTATE
```

The script handles JSON escaping, prefixes with "Execute this plan: ",
and auto-injects `$CRISPY_SESSION_ID` via rpc-pipe. The old session is
preserved in the session list.
