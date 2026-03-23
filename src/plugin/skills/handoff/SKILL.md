---
name: handoff
description: >
  Reflect on the conversation, distill context into a self-contained handoff
  prompt, and rotate into a fresh session. Use when the user says "handoff",
  "hand this off", "fresh session", "rotate", "shed context", "start fresh",
  "context is too long", or when context bloat is degrading quality.
---

# Handoff

Reflect on the full conversation, distill everything a fresh agent needs into
a self-contained prompt, confirm with the user, then rotate into a new session.

## Usage

```
/handoff                     — reflect, distill, and rotate
/handoff <next-task>         — focus the new session on a specific task
```

## Instructions

### Phase 1: Reflect

Scan the full conversation and extract:

**Decisions & Design**
- Architectural choices made and their rationale
- Constraints agreed upon (performance, compatibility, style)
- Design patterns chosen or rejected, and why

**Work Product**
- Files created or modified, with a one-line summary of each change
- Key code patterns introduced (types, interfaces, function signatures)
- Tests added or modified

**Current State**
- What's done and verified
- What's in progress or partially complete
- What's blocked, broken, or needs attention
- Any errors, edge cases, or open questions

**User Preferences**
- Coding style, communication preferences, or workflow choices observed
- Anything the user corrected or emphasized

Discard:
- Exploration that led nowhere
- Superseded approaches and abandoned designs
- Verbose tool outputs and intermediate research
- Completed sub-tasks that don't inform the next task

### Phase 2: Distill

Build a self-contained handoff prompt. The receiving agent has an empty context
window — it knows nothing about this conversation. Include ALL domain knowledge,
technical background, and design rationale it needs.

Structure:

```markdown
## Task

[One paragraph: exactly what to do next and why. If the user provided a
specific task via arguments, use that. Otherwise, derive the natural next
step from the conversation.]

## Context & Decisions

[3-8 bullet points: key decisions, constraints, architectural choices,
and their rationale. Not what was done — what the next agent needs to
know to continue correctly.]

## Current State

### Files Modified
[File paths with one-line descriptions of changes made this session]

### Work Completed
[Bullet list of what's done and verified]

### In Progress / Remaining
[What still needs to be done, with enough detail to act on]

## Key Code Patterns

[Inline snippets of critical types, interfaces, or function signatures
the next agent must match. Only include patterns that are non-obvious
or were specifically designed during this session.]

## Constraints & Preferences

[Style rules, user preferences, things to avoid, project-specific
conventions discovered during the conversation]

## Verification

[How to verify the work: test commands, typecheck, specific scenarios
to confirm]
```

**Quality bar:** A senior engineer reading this prompt cold should be able
to continue the work without asking clarifying questions.

### Phase 3: Confirm

Show the distilled prompt to the user and ask:

> Ready to hand off to a fresh session with this context?

Wait for explicit confirmation. The user may want to adjust the prompt,
add context, or change the task focus.

### Phase 4: Rotate

Execute the rotation via the `rotateSession` RPC:

```bash
crispy-dispatch rpc rotateSession "{\"prompt\": \"$(cat <<'PROMPT'
<the distilled handoff prompt>
PROMPT
)\"}"
```

The `$CRISPY_SESSION_ID` environment variable is auto-injected by rpc-pipe.ts,
so you don't need to specify the current session ID. The old session is
preserved in the session list.
