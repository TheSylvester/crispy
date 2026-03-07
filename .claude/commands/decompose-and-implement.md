---
description: Research, decompose, and execute a complex task via phased sub-agents with 2-level decomposition
argument-hint: <instruction>
---

Research, plan, and execute a complex implementation task. You are the orchestrator — you research the codebase, decompose the work into sequential phases with parallel sub-tasks, write execution-ready prompt artifacts, get user approval, then execute them via super-agent.

Each phase is executed by a **fresh coding agent with an empty context window**. It knows nothing about your research, your conversation, or your reasoning — only what's written in its prompt file. Every insight you gain during research must be explicitly written into the relevant prompt or it is lost.

**Important:** After plan approval, your context will be cleared. The plan file you write IS your orchestration prompt — it must contain everything the post-approval agent needs to execute the phases. Write it as instructions to yourself.

$ARGUMENTS

---

## Phase 1: Research, Plan, and Write Artifacts

Call `EnterPlanMode` now, then follow these steps. During this phase you will write both the plan file AND the phase prompt files to disk — the user reviews the actual execution-ready prompts, not an abstract summary.

### 1. Research scope

Launch one or more **Explore agents** (foreground — you need their results) to deeply research what this instruction touches. Find all the files, patterns, and call sites that need to change. Understand existing conventions so the implementation is consistent.

### 2. Discover e2e verification recipe

Figure out how a phase worker can verify its changes end-to-end — not just that unit tests pass. Look for:

- A `browser-qa` agent or chrome automation (for UI changes: navigate the affected flow, screenshot)
- A dev-server + curl pattern (for API changes: start the server, hit affected endpoints)
- A `tmux` or CLI pattern (for CLI changes: launch interactively, exercise the behavior)
- An existing e2e/integration test suite the worker can run

If you cannot find a concrete e2e path, use `AskUserQuestion` to ask the user how to verify end-to-end. Offer 2-3 specific options based on what you found. Do not skip this — phase workers cannot ask the user themselves.

Write the recipe as concrete steps a worker can execute autonomously. Include setup (start a dev server, build first) and the exact command/interaction to verify.

### 3. Decompose into phases

Group the work into **sequential phases** (2-4). The goal is to partition all changes into groups that:

- **Fit in one context window** — each phase touches ~20 files max. Sub-tasks within a phase should each fit in a context window too.
- **Don't overlap in file edits** — no two phases should modify the same files. If they must, make them sequential with the dependency explicit.
- **Have one clear goal each** — if a phase combines "understand + implement + test," it's too big.
- **Minimize cross-phase dependencies** — split by component, by operation, or by risk, whichever produces the cleanest boundaries.

For each phase, identify the **sub-agent strategy** — what's blocking (must complete first), what can fan out in parallel via sub-agents, and what integrates after the parallel work completes.

Resolve ambiguity from context before asking the user.

### 4. Define shared interfaces FIRST

Before writing any phase prompt, define the contracts between phases:

- For every integration point between phases, specify the **exact interface** — types, function signatures, data shapes, file locations
- These definitions are the **source of truth** — they get copy-pasted identically into every phase prompt that produces or consumes them
- If no cross-phase interfaces exist, skip this step

### 5. Write phase prompt files

Write each phase prompt directly to disk:

**Output directory:** `.ai-reference/prompts/<task-name>-chain/`

```
01-<phase-name>.md      # e.g., 01-scaffold-core.md
02-<phase-name>.md      # e.g., 02-implement-adapters.md
03-<phase-name>.md      # e.g., 03-wire-and-verify.md
```

Before writing, extract for **verbatim** preservation in the relevant prompt: code snippets, protocol specs, exact commands, edge cases, file paths (absolute). These MUST appear verbatim, never summarized.

Each phase prompt follows the structure in the **Prompt Template** section below.

**The handoff contract:** Each phase is run by a fresh agent with an empty context window. It has zero access to your research findings, your reasoning, or this conversation. Write directly to the executing agent (use "you"). Do not mention the planning conversation. Include all domain knowledge, technical background, design rationale, codebase conventions, and insights from your research. If you learned something during research that affects how a phase should be implemented, it must be in that phase's prompt or it doesn't exist.

### 6. Write the plan file as the orchestration prompt

Your context will be cleared after plan approval. The plan file must contain everything the post-approval agent needs to execute the phases autonomously. Write it as an orchestration prompt — instructions to the agent that will run after approval.

The plan file must include:

```markdown
# [Task Name] — Orchestration Plan

## What We're Building

[One paragraph: what and why — the research summary]

## Shared Interface Contracts

[Exact source-of-truth definitions, or "None"]

## E2E Verification Recipe

[Concrete steps workers will follow]

## Phase Sequence

| Phase | File | Goal | Done When |
|-------|------|------|-----------|
| 1 | `01-<name>.md` | [goal] | [criteria] |
| 2 | `02-<name>.md` | [goal] | [criteria] |

## Per-Phase Breakdown

### Phase 1: [name]
- Sub-tasks and file assignments
- Sub-agent strategy (blocking → parallel → sequential)

### Phase 2: [name]
...

## Build & Test Commands

[Exact commands]

## Execution Protocol

Execute phases sequentially. For each phase (1 through N):

### Step 1: Run the phase

\`\`\`bash
PROMPT_FILE=.ai-reference/prompts/<task-name>-chain/<phase-file> \
  .claude/skills/super-agent/scripts/super-agent
\`\`\`

If NOT the first phase, prepend inter-phase context via stdin:

\`\`\`bash
{ echo "<synthesized context from previous phase>"; echo; echo "---"; echo; \
  cat .ai-reference/prompts/<task-name>-chain/<phase-file>; } \
  | .claude/skills/super-agent/scripts/super-agent
\`\`\`

The super-agent runs as a full Claude Code instance — it can spawn its own
sub-agents for parallel work within the phase per the prompt's sub-agent
strategy.

### Step 2: Verify and synthesize

After the phase agent completes, launch an **Explore agent** to inspect
code on disk:

1. Check "Done When" criteria from the phase table
2. Identify deviations from the phase prompt
3. Synthesize context for the next phase:
   - What changed (files + semantic description)
   - Deviations from plan (if any)
   - Test results
   - Anything the next phase needs to know

### Step 3: Gate

- **All checks pass** → Proceed with synthesized context prepended
- **Minor issues** → Fix directly or resume the super-agent session,
  re-verify, proceed
- **Major issues** → Re-run phase with corrective preamble. Max 2 retries
  before escalating to user.

### Step 4: Repeat for next phase.

## Progress Tracking

| Phase | Goal | Status | Result |
|-------|------|--------|--------|
| 1     | ...  | ⏳ pending | — |
| 2     | ...  | ⏳ pending | — |

## Final Report

After all phases complete, summarize: total files modified, key decisions,
deviations from plan, remaining debt.
```

### 7. Exit plan mode

Call `ExitPlanMode` to present the plan for approval. The user can review both the orchestration plan and the actual phase prompt files on disk.

---

## Prompt Template

Each phase prompt follows this structure. Include sections relevant to the phase's goal — omit sections that don't apply.

```markdown
<!-- EXECUTION DIRECTIVE: This is a pre-validated implementation prompt. Execute immediately without entering plan mode or invoking /reflect. -->

## 1. Task

One paragraph: what you must do and why.

## 2. Context & Constraints

- Specifications, goals, success criteria
- Constraints and decisions already made

### Prerequisites (if not first phase)

- [ ] Phase [X] completed — [what should exist on disk]

### Shared Interfaces (if applicable, CRITICAL)

[Exact interface definitions — copied from the source of truth, not summarized]

## 3. Inputs & Resources

### Files to Create/Modify

- Absolute paths

### Files to Reference (Read-Only)

- Absolute paths

### Key Code Patterns

- Inline code snippets (VERBATIM)

### Build & Test Commands

- Exact commands

## 4. Execution Guidelines

[Numbered implementation steps, style/code standards]

### Sub-Agent Strategy

If this phase has parallelizable work, specify:

**Blocking (run first):**
- [Task that must complete before fan-out]

**Parallel (after blocker completes):**
Spawn these sub-agents in parallel:
1. "[Specific task scope and files]"
2. "[Specific task scope and files]"

**Sequential (after parallel completes):**
- [Integration work that depends on parallel results]

If the phase is small or inherently sequential, omit this section.

### Edge Cases

- Boundary conditions and handling

## 5. Verification

1. Invoke `/simplify` to review and clean up your changes
2. Run `[test command]` — fix failures before continuing
3. E2e: [concrete verification recipe from orchestrator's research]
4. Review for leftover debug code, complexity, duplication

## 6. Definition of Done

- [ ] Implementation matches spec
- [ ] All verification steps passed
- [ ] Shared interfaces implemented exactly as defined (if applicable)
- [ ] No debug code or comments left behind
```

### Phase design rules

- **Fresh agent per phase** — each phase runs in a new agent with an empty context window. No resume, no accumulated context drift, no compaction risk.
- **Self-contained documents** — each phase includes ALL context a fresh agent needs to execute: domain knowledge, conventions, patterns, design rationale. Code on disk provides the rest. Phases have _execution-level_ dependencies: the code on disk must reflect prior phases' changes.
- **One goal per phase** — clear, verifiable
- **Non-overlapping file edits** — no two phases should modify the same files. If unavoidable, the dependency must be explicit in prerequisites.
- **Lean phases** — reference, don't repeat. Each phase should include only context relevant to its goal, not duplicate the entire research.
- **Verbatim fidelity** — code snippets, specs, commands never summarized
- **Checkpoints** — every phase except the last ends with: "Do not continue. Report what you completed."

---

## Requirements

1. **Interface-first**: Define shared contracts before writing any phase prompt. Copy-paste identically into all phases that produce or consume them. Never summarize.
2. **Self-containment for fresh agents**: Every phase prompt includes ALL context a fresh agent with an empty context window needs — type definitions, code patterns, file lists, success criteria, codebase conventions, design rationale. The executing agent knows nothing except what's in its prompt and what's on disk.
3. **Explicit file boundaries**: "Files to Modify" and "Files to Reference (Read-Only)" per prompt. No two phases should edit the same files. Agents must not modify files outside their scope.
4. **Execution directives**: Every prompt begins with the directive to prevent re-planning.
5. **Verbatim preservation**: Code snippets, specs, commands preserved exactly, never summarized.
6. **Plan file is the orchestration prompt**: After context clear on plan approval, the plan file is the only thing the executing agent has. It must be self-sufficient for driving execution.
