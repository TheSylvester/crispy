---
name: handoff-prompt-to
description: >
  Synthesize self-contained implementation prompt(s) for a fresh agent with an
  empty context window. Auto-decomposes if the task is too large. Use when the
  user says "write a handoff prompt", "generate a prompt", "distill this for
  a fresh agent", or when composing a handoff.
---

# Handoff Prompt To

Write self-contained prompt(s) to delegate this task to a coding agent with an empty context window: $ARGUMENTS

Cover all relevant insights and specifications from our discussion.

## Scope Analysis

Before generating prompts, analyze what work benefits from shared context:

1. **Identify coupling** - What code is tightly coupled (same files, shared patterns, mutual dependencies)?
2. **Find natural boundaries** - Where can work be cleanly separated without losing context benefits?
3. **Check context fit** - Will the grouped work fit comfortably in one context window (~20 files max)?

**Decision:**
- **Coupled work** → Generate a single prompt (shared context improves quality)
- **Independent work** → Generate multiple prompts (no context benefit from combining)

If decomposing, announce: "Task splits into [N] independent units. Generating [N] prompt files."

---

## Prompt Structure

Every prompt follows this structure:

### 1. Task
One paragraph describing exactly what the agent must do and why.

### 2. Context & Constraints
- Specifications and goals
- Success criteria
- Constraints, key assumptions, and user preferences
- Decisions already made

### 3. Inputs & Resources

#### Files to Create/Modify
- Absolute paths of files the agent will create or change

#### Files to Reference (Read-Only)
- Absolute paths of files for context without modification

#### Key Code Patterns
- Inline code snippets showing expected patterns

#### Build & Test Commands
- Exact commands to run (e.g., `npm run typecheck && npm test`)

### 4. Execution Guidelines
- Numbered implementation steps
- Style and code standards to follow

#### Edge Cases
- Explicit list of boundary conditions and how to handle them

### 5. Assumptions
If you make decisions not covered by the spec, document them:
| Assumption | Reasoning |
|------------|-----------|

### 6. Verification Plan

You are not done until you have proven correctness. Launch these verification sub-agents in parallel:

1. **Test Sub-Agent**: Run `[test command]`. All tests must pass.
2. **Behavioral Sub-Agent**: Prove it works end-to-end (browser test, script, or logs).
3. **Code Quality Sub-Agent**: Review for complexity, duplication, security. Fix issues directly if safe.

If any sub-agent reports failure, fix the issues and re-run verification. Retry up to 3 times. If still failing, report what you tried.

### 7. Definition of Done

- [ ] Implementation matches spec
- [ ] All verification steps passed
- [ ] Assumptions documented (if any)
- [ ] No debug code or comments left behind

---

## Multi-Prompt Additions

When decomposing into multiple prompts, add these elements:

### Interface-First Planning

Before generating task prompts, define contracts between dependent components:
- For each integration point, specify the **exact interface** (types, function signatures, data shapes)
- Include these interface definitions in ALL tasks that produce or consume them

### Output Structure

```
.ai-reference/prompts/<task-name>/
├── 00-index.md          # Overview, dependency graph, shared interfaces
├── 01-<first-task>.md   # First task prompt
├── 02-<second-task>.md  # Second task prompt
└── ...
```

### Index File (00-index.md)

1. **Overview** - What we're building and why
2. **Shared Interfaces** - All contract definitions (copy-paste into each task)
3. **Execution Strategy**:
   | Task | Description | Prerequisites | Can Parallel? |
   |------|-------------|---------------|---------------|

### Additional Sections Per Task

Add to section 2 (Context & Constraints):

```markdown
### Prerequisites
- [ ] Task [X] completed (if applicable)
- None - this task is independent

### Shared Interfaces (CRITICAL)
[Exact interface definitions - copy from index, don't summarize]
```

Add to section 7 (Definition of Done):
- [ ] Shared interfaces implemented exactly as defined

---

## Output

- **Single prompt**: Save to `.ai-reference/prompts/YYYYMMDD-HHMMSS-<task-description>.md` (e.g., `20250115-143022-refactor-auth.md`)
- **Multiple prompts**: Save to `.ai-reference/prompts/<task-name>/` directory
- **No title header**: Start directly with the execution directive, then the Task section - do NOT add "# Handoff Prompt" or similar titles
- **Execution directive**: Every generated prompt MUST begin with this HTML comment:
  ```
  <!-- EXECUTION DIRECTIVE: This is a pre-validated implementation prompt. Execute immediately without entering plan mode or invoking /reflect. -->
  ```

---

## Requirements

1. **Self-contained**: Each prompt includes ALL context needed. Fresh agent, empty window.
2. **Interface consistency**: Shared interfaces IDENTICAL across all prompts. Copy-paste, don't summarize.
3. **Verification built-in**: Every prompt includes verification sub-agents.

Write directly to the new agent (use "you"). Do not mention this conversation. Include all domain knowledge, technical background, design rationale, and insights from our discussion.

Use sub-agents liberally for parallel work. The main agent coordinates and ensures consistency.
