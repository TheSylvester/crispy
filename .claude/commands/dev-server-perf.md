---
description: "Launch dev server with perf overlay, load a session, and report profiling metrics"
allowed-tools: Bash, Read, Grep, Glob, Task
---

# Perf Profiler — Dev Server

Launch the Crispy dev server with `?perf=1`, load a session with real data, interact to generate metrics, and report the profiling snapshot.

## Setup

1. Build the webview: `npm run build:webview`
2. Check if port 3456 is in use (`lsof -i :3456`). Kill any existing process.
3. Start the dev server in background: `npm run dev`
4. Wait for readiness: poll `curl -s -o /dev/null -w "%{http_code}" http://localhost:3456` until 200.

## Test Flow

Launch a `browser-qa` sub-agent with these instructions:

### Step 1: Open with perf mode

Navigate to `http://localhost:3456?perf=1`. Wait 2s. Take a screenshot.

**Assert:** The perf overlay panel is visible in the top-right corner showing "Perf Profiler" title bar with Reset and x buttons.

### Step 2: Load a session

Click the first session in the sidebar that looks like it has meaningful content (not empty/tiny). Wait 3s for the transcript to fully render.

Take a screenshot showing both the transcript and the perf overlay.

### Step 3: Extract perf snapshot

Run this JavaScript in the browser console:

```js
JSON.stringify(window.__CRISPY_PERF__.getSnapshot(), null, 2)
```

Capture the output.

### Step 4: Scroll interaction

Scroll the transcript up to the top, wait 1s, then scroll back down to the bottom. This exercises the scroll tracking.

### Step 5: Extract final snapshot

Run the same JavaScript again:

```js
JSON.stringify(window.__CRISPY_PERF__.getSnapshot(), null, 2)
```

Take a final screenshot.

### Step 6: Reset and re-measure

Click the "Reset" button on the perf overlay. Wait 1s. Extract the snapshot again to confirm counters are zeroed.

---

## Report

$ARGUMENTS

If arguments are empty, report the full snapshot with commentary on what the numbers mean:

- **React renders**: Which components render most? Is RichEntry count == total entries (proves no memoization)?
- **DOM nodes**: How many? Over 3000 suggests virtualization is needed.
- **Markdown renders**: Count and total ms — is this the #1 cost?
- **FPS**: Did it stay above 30 during scrolling?
- **Long tasks**: Any > 50ms tasks detected?
- **Memory**: Heap usage trend.
- **Tool/orphan counts**: Are orphans accumulating (timing bug)?

If arguments contain "compare", take snapshots before and after toggling render mode (rich → compact → rich) and compare the render count spikes.

If arguments contain "typing", focus on measuring render rate while typing in the chat input (each keystroke triggers ControlPanel re-renders).

## Cleanup

Kill the dev server when done: find the process on port 3456 and kill it.
