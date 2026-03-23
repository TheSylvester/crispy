---
name: clear-and-execute
description: >
  Clear the current context and continue in a fresh session with distilled context.
  Use when the user says "clear and execute", "fresh context", "clean slate",
  "start fresh with this context", "context is getting long", or when an agent
  proposes transitioning to a new session to shed context bloat.
---

# Clear and Execute

Distill the current conversation into only the context needed for the next topic,
then rotate into a fresh session with that context.

## Usage

```
/clear-and-execute                    — distill and rotate automatically
/clear-and-execute <specific-task>    — focus the new session on a specific task
```

## Instructions

### 1. Analyze the current conversation

Identify:
- **Decisions made** — architectural choices, design decisions, constraints agreed upon
- **Files touched** — paths of files created or modified (not their full contents)
- **Current task** — what the user is working on right now, or the task specified as an argument
- **Blocking context** — any errors, edge cases, or state that the next session needs to know about

Discard:
- Exploration that led nowhere
- Superseded approaches
- Verbose tool outputs
- Completed sub-tasks that don't inform the current task

### 2. Build the handoff prompt

Construct a concise prompt that gives the next session everything it needs:

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

### 3. Confirm with the user

Show the distilled prompt and ask: "Ready to clear context and continue with this? I'll rotate to a fresh session."

Wait for user confirmation before proceeding.

### 4. Execute rotation

Call the `rotateSession` RPC:

```bash
crispy-dispatch rpc rotateSession "{\"prompt\": \"$(cat <<'PROMPT'
<the distilled prompt>
PROMPT
)\"}"
```

The `$CRISPY_SESSION_ID` environment variable is auto-injected by rpc-pipe.ts,
so you don't need to specify the current session ID.
