---
name: handoff
description: >
  Reflect on the conversation, distill context into a self-contained handoff
  prompt, and rotate into a fresh session. Use when the user says "handoff",
  "hand this off", "fresh session", "rotate", "shed context", "start fresh",
  "context is too long", or when context bloat is degrading quality.
---

# Handoff

Distill, verify, and rotate — composing three skills in sequence.

A "new topic" argument is **required**. If the user didn't provide one,
ask: "What should the fresh session work on?"

## Usage

```
/handoff <next-task>         — distill, reflect, and rotate
/handoff                     — asks what the next task should be
```

## Flow

### Step 1: Distill — `/distill <next-task>`

Invoke the `distill` skill with the user's task description.
This produces a self-contained prompt file saved to `.ai-reference/prompts/`.

### Step 2: Verify — `/reflect`

Invoke the `reflect` skill against the prompt file just generated.
This validates paths, captures missing decisions, and catches gaps.

### Step 3: Confirm

Show the user the saved file path and a brief summary:

> Handoff prompt saved to `<path>` and verified. Ready to rotate into a
> fresh session and execute?

Wait for explicit confirmation. The user may want to:
- Edit the prompt file before continuing
- Copy it to a different agent
- Save it for later

### Step 4: Rotate — `/clear-and-execute <prompt-file>`

After confirmation, invoke the `clear-and-execute` skill with the saved
prompt file path. This clears the current session and starts a fresh one.
