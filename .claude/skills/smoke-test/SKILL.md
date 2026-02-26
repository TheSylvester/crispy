---
name: Smoke Test
description: Visual smoke tests for the Crispy webview via browser automation. Use when the user asks to "smoke test", "test the UI", "visual test", "run smoke tests", "verify the webview", or wants to confirm the dev server UI works end-to-end.
---

# Crispy Smoke Test

End-to-end visual smoke tests for the Crispy webview. Runs against the dev
server (`npm run dev` at http://localhost:3456) using browser automation via
the `browser-qa` sub-agent.

## When to Use

- After any UI, adapter, or session-management changes
- Before shipping a release
- When investigating "send doesn't work" or similar reports
- Any time you want confidence the full stack works end-to-end

## Prerequisites

1. Dev server must be running: `npm run dev` (port 3456)
2. Chrome browser with Claude-in-Chrome extension connected

If the server isn't running, start it in background before launching the test:
```bash
lsof -i :3456 | grep LISTEN | awk '{print $2}' | xargs -r kill 2>/dev/null
npm run dev &
# Wait for "Crispy dev server running" message
```

## Test Plan

Launch a **single `browser-qa` sub-agent** with the full test plan below.
The agent should take screenshots at each step and report pass/fail.

### Test Sequence

Each step builds on the previous one. The agent should verify UI state via
screenshots and console error checks (`read_console_messages` with
pattern `"error|Error|exception|fail"`) at each step.

#### Step 1: Fresh Load + Codex Session
1. Navigate to `http://localhost:3456`
2. Verify: sidebar loads, session list populates, no JS errors
3. Select a project from the CWD dropdown (if not auto-selected)
4. Select **Codex** from the vendor selector
5. Type "Say hello in one sentence" and send (Ctrl+Enter)
6. Verify: session creates, message appears, agent responds (or spawn error
   if codex binary not installed — that's expected, just confirm the error
   surfaces in the UI, not a silent fail)

#### Step 2: Continue Codex Session, Different Permission Mode
1. In the same Codex session, switch permission mode via the agency toggle
   (Alt+Q or click the shield icon)
2. Send "What is 2+2?"
3. Verify: turn completes or error surfaces (no silent fail)

#### Step 3: Switch to Claude and Continue
1. Click "+" or create a new session
2. Select **Claude** from the vendor selector
3. Send "Say hi briefly"
4. Verify: Claude session creates, agent responds with streaming text
5. Send a follow-up: "What did I just ask you?"
6. Verify: context is maintained, response references the prior message

#### Step 4: Swap Back to Codex, Different Permission Mode
1. Use the sidebar to navigate back to the Codex session from Step 1
2. Switch permission mode again (different from Step 2)
3. Send "Repeat the number you told me earlier"
4. Verify: context is maintained within the Codex session

#### Step 5: Fork via Control Panel
1. Return to the Claude session from Step 3
2. Click the **Fork** button in the control panel (or Ctrl+Shift+Enter)
3. Verify: a new tab/panel opens with the forked session
4. Send a message in the forked session: "This is the forked branch"
5. Verify: message sends, agent responds in the new forked session

#### Step 6: Rewind
1. In the forked session, find a user message from earlier in the history
2. Click the **Rewind** button on that message (clock icon in message actions)
3. Verify: session rewinds — history truncates to that point, input pre-fills
4. Send the pre-filled (or modified) message
5. Verify: new turn starts from the rewind point

#### Step 7: In-Message Fork
1. In the Claude session (not the rewound one), find an earlier user message
2. Click the **Fork** button on that message (branch icon in message actions)
3. Verify: a new session is created branching from that point
4. Send a message in the forked session
5. Verify: response uses context up to the fork point only

### Reporting

After all steps, report:
- **Pass/Fail** for each step with screenshot evidence
- **Console errors** found at any point
- **Blocking issues** that prevented later steps
- **Summary** of overall health

## Notes

- Codex sessions will fail to spawn if `codex` binary is not installed —
  that's expected. The test verifies the error surfaces in the UI (not a
  silent fail). Skip Steps 1-2 and 4 if Codex is unavailable and focus on
  Claude steps.
- Claude sessions require the `claude` binary on PATH.
- Fork-to-new-panel (Step 5) creates a second browser tab in dev-server mode.
- The rewind flow (Step 6) clears the current session and re-loads truncated
  history — watch for visual glitches.
