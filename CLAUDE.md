# Crispy

Clean-room rewrite of [Leto](../leto/) — a VS Code extension that unifies
cross-vendor AI coding agents (Claude Code, Codex, Gemini, OpenCode) behind a
single UI. Goal: interactive chat, session history, vendor delegation,
transcript-as-data.

**Current status:** Fully interactive agent client — chat, approvals,
fork/rewind, session management all wired. Only Claude adapter implemented.

**Codex adapter work lives in the `codex-adapter` branch / `../crispy-codex-adapter` worktree.**

## Architecture

Three layers: **core** (`src/core/`), **host** (`src/host/`), and **webview**
(`src/webview/`).

### Core

`transcript.ts` defines vendor-agnostic universal types. Per-vendor adapters
under `adapters/<vendor>/` convert raw formats into `TranscriptEntry`.
`agent-adapter.ts` defines the `AgentAdapter` interface; `VendorDiscovery`
handles session listing/loading. Only Claude is wired up today.

Functional API convention throughout core — free functions with module-level
state, not classes.

- **`session-channel.ts`** — Per-session state machine:
  `unattached → idle → streaming ↔ awaiting_approval`. Manages subscriptions,
  approval tracking, and history backfill. Broadcasts raw `ChannelMessage`
  (entry/event) plus `HistoryMessage` and `ChannelCatchupMessage` for late
  subscribers. Client-side hooks interpret events into UI state.
- **`session-manager.ts`** — Adapter/channel orchestration. Registers vendor
  adapters, creates/loads/forks sessions, handles pending → real session ID
  re-keying on `session_changed`. `onIdle` hook triggers session list refresh
  ~150ms after idle transition.
- **`session-list-manager.ts`** — Background disk rescan (30s poll), pushes
  `SessionListEvent` upserts. Three update triggers: session creation (instant),
  end of turn (150ms grace), periodic rescan.

### Host

Two host implementations share the same `client-connection.ts` protocol
multiplexer.

- **`client-connection.ts`** — JSON-RPC wire protocol. Request/response
  correlation, event push, per-client subscription tracking. Routes all
  `SessionService` methods to core free functions.
- **`webview-host.ts`** — VS Code panel management. 3-way open logic: no
  panels → create; exists not focused → reveal; focused → create beside.
  Handles VS Code–specific methods (openFile, pickFile, forkToNewPanel).
- **`dev-server.ts`** — HTTP + WebSocket on port 3456. Mirrors webview-host
  protocol over WebSocket; serves static bundle over HTTP. Auto-registers
  `ClaudeAgentAdapter` on startup.

### Webview

React 19, esbuild, vanilla CSS with `var(--vscode-*)` theme variables.

- **Layout:** Two-column grid — 260px sidebar (`SessionSelector`) + main
  (`TranscriptViewer`).

- **Provider cascade** — `App.tsx` nests: Transport → Environment → Session →
  FileIndex → Preferences → SessionStatus. Inside `TranscriptViewer`:
  ToolRegistry → Fork (per-session, reset on session switch).

- **Rendering pipeline:** Three modes (YAML / Compact / Rich). Rich mode:
  Entry → `normalizeToBlocks()` → `BlockRenderer` dispatches to per-type
  renderers. Extend via `block-registry.ts` + a new renderer component —
  don't add switch statements to RichEntry or BlockRenderer.
  **Blocks rendering rules** (view selection, Task children, panel expansion,
  auto-scroll) are documented in `.ai-reference/blocks-rendering-rules.md`.
  Read that file before modifying any rendering logic in `src/webview/blocks/`.

- **ToolRegistry** (`tool-registry.ts`): Standalone mutable store (pure TS).
  Tracks tool_use → tool_result lifecycle, parent-child nesting, orphan
  queuing. Subscribed via `useSyncExternalStore` for per-tool re-renders.
  Tool results return null from BlockRenderer and render on their ToolCard.

- **SessionService** (`transport.ts`): The interface is `SessionService`;
  `Transport` is a deprecated alias. Fully wired RPC with dual
  implementations — VS Code postMessage (`transport-vscode.ts`) and WebSocket
  (`transport-websocket.ts`). Method groups:
  - Session lifecycle: `listSessions`, `loadSession`, `createSession`,
    `forkSession`, `forkToNewPanel`, `close`
  - Agent control: `send`, `interrupt`, `setModel`, `setPermissions`,
    `reconfigure`
  - Approval: `resolveApproval`
  - Subscriptions: `subscribe`, `unsubscribe`, `subscribeSessionList`, `onEvent`
  - File ops: `getGitFiles`, `fileExists`, `readImage`, `openFile`, `pickFile`

- **Control panel** (`components/control-panel/`): Floating bottom-center bar
  with chat input, bypass/agency/model/chrome toggles, settings popup, fork
  button. Fully wired to transport — drives `send`, `createSession`,
  `forkSession`, `forkToNewPanel`, `setModel`, `setPermissions`, `reconfigure`,
  `resolveApproval`.
  - Keyboard shortcuts: Alt+\` (bypass), Alt+Q (agency cycle), Alt+M (model
    cycle), Ctrl+Enter (send), Ctrl+Shift+Enter (fork)
  - Image/file attachment: drag-drop + paste with base64 encoding,
    AttachmentsRow
  - Optimistic user entries: `buildOptimisticUserEntry()` with
    `uuid: "optimistic-*"` prefix, backend dedup
  - `useReducer` for coupled state (bypass ↔ agency)
  - `PlaybackControls` gated behind `?debug=1`

- **Approval system** (`components/approval/`): Three types routed by
  `ApprovalContent`:
  - `StandardApproval` — generic option buttons (Bash/Edit/Write tool use)
  - `AskUserApproval` — multi-question radio/multiselect forms, sends
    `updatedInput` with answers
  - `ExitPlanApproval` — plan review with context-clear checkbox and
    permission mode selection
  - Flow: `approval_request` event → `useApprovalRequest()` hook → UI
    renderer → `transport.resolveApproval(sessionId, toolUseId, optionId,
    extra)`

- **Fork/Rewind** — per-message fork/rewind buttons on user messages
  (in `MessageActions`), disabled during streaming.
  - Fork: creates new session branched at a prior assistant turn
  - Fork-to-new-panel: `forkToNewPanel()` opens new VS Code panel with
    pre-filled state
  - Rewind (fork-in-same-panel): clears session, loads truncated history,
    enters fork mode with original text pre-filled
  - `ForkContext` provides fork targets + execution to `MessageActions`

- **Tool renderers** under `renderers/tools/` — Bash, Grep, Glob, Read,
  Write, Edit, Task (with nested children), TodoWrite. Shared components in
  `tools/shared/`.

## Key rules

- **`transcript.ts` is vendor-agnostic.** No vendor-specific fields. Use the
  `metadata` bag. Read `.ai-reference/reference/` specs before changing types.
- **Adapter exports are vendor-prefixed** (`ClaudeAgentAdapter`,
  `adaptClaudeEntry`) to avoid confusion with universal types.
- **Schema versioning:** Claude Code's app version is the de facto schema
  version. Fixtures in `test/fixtures/claude/` are keyed by version.
- **One source of truth per concept.** Before adding a new map, registry,
  lookup table, or type union — check if an existing one should be extended.
  If you're creating a second place that stores the same kind of information,
  stop and consolidate.
- **File headers are contracts.** Every module's top comment declares what it
  does and what it does NOT do. Respect those boundaries. If you need to
  expand a module's responsibility, update the header first and flag it for
  review.

### Frozen layer boundaries — do not modify without approval

- **`agent-adapter.ts`** — Frozen. The adapter contract (`AgentAdapter`,
  `ChannelMessage`, `SendOptions`, `SessionOpenSpec`).
- **`channel-events.ts`** — Frozen. The event types adapters emit.
- **`session-channel.ts`** — Frozen. Dumb pub/sub broker. Forwards
  `ChannelMessage` as-is to all subscribers. No transformation, no
  interpretation, no new event types. Frontend derives state client-side.

## Commands

- `npm run typecheck` — strict TypeScript check
- `npm test` — e2e pipeline test (finds richest local transcript)
- `npm run test:unit` — vitest unit tests
- `npm run dev` — build webview + dev server at `http://localhost:3456`

## Dev server & visual testing

`npm run dev` serves the webview bundle with real session data from disk.

**Visual verification:** Use the `browser-qa` sub-agent with Chrome automation
tools (`mcp__claude-in-chrome__*`) to navigate to `http://localhost:3456`,
interact, and screenshot. Kill the server when done (`lsof -i :3456`).

## Reference files (`.ai-reference/`, not committed)

- `reference/` — format specs: Claude JSONL, Codex JSONL, Gemini JSON, Agent SDK docs
- `leto-source/` — predecessor adapter/channel/session patterns to reference

## Skills (`.claude/skills/`)

- **Add Git Worktree** (`add-worktree/`) — Isolated worktree at
  `../crispy-<branch>` with `.ai-reference/` symlinked. Run:
  `${SKILL_ROOT}/scripts/add-worktree.sh <branch-name>`

### Reference Repos

- `/home/silver/dev/leto/` — original Leto extension (includes the never-completed `webview-next`)
