---
name: superthink
description: "IPC-based multi-agent review via Crispy's internal dispatch. Dispatches parallel child sessions (claude + codex by default) through the running Crispy host — no subprocess spawning, results stream live in the UI. Use when you want fast multi-vendor adversarial analysis."
allowed-tools: Bash, Read, Grep, Glob, Task, Skill
---

Think about: $ARGUMENTS

## Figure out the subject

Read, grep, diff — whatever it takes to understand what the user wants
reviewed. Could be a plan file, source files, uncommitted changes, a design
question, anything. Compose a single review/analysis prompt that gives the
agent enough context to do real work — point it at the actual files, explain
what we're looking at and why, and tell it to read the code itself.

**Do not enter plan mode. Do not pre-plan phases. Just start.**

## Dispatch both agents in parallel

Write the prompt to a temp file with a **unique stub** to avoid collisions
across concurrent runs: `/tmp/superthink-<stub>.md` where `<stub>` is a
short random or timestamp-based suffix (e.g. `$(date +%s)-$$` or similar).
Use the same file for both agents.

Launch both via `crispy-agent` **in the same message** using `PROMPT_FILE`:

- **claude**: `PROMPT_FILE=/tmp/superthink-<stub>.md .claude/skills/crispy-agent/scripts/crispy-agent --vendor claude` (`run_in_background`)
- **codex**: `PROMPT_FILE=/tmp/superthink-<stub>.md .claude/skills/crispy-agent/scripts/crispy-agent --vendor codex` (`run_in_background`)

Both get the **identical prompt**. Both save output to `/tmp/crispy-agents/`.
Agents run until their turn completes naturally — no timeout.

**Reading output:** If `TaskOutput` returns empty/metadata-only or "No task
found", fall back to reading the output file directly from
`/tmp/crispy-agents/`. List the directory sorted by time to find the latest
`crispy-agent-*.log` files.

Capture their session IDs from the `[session_id: ...]` output.

## Wait for BOTH agents, then collect conclusions

**Wait for both background tasks to complete before proceeding.** Do not
start verification after only one returns — the second agent's perspective
may change your verification strategy.

Check if either agent's output is only intermediate narration (tool-use
summaries like "Let me read...", "I'm checking...") without a final analysis.
This happens when agents spend their entire turn researching without
synthesizing. **Resume those agents** to get their conclusions:

- **claude**: `.claude/skills/crispy-agent/scripts/crispy-agent --vendor claude --resume <session-id> "You were investigating <topic>. Synthesize your findings into a concrete analysis. What did you find? What's the root cause? What's the fix?"`
- **codex**: `.claude/skills/crispy-agent/scripts/crispy-agent --vendor codex --resume <session-id> "You were investigating <topic>. Synthesize your findings into a concrete analysis. What did you find? What's the root cause? What's the fix?"`

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

- **claude**: `.claude/skills/crispy-agent/scripts/crispy-agent --vendor claude --resume <session-id> "pushback message"`
- **codex**: `.claude/skills/crispy-agent/scripts/crispy-agent --vendor codex --resume <session-id> "pushback message"`

The agent should defend its position with new evidence or concede. If it
still disagrees after looking again, that's a live dispute.

## Settle disputes with the other agent

Any 2-way dispute — one agent says it's real, you (or a sub-agent) say it's
not, and the agent defended itself — put it to the **other** agent by
resuming that agent's session with the dispute context. The third perspective
settles it.

## Report and stop

Tell the user what happened:

- What was **confirmed** — real issues both agents or verification agreed on
- What was **disputed and settled** — who said what, who won, why
- What was **rejected** — false positives that didn't survive scrutiny
- Any **open questions** where you genuinely aren't sure

Then stop. The user decides what to do next — fix things, dig deeper, ignore
it, whatever. Do not auto-fix. Do not suggest next steps unprompted.
