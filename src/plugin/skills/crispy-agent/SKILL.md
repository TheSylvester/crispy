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
Bash(command: "$CRISPY_AGENT Your prompt here")

# Background (non-blocking — check output later with TaskOutput)
Bash(command: "$CRISPY_AGENT Your prompt here", run_in_background: true)
```

Background is preferred when launching multiple agents in parallel.

---

Unified wrapper around `crispy-dispatch` (Crispy IPC) for multi-vendor dispatch:

- Provide prompt via arguments, `PROMPT_FILE`, or stdin
- Vendor selection via `--vendor` (default: `claude`)
- Model selection via `--model` / `-m`
- Session resume via `--resume` / `-r`
- Default: no timeout, bypass approvals, sessions persisted
- **Sessions auto-close by default.** This is almost always what you want — auto-closed sessions are persisted and fully resumable via `--resume <uuid>`. Pass `--no-auto-close` only when you need the **in-memory channel** kept attached (e.g. live observation, `postMessage`, `waitForIdle`). Do **not** pass it just to enable a follow-up turn.
- All output goes through Crispy host — sessions stream live in the UI

## Prerequisites

**Running Crispy host** required. The script checks for `~/.crispy/ipc/servers.json` or `$CRISPY_SOCK`.

## Usage

```bash
# Arguments (default vendor: claude)
$CRISPY_AGENT Your prompt here

# Vendor selection
$CRISPY_AGENT --vendor codex "Your prompt"

# File via env var
PROMPT_FILE=task.md $CRISPY_AGENT

# Stdin
cat task.md | $CRISPY_AGENT
```

### Session Resume

```bash
# Resume by session ID
$CRISPY_AGENT --resume <UUID> "Follow-up question"

# Resume with vendor
$CRISPY_AGENT --vendor codex --resume <UUID> "Continue"
```

## Options

| Flag | Description |
|------|-------------|
| `--vendor <v>` | Vendor to dispatch through (default: `claude`) |
| `-m, --model <model>` | Model override |
| `-r, --resume <UUID>` | Resume session by ID |
| `--timeout <ms>` | Override timeout (default: no timeout) |
| `--no-auto-close` | Keep the **in-memory channel** attached after the turn settles. Use only for live observation (`postMessage`, `waitForIdle`, watching events). **Not** required for `--resume` — auto-closed sessions are persisted and resumable. |
| `--auto-close` | Close the in-memory channel when the turn settles (this is the default — flag exists to make intent explicit). Session is still persisted to disk and fully resumable via `--resume <uuid>`. |
| `-f, --fork` | Fork from session (requires `--resume`) |
| `--resume-at <msg-id>` | Fork at specific message (requires `--fork`) |
| `--no-persist` | Don't save session to disk (default: persist) |
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

For full transcript access (turn-by-turn user/assistant content), use the
`readDialogue` RPC:

```bash
$CRISPY_DISPATCH rpc readDialogue '{"sessionId": "<uuid>"}'
```

## See also

`crispy:live-sessions` — for sessions kept alive with `--no-auto-close`,
you can `postMessage` (deliver a turn), `waitForIdle` (block until the
target settles), and `readDialogue` (read user↔assistant pairs) without
spawning a new `crispy-agent` subprocess. Use the live-sessions verbs
when you already have the session ID and the session is intentionally
alive; use `--resume` when the session may have closed and needs
rehydration.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Completed successfully |
| 10 | Approval required (session paused, can resume) |
| 11 | Timeout (only if explicit --timeout set) |
| 12 | Transport error / no Crispy host |
| 13 | Invalid usage |
