---
name: peer-sessions
description: Discover and read other sessions currently open in this Crispy host. Use when a coordinator/observer agent needs to find peer sessions, inspect their recent turns, or watch them live. Triggers on "what sessions are open", "list live sessions", "read peer session", "find other agent", "cross-session", "watch another session", "see what else is running". Covers `listOpenSessions` and `readSessionTurns` RPCs; `postMessage` and `waitForIdle` will land here as they ship.
allowed-tools: Bash
---

# Peer Sessions (cross-session observation)

Agents running inside Crispy can discover and read other live sessions in
the same host. This skill documents the RPCs that make that possible and
the natural composition pattern.

**Use this when:** you're a dispatched child, Rosie, a coordinator, or
otherwise want to answer *"what other sessions are running, and what
have they been doing?"* without the user telling you out-of-band.

## The two current verbs

Both speak to the Crispy host over its RPC socket. `$CRISPY_DISPATCH`
(the dispatch CLI) is the transport; no separate tool needed.

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
    "state": "idle",            // idle | streaming | awaiting_approval | background
    "pendingApprovalCount": 0,
    "entryCount": 17,
    "sessionKind": "system",    // only for system sessions (Rosie, tracker)
    "isSidechain": true,        // only for Claude sidechains
    "parentSessionId": "uuid",  // only if this is a registered child
    "childVisible": true,       // only with parentSessionId
    "childAutoClose": false     // only with parentSessionId
  }
]
```

Tombstones (`unattached` / `tearing` channels) and pending IDs are
filtered out. `entryCount` is a monotonic counter — diff across calls
to detect new entries. It is NOT a general freshness signal; status-
only transitions don't bump it.

### `readSessionTurns` — read

Returns the user↔assistant turns of any session. Tool calls and tool
results are stripped; only real text is kept.

```bash
# All turns
$CRISPY_DISPATCH rpc readSessionTurns '{"sessionId":"<uuid>"}'

# Incremental: only turns after your last-seen number
$CRISPY_DISPATCH rpc readSessionTurns '{"sessionId":"<uuid>","from":N}'

# Range
$CRISPY_DISPATCH rpc readSessionTurns '{"sessionId":"<uuid>","from":3,"to":5}'
```

Returns `{ turns: { turn, user, assistant }[] }` — `turn` is a 1-indexed
number that's stable for a given session ID.

**Incremental read pattern:**

```bash
# Track last seen turn locally
LAST=0
while :; do
  NEW=$($CRISPY_DISPATCH rpc readSessionTurns "{\"sessionId\":\"$SID\",\"from\":$((LAST+1))}")
  # ... process NEW.turns ...
  LAST=$(echo "$NEW" | jq '.turns | map(.turn) | max // '$LAST)
  sleep 5
done
```

## The composition pattern

```
listOpenSessions  →  pick a target  →  readSessionTurns  →  act
      (discover)        (agent logic)       (read context)
```

**Example — observe what else is running:**

```bash
# 1. What's live?
$CRISPY_DISPATCH rpc listOpenSessions

# 2. Read the last few turns of an interesting one
$CRISPY_DISPATCH rpc readSessionTurns '{"sessionId":"<uuid>","from":-5}'
# (negative `from` not supported today — use total turn count minus N)
```

**Example — poll a peer for new activity:**

Store `lastSeenTurn` per target. On each poll, call `listOpenSessions`
to confirm the target is still live, then call `readSessionTurns` with
`from: lastSeenTurn + 1`.

## Filtering by your needs

| Goal | Filter |
|------|--------|
| User sessions you could legitimately observe | Default call — no flags |
| Also see Rosie / tracker / system sessions | `{"includeSystem":true}` |
| Also see Claude sidechains (Task tool children) | `{"includeSidechains":true}` |
| Only Claude sessions | Filter client-side by `vendor === "claude"` |
| Only active sessions | Filter client-side by `state !== "idle"` |
| Only your own children | Filter by `parentSessionId === $CRISPY_SESSION_ID` |

## Coming soon (not yet shipped)

- **`postMessage`** — fire-and-forget send to a target session without
  spawning a child. Permissive by default (accepts while target is
  streaming). Adapter-level queuing behavior varies by vendor.
- **`waitForIdle`** — block until a target session reaches idle state
  (with turn-awareness for poke-while-busy scenarios).

The full composition `listOpenSessions → pick → postMessage → waitForIdle →
readSessionTurns` unlocks agent↔agent request/response without the
caller dispatching a child. This skill will grow to cover those verbs
as they land.

## Prerequisites

- Running Crispy host (the skill checks for `~/.crispy/ipc/servers.json`
  or `$CRISPY_SOCK`).
- `$CRISPY_DISPATCH` env var set (auto-injected in Crispy-managed
  sessions).

## Notes

- All IDs returned are real session IDs — pending IDs are filtered.
  Except for the documented edge cases: a caller can theoretically
  create a non-standard pending key via `sendTurn`'s `pendingId` param,
  and a just-opened sidechain whose JSONL hasn't been indexed yet may
  briefly pass the default sidechain filter.
- No auth gate. The trust model is "whoever has the socket has full
  access" — same as `listSessions`. Default filtering approximately
  mirrors `listSessions` exposure (best-effort).
- `subscribe` (live event stream) is a separate RPC not covered here.
  See `src/host/client-connection.ts` for its shape; `readSessionTurns`
  is usually sufficient for observation without the live-stream
  plumbing.
