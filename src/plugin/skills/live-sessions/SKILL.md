---
name: live-sessions
description: Discover, read, message, and wait on sessions currently live in this Crispy host. Use when a coordinator/observer/peer agent needs to find live sessions, inject a turn, block until one settles, or read another agent's dialogue. Triggers on "what sessions are open", "list live sessions", "read peer session", "send message to session", "post to another agent", "wait for session to finish", "poke a peer agent", "read another agent's response", "find other agent", "cross-session", "watch another session", "see what else is running".
allowed-tools: Bash
---

# Live Sessions (cross-session interaction)

Agents running inside Crispy can discover, read, message, and wait on
other live sessions in the same host. This skill documents the four
RPCs that make that possible, plus the composition patterns you'll
actually use.

**"Live"** here means *currently attached* in the host's `sessions:
Map` — the channel state is one of `idle`, `streaming`,
`awaiting_approval`, or `background`. Sessions that have been closed
or never opened in this run are not live; only `readDialogue` reaches
them (it reads from disk-persisted messages).

**Use this when:** you're a dispatched child, Rosie, a coordinator, or
a peer agent that wants to interact with another running session
without the user telling you out-of-band.

## The four verbs

All four speak to the Crispy host over its RPC socket.
`$CRISPY_DISPATCH` (the dispatch CLI) is the transport; no separate
tool needed.

### `listOpenSessions` — discover

Returns sessions currently open as **live channels** in this host
(distinct from `listSessions`, which returns all sessions on disk).

```bash
# Default: system + sidechain sessions filtered out (mirrors listSessions)
$CRISPY_DISPATCH rpc listOpenSessions

# Opt-in: include Rosie-like system sessions
$CRISPY_DISPATCH rpc listOpenSessions '{"includeSystem":true}'

# Opt-in: include Claude sidechains
$CRISPY_DISPATCH rpc listOpenSessions '{"includeSidechains":true}'
```

Returns `OpenSessionInfo[]` sorted by `sessionId` ascending:

```json
[
  {
    "sessionId": "uuid",
    "vendor": "claude",
    "projectPath": "/path/to/project",
    "state": "streaming",
    "pendingApprovalCount": 0,
    "entryCount": 17,
    "sessionKind": "system",
    "isSidechain": true,
    "parentSessionId": "uuid",
    "childVisible": true,
    "childAutoClose": false,
    "title": "MR slot-sync phantom-link bug",
    "lastUserPrompt": "ok keep going on the spike",
    "lastMessage": "Ran the migration on staging — 0 errors. Moving on next.",
    "lastActivityAt": "2026-04-30T14:22:11.413Z"
  }
]
```

Tombstones (`unattached` / `tearing` channels) and pending IDs are
filtered out.

**Liveness inference** — combine `state` + `lastActivityAt` + `lastMessage`:

| Pattern | Means |
|---------|-------|
| `state: streaming` + recent `lastActivityAt` (seconds ago) | actively producing output |
| `state: streaming` + stale `lastActivityAt` (minutes+ ago) | wedged / stuck mid-tool |
| `state: background` + empty/missing `lastMessage` | tool still running, agent has no text yet |
| `state: background` + recent `lastActivityAt` | background tool is producing output |
| `state: idle` + stale `lastActivityAt` (hours) | zombie subscriber — channel attached but session done |
| `state: awaiting_approval` + `pendingApprovalCount > 0` | blocked on user decision |

`title` collapses the customTitle / title / aiTitle chain — undefined
means no named title is set, in which case `lastUserPrompt` is the
best topic signal. `lastUserPrompt` and `lastMessage` are truncated
to ~300 chars. `lastMessage` is **assistant text only** — tool_use /
thinking blocks are not surfaced.

`entryCount` is a monotonic counter — diff across calls to detect new
entries. Status-only transitions don't bump it. Use `lastActivityAt`
for general freshness.

### `postMessage` — inject a turn

Fire-and-forget delivery of a user turn to an existing live session.
The caller does **not** need to be subscribed to the target.

```bash
$CRISPY_DISPATCH rpc postMessage '{
  "sessionId": "<uuid>",
  "content": "Quick note: skip the cleanup step in this run."
}'
```

Returns `{ "sessionId": "<resolved-uuid>" }` (the same ID after
prefix expansion / pending→real resolution).

**Permissive policy.** `postMessage` does not reject when the target
is streaming or `awaiting_approval` — vendors handle queuing per
their own semantics. Claude queues natively; Codex behavior is
adapter-defined. Reject conditions:

- Empty / malformed `content` →
  `"postMessage: content must be non-empty string or MessageContent"`
- Unknown / closed / pending sessionId → `"Session not active: <id>"`

`content` accepts a string or a `MessageContent` array (text +
content blocks). `clientMessageId` is optional; the host generates
a UUID if omitted.

**Caveat — poke-while-waiting (v1.1).** If the same caller is
simultaneously inside a `waitForIdle` on the target and posts a
second turn to it, the wait helper may resolve on turn-1's idle
before turn-2 lands. Documented, not fixed in v1. For tight
synchronous "send and wait for *this specific* response" loops,
use `dispatchChild` instead.

### `waitForIdle` — block until settled

Blocks until the target session reaches a terminal idle state.

```bash
# Wait indefinitely
$CRISPY_DISPATCH rpc waitForIdle '{"sessionId":"<uuid>"}'

# Wait with a 30s ceiling
$CRISPY_DISPATCH rpc waitForIdle '{"sessionId":"<uuid>","timeoutMs":30000}'
```

Returns `{ "reason": "turnComplete" | "settled" | "timeout" }`:

| Reason | Means |
|--------|-------|
| `turnComplete` | adapter emitted the authoritative end-of-turn signal — most vendors emit this when a turn cleanly finishes |
| `settled` | adapter went idle and stayed quiescent for 2s without `turnComplete` — debounced fallback for adapters that don't emit the authoritative signal |
| `timeout` | `timeoutMs` elapsed before either of the above |

**500ms entry grace window.** If the target is already idle when the
RPC is called, the helper waits up to **500ms** for activity to
appear before resolving `'settled'`. This closes the
`postMessage → waitForIdle` race where `postMessage` returns before
the adapter has emitted `status: 'active'` for the new turn (state
transitions come from adapter events, not synchronously from
`sendTurn`). If the channel really is idle and stays that way, you
get `'settled'` after 500ms — synchronous-feeling, no perceptible
latency.

**Reject conditions:**

- Unknown / closed sessionId → `"Session not active: <id>"`
- Pending / not-yet-rekeyed sessionId → `"Session not active: <id>"`

`waitForIdle` only targets sessions that have rekeyed to a real ID.
For a just-spawned child, wait for its rekey before calling.

### `readDialogue` — read user↔assistant pairs

Returns the user↔assistant turns of any session with persisted
records — open OR closed. Tool calls and tool results are stripped;
only real text is kept (via `extractTurnsFromMessages`).

```bash
# All turns
$CRISPY_DISPATCH rpc readDialogue '{"sessionId":"<uuid>"}'

# Last 5 turns
$CRISPY_DISPATCH rpc readDialogue '{"sessionId":"<uuid>","from":-5}'

# Range
$CRISPY_DISPATCH rpc readDialogue '{"sessionId":"<uuid>","from":3,"to":5}'

# Just the final turn
$CRISPY_DISPATCH rpc readDialogue '{"sessionId":"<uuid>","from":-1,"to":-1}'
```

Returns `{ turns: { turn, user, assistant }[] }` — `turn` is a
1-indexed number stable for the session ID.

**Index semantics:**

- Positive values are 1-indexed and inclusive on both ends:
  `from: 3, to: 5` returns turns 3, 4, 5.
- Negative values count back from the end. On a 10-turn transcript:
  `from: -5` is "start at turn 6" (last 5 turns), `to: -1` is "up to
  and including the last turn." `from: -100` clamps to 1
  (`Math.max(1, total + from + 1)`).
- Defaults: `from = 1`, `to = total`. An empty transcript returns
  `{ turns: [] }`.

**Disk-backed semantic caveat.** `readDialogue` reads from
disk-persisted messages, not the live channel — so it works on
**any session with records in the messages table**, including
closed ones. The other three verbs (`postMessage`, `waitForIdle`,
`listOpenSessions`) require an open channel.

## Composition patterns

### Ask-and-wait-and-read (full request/response with a peer)

```bash
SID="<target-uuid>"

$CRISPY_DISPATCH rpc postMessage "{\"sessionId\":\"$SID\",\"content\":\"What did you find about the migration?\"}"
$CRISPY_DISPATCH rpc waitForIdle "{\"sessionId\":\"$SID\"}"
$CRISPY_DISPATCH rpc readDialogue "{\"sessionId\":\"$SID\",\"from\":-1,\"to\":-1}"
```

For incremental polling, track the last-seen turn locally and read
forward:

```bash
LAST=0
NEW=$($CRISPY_DISPATCH rpc readDialogue "{\"sessionId\":\"$SID\",\"from\":$((LAST+1))}")
LAST=$(echo "$NEW" | jq '.turns | map(.turn) | max // '$LAST)
```

### Fire-and-forget

```bash
$CRISPY_DISPATCH rpc postMessage '{"sessionId":"<uuid>","content":"FYI: deploy went through, no need to retry."}'
```

No wait, no read. Use this when the target's response doesn't
matter to you.

### Superthink follow-up — read a child's final answer

After `dispatchChild` resolves, the child's final answer is the
last turn:

```bash
$CRISPY_DISPATCH rpc readDialogue "{\"sessionId\":\"$CHILD_SID\",\"from\":-1,\"to\":-1}"
```

Works even if the child has since auto-closed — `readDialogue`
reads from disk.

### Discover-then-act

```bash
# 1. What's live?
SIDS=$($CRISPY_DISPATCH rpc listOpenSessions | jq -r '.[].sessionId')

# 2. Pick the relevant one (your filter logic), then read context
$CRISPY_DISPATCH rpc readDialogue "{\"sessionId\":\"$PICK\",\"from\":-3}"
```

## Filtering by need

| Goal | Filter |
|------|--------|
| User sessions you could legitimately observe | Default `listOpenSessions` call — no flags |
| Also see Rosie / tracker / system sessions | `{"includeSystem":true}` |
| Also see Claude sidechains (Task tool children) | `{"includeSidechains":true}` |
| Only Claude sessions | Filter client-side by `vendor === "claude"` |
| Only active sessions | Filter client-side by `state !== "idle"` |
| Only your own children | Filter by `parentSessionId === $CRISPY_SESSION_ID` |
| Sessions stuck mid-stream | `state === "streaming"` AND `lastActivityAt` older than ~2min |
| Sessions on the same topic | Group by `title` or substring-match `lastUserPrompt` |

## Prerequisites

- Running Crispy host (the skill checks for `~/.crispy/ipc/servers.json`
  or `$CRISPY_SOCK`).
- `$CRISPY_DISPATCH` env var set (auto-injected in Crispy-managed
  sessions).

## Notes

- All IDs returned by `listOpenSessions` are real session IDs —
  pending IDs are filtered. `postMessage` and `waitForIdle` resolve
  prefixes and pending→real maps before delivery, but reject any ID
  that is *still pending* after resolution.
- The "turn" unit is internal segmentation — `readDialogue` callers
  paginate via `from` / `to` and consume whatever the call returns.
- No auth gate. The trust model is "whoever has the socket has full
  access" — same as `listSessions`. Default filtering approximately
  mirrors `listSessions` exposure (best-effort).
- `subscribe` (live event stream) and the lifecycle RPCs (`close`,
  the spawn idioms via `crispy-agent`) are deliberately out of scope
  for this skill. Reach for `$CRISPY_DISPATCH rpc subscribe` /
  `$CRISPY_DISPATCH rpc close` directly if you really need them, and
  take responsibility for the consequences.
