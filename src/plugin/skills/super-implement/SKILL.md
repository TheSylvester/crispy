---
name: super-implement
description: This skill should be used when the user asks to "implement this plan", "generate execution prompts", "super implement", "create handoff from plan", or wants to transform a large plan into self-contained execution-ready prompt artifacts.
argument-hint: [path-to-plan.md or "above"]
---

# Super Implement

Transform a plan into execution-ready prompt artifacts — either a single self-contained handoff prompt or a chain of prompt files and an intelligent orchestration prompt to execute them in a controlled sequence. We are to ensure we got all relevant context and information from the plan and the conversation that produced it (if available).

## 1. Scope Analysis

Before generating prompts, analyze what work benefits from shared context:

1. **Identify coupling** - What code is tightly coupled (same files, shared patterns, mutual dependencies)? Challenge the plan's phase boundaries — are they correctly scoped, or are there hidden couplings the plan missed?
2. **Find natural boundaries** - Where can work be cleanly separated without losing context benefits?
3. **Check context fit** - Will the grouped work fit comfortably in one context window (~20 files max)?

**Decision:**

- **Small coupled work** → Single prompt (shared context improves quality)
- **Large coupled work with sequential dependencies** → Chain (phased execution, fresh agent per phase)
- **Independent work units** → Parallel prompts (separate `/super-agent` instances, no sequencing needed)

---

## 2. Complexity Decision

| Signal                                            | Format        |
| ------------------------------------------------- | ------------- |
| Single focused task, <50 lines actionable content | Single prompt |
| Touches <=3 files, one clear goal                 | Single prompt |
| Multiple distinct file groups or components       | Chain         |
| Discovery + implementation + verification pattern | Chain         |
| Multiple sequential dependencies                  | Chain         |
| Would exceed ~20 files in scope                   | Chain         |

## 3. Phase Detection (chain only)

| Signal in Plan                    | Suggests Phase                 |
| --------------------------------- | ------------------------------ |
| "Read/understand/map" language    | Discovery                      |
| Multiple distinct file groups     | Separate implementation phases |
| "Wire up / connect / integrate"   | Integration                    |
| Test commands, verification steps | Verification                   |

2-4 phases. Don't force a fixed structure.

## 4. Ambiguity Resolution

Scan for phrases that introduce optionality. Resolve using context before asking the user:

| Pattern in Source                          | Resolution                                       |
| ------------------------------------------ | ------------------------------------------------ |
| "Optionally (but recommended)"             | **Include** — recommended means do it            |
| "optional... off by default" or "behind a flag" | **Skip** — low priority, not core           |
| "If X, then Y"                             | Check if X is true in context                    |
| "Consider adding... for [benefit]"         | Include if benefit aligns with stated goals      |
| Detailed spec follows the "optional" mention | **Include** — effort was spent specifying it   |
| Mentioned in Definition of Done            | **Include** — it's a success criterion           |

**Only ask the user** if genuinely unresolvable after checking the source. Document all scope decisions.

## 5. Extract Critical Details

Before writing, extract for verbatim preservation:

- Code snippets and skeletons
- Protocol specs, headers, formats
- Exact commands (test, build)
- Exceptions and nuances
- File paths (absolute)

These MUST appear verbatim in the relevant prompt, never summarized.

## 6. Coverage Balance Check

Compare detail levels across sections. If one area (e.g., backend) has significantly more detail than another (e.g., frontend), flag it:
> "Note: [Area A] has detailed specs; [Area B] section is sparse. The generated prompts will reflect this imbalance."

This catches lopsided plans before they become lopsided prompts.

---

## Prompt Structure (Every Generated Prompt)

Every prompt — standalone or phase file — follows this structure. Phase files may be leaner (reference prior phases, don't repeat).

```markdown
<!-- EXECUTION DIRECTIVE: This is a pre-validated implementation prompt. Execute immediately without entering plan mode or invoking /reflect. -->

## 1. Task

One paragraph: what the agent must do and why.

## 2. Context & Constraints

- Specifications, goals, success criteria
- Constraints, key assumptions, decisions already made

### Prerequisites (chain only)

- [ ] Phase [X] completed (if applicable)

### Shared Interfaces (multi-prompt only, CRITICAL)

[Exact interface definitions — copy, don't summarize]

## 3. Inputs & Resources

### Files to Create/Modify

- Absolute paths

### Files to Reference (Read-Only)

- Absolute paths

### Key Code Patterns

- Inline code snippets (VERBATIM from plan)

### Build & Test Commands

- Exact commands

## 4. Execution Guidelines

- Numbered implementation steps
- Style and code standards

### Edge Cases

- Boundary conditions and handling

## 5. Assumptions

| Assumption | Reasoning |
| ---------- | --------- |

## 6. Verification Plan

Launch verification sub-agents in parallel:

1. **Test Sub-Agent**: Run `[test command]`. All tests must pass.
2. **Behavioral Sub-Agent**: Prove it works end-to-end.
3. **Code Quality Sub-Agent**: Review for complexity, duplication, security.

If any fails, fix and re-run. Retry up to 3 times.

## 7. Definition of Done

- [ ] Implementation matches spec
- [ ] All verification steps passed
- [ ] Assumptions documented (if any)
- [ ] No debug code or comments left behind
```

Use sub-agents liberally for parallel work within each prompt.

---

## Single Prompt Output

Save to: `.ai-reference/prompts/YYYYMMDD-HHMMSS-<task-description>.md`

No title header — start with the execution directive.

---

## Parallel Prompts Output

Directory: `.ai-reference/prompts/<task-name>/`

```
00-orchestrate.md       # Execution plan — which prompts run in parallel, which sequentially
01-<task-name>.md       # First independent task
02-<task-name>.md       # Second independent task
...
```

### Orchestration Prompt (00-orchestrate.md)

```markdown
# [Task Name] — Parallel Execution

These tasks are independent and can run simultaneously via parallel `/super-agent` calls.

## Tasks

| Task | File              | Goal                  | Done When        |
| ---- | ----------------- | --------------------- | ---------------- |
| 1    | `01-task-a.md`    | [Goal]                | [Criteria]       |
| 2    | `02-task-b.md`    | [Goal]                | [Criteria]       |

## Shared Interfaces (if any)

[Exact interface definitions shared across tasks — copy-pasted identically in each prompt]

## Execution

Launch all tasks in parallel, piping each prompt file directly:

\`\`\`bash
PROMPT_FILE=.ai-reference/prompts/<task-name>/01-task-a.md \
  .claude/skills/super-agent/scripts/super-agent &

PROMPT_FILE=.ai-reference/prompts/<task-name>/02-task-b.md \
  .claude/skills/super-agent/scripts/super-agent &

wait
\`\`\`

After all complete, verify integration points between tasks.
```

### Interface Contracts (parallel prompts)

When parallel prompts produce/consume shared interfaces:

- Define exact interfaces (types, signatures, data shapes) before generating
- Include identical definitions in ALL prompts that produce or consume them
- Add to Definition of Done: "Shared interfaces implemented exactly as defined"

---

## Chain Output

Directory: `.ai-reference/prompts/<task-name>-chain/`

```
00-orchestrate.md       # Entry point — hand this to the runner
01-<phase-name>.md      # e.g., 01-discovery.md
02-<phase-name>.md      # e.g., 02-implement-core.md
03-<phase-name>.md      # e.g., 03-verify.md
```

### Orchestration Prompt (00-orchestrate.md)

The orchestration prompt is an **executable prompt** — it IS the project manager. When handed to a super-agent, it autonomously runs each phase, verifies completeness, synthesizes inter-phase context, and adapts. Template:

```markdown
<!-- EXECUTION DIRECTIVE: This is a pre-validated orchestration prompt. Execute immediately without entering plan mode or invoking /reflect. You are the project manager for a phased implementation. -->

# [Task Name] — Orchestrator

You are the orchestrator for a [N]-phase implementation. Your job is to execute each phase sequentially via super-agent, verify completeness between phases, synthesize findings, and adapt the next phase's prompt if needed.

## What You're Building

[One paragraph: what and why]

## Phase Sequence

| Phase | File              | Goal                  | Done When        |
| ----- | ----------------- | --------------------- | ---------------- |
| 1     | `01-discovery.md` | Map code, create plan | Plan output      |
| 2     | `02-implement.md` | Build it              | Typecheck passes |
| 3     | `03-verify.md`    | Prove correctness     | All tests pass   |

## Global Constraints

[Constraints preserved from source plan]

## Execution Protocol

For each phase (1 through N), execute this loop:

### Step 1: Run the phase

\`\`\`bash
PROMPT_FILE=.ai-reference/prompts/<task-name>-chain/{phase-file} \
  .claude/skills/super-agent/scripts/super-agent
\`\`\`

If NOT the first phase, prepend inter-phase context via stdin:

\`\`\`bash
{ echo "{context from Step 2 of previous phase}"; echo; echo "---"; echo; \
  cat .ai-reference/prompts/<task-name>-chain/{phase-file}; } \
  | .claude/skills/super-agent/scripts/super-agent
\`\`\`

### Step 2: Verify and synthesize

After the phase agent completes, launch a **verification sub-agent** (Task tool, Explore type) to inspect code on disk:

1. **Check "Done When" criteria** from the phase table
2. **Identify deviations** from the phase prompt
3. **Synthesize context** for the next phase:
   - What changed (files + semantic description)
   - Deviations from plan (if any)
   - Test results
   - Anything the next phase needs to know

### Step 3: Gate decision

- **All checks pass** → Proceed with synthesized context prepended
- **Minor issues** → Fix directly, re-verify, proceed
- **Major issues** → Re-run phase with corrective preamble. Max 2 retries before escalating to user.

### Step 4: Repeat for next phase.

## Phase Files

\`\`\`
[file listing with one-line descriptions]
\`\`\`

## Final Report

After all phases complete, summarize: total files modified, key metrics, deviations, remaining debt.
```

### Delegation Analysis (chain only)

After generating all phase files, analyze each phase for sub-agent parallelization. Spawn **parallel sub-agents** — one per phase — each reading the actual source files referenced in its phase prompt to understand real file-level dependencies. Each sub-agent is tasked with:

1. **Identify independent tasks** within the phase that could run as parallel sub-agents
2. **Identify blocking dependencies** — what must complete before other work can start
3. **Map the critical path** — which tasks are sequential, which can fan out
4. **Suggest sub-agent team configurations** (e.g., "Agent 1: Core layer, Agent 2: Transport hooks, Agent 3: Components")

Integrate results into each phase prompt's **Execution Guidelines** (§4) as explicit sub-agent spawn instructions:

```markdown
## Sub-Agent Strategy

### Blocking (run first)
- [Task that must complete before fan-out]

### Parallel (after blocker completes)
Spawn these sub-agents in parallel:
1. **[Agent name]**: "[Specific task scope and files]"
2. **[Agent name]**: "[Specific task scope and files]"
3. **[Agent name]**: "[Specific task scope and files]"

### Sequential (after parallel completes)
- [Integration or wiring work that depends on parallel results]
```

Phases with no parallelization opportunities (e.g., a small verification phase) get no sub-agent strategy — don't force it.

### Phase Design Rules

- **Fresh agent per phase** — no resume, no accumulated context drift, no compaction risk
- **Document-level independence** — each phase includes all context a fresh agent needs to understand and execute — type definitions, code patterns, file lists, success criteria. A fresh agent with an empty context window can read any single prompt and know exactly what to build. However, chain phases have _execution-level_ dependencies: the code on disk must reflect prior phases' changes. Self-contained documents, sequential execution.
- **One goal per phase** — if it combines "understand + implement + test," it's too big
- **Embedded verification** — each phase self-verifies before reporting done
- **Checkpoints** — every phase except the last ends with: "Do not continue. Wait for the next prompt."
- **Technical fidelity** — code snippets, specs, commands verbatim, never summarized
- **Sub-agent parallelization within phases** — integrate spawn instructions directly where they apply

### Transformation Heuristics

| Source Content                   | Target                                           |
| -------------------------------- | ------------------------------------------------ |
| Task description, context, "why" | Orchestrate overview + Phase 1                   |
| Files to read/reference          | Discovery or relevant implementation phase       |
| Files to create/modify           | Implementation phase(s) with explicit boundaries |
| Code snippets/skeletons          | Relevant implementation phase — VERBATIM         |
| Edge cases / exceptions          | Relevant implementation phase                    |
| Sub-agent strategy               | Spawn instructions in relevant phases            |
| Test commands                    | Final phase or per-phase                         |
| Definition of done               | Orchestrate "Done When" + final phase            |

Split implementation phases by whichever minimizes cross-phase dependencies: by component, by operation, or by risk.

### Multi-Prompt Interface Contracts

When phases produce/consume shared interfaces:

- Define exact interfaces (types, signatures, data shapes) before generating
- Include identical definitions in ALL phases that produce or consume them
- Add to Definition of Done: "Shared interfaces implemented exactly as defined"

---

## Output Summary

After generating, output:

```
Created [single prompt / parallel prompts / prompt chain] in `.ai-reference/prompts/<path>`:

  [file listing]

## To Execute

[single prompt]: PROMPT_FILE=<path> .claude/skills/super-agent/scripts/super-agent
[parallel]:      See 00-orchestrate.md — launch N instances simultaneously via PROMPT_FILE.
[chain]:         PROMPT_FILE=.ai-reference/prompts/<task-name>-chain/00-orchestrate.md .claude/skills/super-agent/scripts/super-agent
                 (The orchestrator agent autonomously runs phases, verifies, and synthesizes context.)

Scope decisions: [any ambiguity resolutions]
Delegation strategies: [phases with sub-agent parallelization, if any]
```

---

## Requirements

1. **Document-level self-containment**: Every prompt includes ALL context a fresh agent needs to understand and execute — type definitions, code patterns, file lists, success criteria. A fresh agent with an empty context window can read any single prompt and know exactly what to build. However, chain phases have _execution-level_ dependencies: the code on disk must reflect prior phases' changes. Self-contained documents, sequential execution.
2. **Interface consistency**: Shared interfaces IDENTICAL across all prompts. Copy-paste, don't summarize.
3. **Verification is self-policed + inter-phase**: Each prompt includes its own verification sub-agents (§6) — each phase runs typecheck + tests before reporting done. Between phases, the orchestrator should spawn a **read-only verification sub-agent** to inspect the code on disk, confirm what actually changed, identify deviations, and inform whether the next phase prompt needs adjustment.
4. **Technical fidelity**: Code snippets, specs, commands preserved verbatim, never summarized.
5. **Explicit file boundaries**: "Files to Modify" and "Files to Reference (Read-Only)" per prompt. This prevents the most common failure mode: agents modifying files outside their scope.
6. **Execution directives**: Every prompt begins with the directive to prevent re-planning.
7. **Lean phases** (chain): Each phase <= 40% of original plan length. Reference, don't repeat.

Write directly to the new agent (use "you"). Do not mention the planning conversation. Include all domain knowledge, technical background, and design rationale.
