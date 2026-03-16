---
name: crispy-agent
description: Unified wrapper around crispy-dispatch for multi-vendor IPC dispatch through the running Crispy host. Supports claude, codex, and other vendors. Outputs session_id for conversation continuation.
allowed-tools: Bash
---

# Crispy Agent (unified IPC wrapper)

## Execution

Works in both foreground and background:

```
# Foreground (blocks until turn completes)
Bash(command: ".claude/skills/crispy-agent/scripts/crispy-agent Your prompt here")

# Background (non-blocking — check output later with TaskOutput)
Bash(command: ".claude/skills/crispy-agent/scripts/crispy-agent Your prompt here", run_in_background: true)
```

Background is preferred when launching multiple agents in parallel.

---

Unified wrapper around `crispy-dispatch` (Crispy IPC) for multi-vendor dispatch:

- Provide prompt via arguments, `PROMPT_FILE`, or stdin
- Vendor selection via `--vendor` (default: `claude`)
- Model selection via `--model` / `-m`
- Session resume via `--resume` / `-r`
- Default: no timeout, bypass approvals, session kept alive for resume
- All output goes through Crispy host — sessions stream live in the UI

## Prerequisites

**Running Crispy host** required. The script checks for `~/.crispy/ipc/servers.json` or `$CRISPY_SOCK`.

## Usage

```bash
# Arguments (default vendor: claude)
.claude/skills/crispy-agent/scripts/crispy-agent Your prompt here

# Vendor selection
.claude/skills/crispy-agent/scripts/crispy-agent --vendor codex "Your prompt"

# File via env var
PROMPT_FILE=task.md .claude/skills/crispy-agent/scripts/crispy-agent

# Stdin
cat task.md | .claude/skills/crispy-agent/scripts/crispy-agent
```

### Session Resume

```bash
# Resume by session ID
.claude/skills/crispy-agent/scripts/crispy-agent --resume <UUID> "Follow-up question"

# Resume with vendor
.claude/skills/crispy-agent/scripts/crispy-agent --vendor codex --resume <UUID> "Continue"
```

## Options

| Flag | Description |
|------|-------------|
| `--vendor <v>` | Vendor to dispatch through (default: `claude`) |
| `-m, --model <model>` | Model override |
| `-r, --resume <UUID>` | Resume session by ID |
| `--timeout <ms>` | Override timeout (default: no timeout) |
| `--auto-close` | Close session on completion (default: kept alive) |
| `--visible` | Show session in Crispy editor UI |
| `-f, --fork` | Fork from session (requires `--resume`) |
| `--resume-at <msg-id>` | Fork at specific message (requires `--fork`) |
| `--persist` | Save session to disk (default: ephemeral) |
| `--approval <mode>` | Approval mode: fail, bypass (default), manual |
| `--debug` | Print diagnostics to stderr |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PROMPT_FILE` | Read prompt from this file |
| `CRISPY_SOCK` | Override socket path (skip discovery) |
| `BYPASS_PERMISSIONS` | Set to `1` for `--approval bypass` |

## Output

Returns plain text response followed by the session ID:

```
<response text>

[session_id: <uuid>]
```

Capture the session ID to continue the conversation with `--resume <uuid>`.

Every run also saves output to `/tmp/crispy-agents/crispy-agent-<timestamp>-<pid>.log`.
The path is printed to stderr as `[output_file: ...]`. If `TaskOutput` fails
to capture output from a background run, read this file instead.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Completed successfully |
| 10 | Approval required (session paused, can resume) |
| 11 | Timeout (only if explicit --timeout set) |
| 12 | Transport error / no Crispy host |
| 13 | Invalid usage |
