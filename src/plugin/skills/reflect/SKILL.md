---
name: reflect
description: >
  Reflect on conversation + codebase to ensure prompts capture everything
  before execution. Use when the user says "reflect", "verify the prompt",
  "check the plan", or automatically as part of the handoff flow.
allowed-tools: Read, Grep, Glob, Task
---

# Reflect

**Deduplication:** If this plan/artifact already has a "REFLECT COMPLETE" marker and nothing changed since, report that and stop.

**Quick exit:** If the plan is a single straightforward task (<5 files, no sub-agents, no handoff), just verify file paths exist and are absolute, then stop. Full reflection is overkill for simple plans.

**Reflect** on:

- Our discussion, and any details and decisions we'd agreed upon on the subject $ARGUMENTS
- the artifacts, prompt files, and/or other plans we most recently generated for this
- our conversation and the codebase against the artifacts, plans, or prompts we recently generated to ensure they will succeed.

This is your last chance to catch gaps before a fresh agent executes these tasks with no memory of our discussion. Your goal is to ensure the implementation planned will succeed by providing the best, most accurate context and instructions possible.

Focus on capturing what was agreed in this conversation that the execution agent won't have access to. That's what matters - not elaboration beyond what we discussed.

Make any refinements to ensure:

**Verify against codebase:**
- [ ] All file paths are ABSOLUTE (not relative like `./src/` or `src/`)
- [ ] All referenced files exist at the stated paths
- [ ] File paths haven't been renamed or moved
- [ ] Line number references are still accurate
- [ ] Verify the code actually exists as described
- [ ] Verify the described behavior is accurate
- [ ] Verify types/interfaces match what's stated
- [ ] Commands are correct for this project
- [ ] Test file paths are accurate

**If this is a multi-prompt chain with separate task files (from /handoff-prompt-to):**
- [ ] Interface definitions are IDENTICAL across all task files
- [ ] Prerequisites in each task match what prior tasks deliver
- [ ] Index dependency graph matches task file prerequisites
- [ ] No conflicts between what tasks produce vs consume

**Capture from our discussion:**
- [ ] All design decisions from our conversation are documented
- [ ] Rationale is included (not just "what" but "why")
- [ ] Trade-offs we discussed are noted
- [ ] Domain knowledge I explained is included
- [ ] Edge cases we identified are listed
- [ ] Constraints and preferences are captured
- [ ] Task boundaries match what we agreed
- [ ] Nothing we discussed is missing from the artifacts/plans
- [ ] No scope creep beyond what we decided

**Execution structure:**
- [ ] Plans use sub-agents for parallel/independent work (multiple Task calls in one message, not sequential)
- [ ] Exploration and research steps use sub-agents (isolated context, synthesized findings)
- [ ] If the plan involves significant code changes, consider adding a simplification/refactoring pass before testing to review changed code for reuse, quality, and efficiency
- [ ] Testing/typecheck/lint steps come after any refactoring passes

---

Directly update the artifacts with refinements required.

End with "REFLECT COMPLETE" to signal verification is done.
