# Architecture

Three layers: **core** (`src/core/`), **host** (`src/host/`), and **webview**
(`src/webview/`).

## Core

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

## Host

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

## Webview

React 19, esbuild, vanilla CSS with `var(--vscode-*)` theme variables.

- **Layout:** Two-column grid — 260px sidebar (`SessionSelector`) + main
  (`TranscriptViewer`).

- **Provider cascade** — `App.tsx` nests: Transport → Environment → Session →
  FileIndex → Preferences → SessionStatus. Inside `TranscriptViewer`:
  BlocksToolRegistry → Fork (per-session, reset on session switch).

- **Rendering pipeline:** Three modes (YAML / Compact / Blocks). Blocks mode:
  Entry → `normalizeToRichBlocks()` → `BlocksBlockRenderer` dispatches to
  per-type views. Extend via `tool-definitions.ts` + `register-views.ts` +
  a new view component — don't add switch statements to BlocksEntry or
  BlocksBlockRenderer.
- **BlocksToolRegistry** (`blocks-tool-registry.ts`): Slim pairing-only
  registry (pure TS). Tracks tool_use → tool_result lifecycle via
  pending/results/orphans maps. Subscribed via `useSyncExternalStore`.
  PerfStore wiring in `BlocksToolRegistryContext.tsx`. Tool results render
  inside their ToolBlockRenderer card via the blocks pipeline.

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
