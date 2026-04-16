---
name: switch-session
description: >
  Switch to an existing session in-place. Use when the user says "switch to session",
  "load session", "resume session", "go to session", "open session", or provides
  a session ID to switch to.
---

# Switch Session

Load an existing session in-place, replacing the current session on this channel.
The current session is preserved in the session list.

## Usage

~~~
/switch-session <session-id>    — switch to session by ID (prefix match supported)
/switch-session                 — list recent sessions and ask which to load
~~~

## Instructions

### If a session ID is provided

Use `crispy-session` with the `--session` flag:

```bash
$CRISPY_SESSION --session "<session-id>"
```

The script handles prefix resolution server-side. The current session is
preserved — it doesn't get deleted, just detached from this channel.

### If no session ID is provided

1. List recent sessions using crispy-dispatch:
   ```bash
   $CRISPY_DISPATCH rpc listSessions '{}'
   ```
2. Show the user the 10 most recent sessions with their IDs and summaries
3. Ask which one to switch to
4. Execute the switch with the chosen ID

## Edge Cases

- Session ID prefix matches multiple sessions: server returns an error with the ambiguous matches. Show them to the user and ask for a more specific prefix.
- Target session is the current session: server returns a no-op. Tell the user they're already on it.
- Target session is active on another channel: server rejects. Tell the user and suggest they use the session browser instead.
