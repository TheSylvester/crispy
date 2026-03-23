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
a self-contained prompt, save it, confirm with the user, then rotate into a
fresh session that executes it.

## Usage

```
/handoff                     — reflect, distill, save, and rotate
/handoff <next-task>         — focus the new session on a specific task
```

## Instructions

### Phase 1: Reflect & Distill

Write a self-contained prompt for an agent with an empty context window.
If the user provided a specific task via arguments, use that. Otherwise,
derive the natural next step from the conversation.

Cover all relevant insights and specifications from the conversation.

#### Prompt Structure

##### 1. Task
One paragraph: exactly what to do next and why.

##### 2. Context & Constraints
- Key decisions, constraints, architectural choices, and their rationale
- Success criteria
- User preferences observed during the conversation

##### 3. Inputs & Resources

**Files to Create/Modify**
- Paths of files the agent will create or change

**Files to Reference (Read-Only)**
- Paths of files for context without modification

**Key Code Patterns**
- Inline snippets showing expected patterns (only non-obvious ones)

**Build & Test Commands**
- Exact commands to run (e.g., `npm run typecheck && npm test`)

##### 4. Execution Guidelines
- Numbered implementation steps
- Style and code standards to follow

##### 5. Verification
How to verify the work: test commands, typecheck, specific scenarios.

#### What to include

- Architectural choices made and their rationale
- Constraints agreed upon (performance, compatibility, style)
- Files created or modified, with one-line summaries
- Key code patterns introduced (types, interfaces, function signatures)
- What's done and verified
- What's in progress, blocked, or needs attention
- Anything the user corrected or emphasized

#### What to discard

- Exploration that led nowhere
- Superseded approaches and abandoned designs
- Verbose tool outputs and intermediate research
- Completed sub-tasks that don't inform the next task

#### Quality bar

A senior engineer reading this prompt cold should be able to continue
the work without asking clarifying questions.

### Phase 2: Save

Save the prompt to `.ai-reference/prompts/`:

```
.ai-reference/prompts/YYYYMMDD-HHMMSS-handoff-<task-slug>.md
```

Use the current date/time and a short slug derived from the task.
Start the file directly with the prompt content — no title header.

### Phase 3: Confirm

Show the saved file path and a summary to the user:

> Handoff prompt saved to `<path>`. Ready to rotate into a fresh session
> and execute? Use `/clear-and-execute` to rotate now, or edit the file first.

Wait for explicit confirmation.

### Phase 4: Rotate

After the user confirms, invoke `/clear-and-execute` with the saved prompt
file. This clears the current session and starts a fresh one that executes
the handoff prompt.

Alternatively, the user can:
- Edit the saved `.md` file and then manually invoke `/clear-and-execute`
- Copy the prompt to a different agent or session
- Save it for later execution
