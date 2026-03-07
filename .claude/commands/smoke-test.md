---
description: "Visual smoke tests for the Crispy webview via browser automation"
allowed-tools: Bash, Read, Grep, Glob, Task
---

# Crispy Smoke Tests

Run visual smoke tests against the Crispy dev server using `browser-qa` sub-agents.

## Setup

1. Check if the dev server is running on port 3456 (`lsof -i :3456`). Start it if not: `npm run dev` (background). Wait for 200 from `curl -s -o /dev/null -w "%{http_code}" http://localhost:3456`.
2. Kill the server when all tests are done.

## Test Selection

The user said: `$ARGUMENTS`

If empty, run all tests. Otherwise run the named test.

---

### Test: `rendering` — Entry ordering on initial session load

Text and tool cards must be interleaved on first load — not text bunched at top with tools below.

**Steps:**
1. Navigate to `http://localhost:3456`
2. Click the largest session in the sidebar (most entries — look for one with sub-agents/Task tools)
3. Wait 3s for full load
4. Extract DOM ordering via JavaScript:
   ```js
   const els = Array.from(document.querySelector('.crispy-transcript').children);
   els.slice(0, 20).map((el, i) => {
     if (!el.className.includes('message')) return `[${i}] OTHER`;
     const blocks = Array.from(el.children).map(child => {
       if (child.querySelector('.tool-header-name') || child.classList.contains('crispy-tool-card')) return 'TOOL';
       if (child.classList.contains('assistant-text') || child.classList.contains('user-text')) return 'TEXT';
       return 'OTHER';
     });
     return `[${i}] ${blocks.join('|')}`;
   }).join('\n');
   ```
5. **Assert:** TEXT and TOOL entries are interleaved. There must NOT be a run of 5+ consecutive TEXT-only entries followed by 5+ consecutive TOOL-only entries.
6. Reset to start (⏮), then Jump to end (⏭). Run the same extraction.
7. **Assert:** Ordering matches the initial load.

**Verdict:** PASS if both hold. FAIL if text/tools are segregated or initial load differs from reset+jump.
