---
name: super-implement
description: >
  Drive a plan end-to-end through a quality-gated pipeline — superthink-refine →
  distill → crispy-agent execute → simplify+superthink → divergence check →
  test. Use when the user says "super implement", "ship this plan", "execute
  this plan end-to-end", or provides a plan file and wants it built with full
  review gates.
argument-hint: [path-to-plan.md or "above"]
---

# Super Implement

Drive a plan from refined-spec to tested-code by composing five existing
skills into a quality-gated pipeline:

```
refine → distill → execute → self-review → divergence check → test
```

A plan argument is required: either a path (e.g. `.ai-reference/plans/foo.md`)
or `"above"` to use the plan just discussed. If not provided, ask the user.

## When to use

The plan is non-trivial and you want:

- Multiple independent review passes (on the plan AND on the code)
- Work done by a crispy-agent (main context stays clean)
- A divergence gate (agent doesn't silently expand scope)
- Regression protection (simplify + superthink after changes)

For small or exploratory changes, skip this — just implement, or hand off a
single prompt via `/distill`.

## Step 1: Refine the plan (loop)

Invoke `/superthink` on the plan. Iterate until it converges — when the
multi-vendor review reaches consensus (LGTM). No hard cap; superthink
reliably converges.

**Parallel work (main thread, while superthink runs):** draft a testing
methodology — how a human verifies the feature works end-to-end. Cover:

- Golden path (primary flow)
- Edge cases specific to this change
- Regression surface (adjacent behavior to watch)

Save to `.ai-reference/plans/<plan-name>-test-plan.md`. Revise as the plan
changes across refinement rounds.

Before moving on, confirm the refined plan is stable (no new changes in the
latest round).

## Step 2: Distill

Invoke `/distill` with the refined plan to produce an execution-ready prompt
file at `.ai-reference/prompts/<timestamp>-<task>.md`. Once this is complete, ensure `/reflect` is invoked to ensure the prompt is valid and complete.

## Step 3: Execute with a crispy-agent

Dispatch with the distilled prompt:

```bash
PROMPT_FILE=.ai-reference/prompts/<distilled>.md $CRISPY_AGENT
```

**Capture the session_id from the output** (`[session_id: <uuid>]` on the
last line). You will resume this same agent in Step 4. Sessions stay alive
by default — do not pass `--auto-close`.

## Step 4: Agent self-review (loop)

Resume the same crispy-agent to run its own review:

```bash
$CRISPY_AGENT --resume <session_id> "Run /simplify on your changes, then /superthink to catch regressions. Fix anything surfaced and repeat until LGTM."
```

The agent does this inside its own context. Your main thread only dispatches.

## Step 5: Divergence check (main thread)

Diff the final code against the _original_ plan. Classify every change:

- **Required** for the plan's goal → accept silently
- **Beneficial** adjacent fix / obvious cleanup → surface briefly to the user, default accept
- **Unauthorized** scope expansion / reinterpretation → resume the agent with specific revision instructions, then loop back to Step 4

Lean strict on unauthorized. Agent "helpfulness" that silently expands scope
is the most common regression. Don't accept "I also refactored X for
cleanliness" unless X was in the plan.

## Step 6: Testing

Surface the test plan from Step 1 to the user for manual execution. Walk
them through it if helpful.

> Future: once Crispy agents have RPC access to `SendTurn` and `--home`,
> this step can be automated by dispatching a browser-capable agent
> against the test plan. For now, the human runs the tests.

## Failure handling

Not scripted. If a crispy-agent fails mid-execution, the main thread
decides — restart, resume with a fix, or escalate. Apply judgment based on
what failed and how far it got.

## Related skills

- `/distill` — writes the execution-ready prompt (Step 2)
- `/superthink` — multi-vendor adversarial review (Steps 1 & 4)
- `/simplify` — code reduction pass (Step 4)
- `/crispy-agent` — the IPC dispatch wrapper (Steps 3 & 4)
- `/handoff` — when you want to rotate sessions, not execute end-to-end
