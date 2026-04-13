---
name: superthink
description: "IPC-based multi-agent review via Crispy's internal dispatch. Dispatches parallel child sessions (claude + codex by default) through the running Crispy host — no subprocess spawning, results stream live in the UI. Use when you want fast multi-vendor adversarial analysis, or exhaustive fix-until-done convergence on an artifact."
allowed-tools: Bash, Read, Write, Edit, Grep, Glob, Task, Skill
---

Think about: $ARGUMENTS

## Detect intent

Read the user's request and determine which mode applies:

- **Review** — the user wants opinions, analysis, feedback. Phrases like
  "review this", "what do you think", "check this", "analyze", "find issues".
  You report findings. The user decides what to act on.

- **Converge** — the user wants the artifact fixed until it's done. Phrases
  like "fix this", "make it ready", "keep going until done", "exhaustively
  fix", "fix until both agents agree", "make edits and review until LGTM".
  You edit the artifact, re-review, and loop until both agents say it's ready.

If ambiguous, default to **review**. The user can always say "now fix it."

## Figure out the subject

Read, grep, diff — whatever it takes to understand what the user wants
reviewed or fixed. Could be a plan file, source files, uncommitted changes,
a design question, anything. Compose a single review/analysis prompt that
gives the agent enough context to do real work — point it at the actual
files, explain what we're looking at and why, and tell it to read the code
itself.

**Do not enter plan mode. Do not pre-plan phases. Just start.**

## Dispatch both agents in parallel

Write the prompt to a temp file with a **unique stub** to avoid collisions
across concurrent runs: `/tmp/superthink-<stub>.md` where `<stub>` is a
short random or timestamp-based suffix (e.g. `$(date +%s)-$$` or similar).
Use the same file for both agents.

Launch both via `crispy-agent` **in the same message** using `PROMPT_FILE`:

- **claude**: `PROMPT_FILE=/tmp/superthink-<stub>.md $CRISPY_AGENT --vendor claude` (`run_in_background`)
- **codex**: `PROMPT_FILE=/tmp/superthink-<stub>.md $CRISPY_AGENT --vendor codex` (`run_in_background`)

Both get the **identical prompt**.

## Wait for BOTH agents, then collect output via RPC

**Wait for both background tasks to complete before proceeding.** Do not
start verification after only one returns — the second agent's perspective
may change your verification strategy.

**Codex routinely takes 2-3x longer than Claude.** Do not assume Codex is
dead, timed out, or stuck just because Claude finished first.

### Collect output via RPC

Query your child sessions via the `listChildSessions` RPC — this returns
all children spawned by your session, including completed ones:

```bash
crispy-dispatch rpc listChildSessions
```

This returns a JSON object with a `sessions` array. Each entry has
`sessionId`, `vendor`, `status`, `closed`, `visible`, and `autoClose`.

For each child, read the transcript via `readSessionTurns`:

```bash
crispy-dispatch rpc readSessionTurns '{"sessionId": "<child-session-id>"}'
```

Extract the final assistant response from the last turn. This is the
agent's analysis output.

**Do not read from `/tmp/crispy-agents/` log files.** Always use the RPC
methods above — they are reliable and immune to interleaving issues.

Capture each agent's session ID for use in resume operations below.

Check if either agent's output is only intermediate narration (tool-use
summaries like "Let me read...", "I'm checking...") without a final analysis.
This happens when agents spend their entire turn researching without
synthesizing. **Resume those agents** to get their conclusions:

- **claude**: `$CRISPY_AGENT --vendor claude --resume <session-id> "You were investigating <topic>. Synthesize your findings into a concrete analysis. What did you find? What's the root cause? What's the fix?"`
- **codex**: `$CRISPY_AGENT --vendor codex --resume <session-id> "You were investigating <topic>. Synthesize your findings into a concrete analysis. What did you find? What's the root cause? What's the fix?"`

Only proceed to verification once you have substantive analysis from both
agents (not just intermediate progress text).

## Skeptically verify their claims

For each claim or issue an agent raised, send a sub-agent to check it against
the actual code. Be skeptical — grep for the thing, read the file, think hard
about it and ask yourself if the claim holds up. Don't take the review agents
at their word.

Launch verification sub-agents in parallel where possible.

## Push back where claims don't hold up

For anything that looks like a false positive or a stretch, **resume** the
original agent's session and push back with evidence. Tell it what you found
and ask it to look again:

- **claude**: `$CRISPY_AGENT --vendor claude --resume <session-id> "pushback message"`
- **codex**: `$CRISPY_AGENT --vendor codex --resume <session-id> "pushback message"`

The agent should defend its position with new evidence or concede. If it
still disagrees after looking again, that's a live dispute.

## Settle disputes with the other agent

Any 2-way dispute — one agent says it's real, you (or a sub-agent) say it's
not, and the agent defended itself — put it to the **other** agent by
resuming that agent's session with the dispute context. The third perspective
settles it.

---

## Review mode: report and stop

If this is a **review**, tell the user what happened:

- What was **confirmed** — real issues both agents or verification agreed on
- What was **disputed and settled** — who said what, who won, why
- What was **rejected** — false positives that didn't survive scrutiny
- Any **open questions** where you genuinely aren't sure

Then stop. The user decides what to do next — fix things, dig deeper, ignore
it, whatever. Do not auto-fix. Do not suggest next steps unprompted.

---

## Converge mode: fix and re-review until LGTM

If this is a **converge**, do not report to the user yet. Instead:

**The review agents never edit.** They only review. You (the main thread
running this skill) are the one who applies fixes and re-dispatches.
The agents are read-only reviewers across every round.

### Apply fixes yourself

For every confirmed issue from both agents (after verification and dispute
settlement), apply the fix directly to the artifact. Use Edit for surgical
changes, Write only if the file needs a complete rewrite.

Be precise — only fix what the agents identified. Do not add improvements,
refactors, or "while I'm here" changes.

### Re-dispatch for next round

Write a new review prompt that:
1. Lists what you fixed in this round (so agents don't re-report solved issues)
2. Asks agents to verify corrections are accurate and find remaining issues
3. Requires a verdict: `VERDICT: READY` or `VERDICT: NOT READY — [reason]`

Dispatch both agents again (same parallel pattern, new temp file).
The agents get a fresh session each round — they review the updated artifact
from scratch, not a diff.

### Check for convergence

After collecting round N results:

- **Both say READY** → convergence achieved. Apply any final cosmetic fixes
  they noted, then report to the user: what changed across all rounds,
  how many rounds it took, and the final verdict.
- **Either says NOT READY** → apply the new fixes, re-dispatch round N+1.
- **Cap at 5 rounds.** If not converged after 5, report what remains
  unresolved and let the user decide. Infinite loops serve no one.

### Report convergence

When both agents agree the artifact is ready, tell the user:

- How many rounds it took
- Summary of all fixes applied (grouped by severity)
- Any cosmetic notes the agents flagged but that aren't blocking
- The final state of the artifact
