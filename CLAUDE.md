# Crispy

Clean-room rewrite of [Leto](../leto/) — a VS Code extension that unifies
cross-vendor AI coding agents (Claude Code, Codex, Gemini, OpenCode) behind a
single UI. Goal: interactive chat, session history, vendor delegation,
transcript-as-data.

**Current status:** Transcript viewing and session discovery work. Interactive
chat input and multi-vendor UI are not yet built (infrastructure is ready for
both).

## Architecture

Two halves: **core** (`src/core/`) and **webview** (`src/webview/`).

### Core

`transcript.ts` defines vendor-agnostic universal types. Per-vendor adapters
under `adapters/<vendor>/` convert raw formats into `TranscriptEntry`.
`agent-adapter.ts` defines the `AgentAdapter` interface; `VendorDiscovery`
handles session listing/loading. Only Claude is wired up today.

### Webview

React 19, esbuild, vanilla CSS with `var(--vscode-*)` theme variables.

- **Layout:** Two-column grid — 260px sidebar (`SessionSelector`) + main
  (`TranscriptViewer`). Context providers: Transport → Session → ToolRegistry.
- **Rendering pipeline:** Three modes (YAML / Compact / Rich). Rich mode:
  Entry → `normalizeToBlocks()` → `BlockRenderer` dispatches to per-type
  renderers. Extend via `block-registry.ts` + a new renderer component —
  don't add switch statements to RichEntry or BlockRenderer.
- **ToolRegistry** (`tool-registry.ts`): Standalone mutable store (pure TS).
  Tracks tool_use → tool_result lifecycle, parent-child nesting, orphan
  queuing. Subscribed via `useSyncExternalStore` for per-tool re-renders.
  Tool results return null from BlockRenderer and render on their ToolCard.
- **Transport** (`transport.ts`): Typed RPC interface with VS Code postMessage
  and WebSocket (dev server) implementations. `send()`, `resolveApproval()`,
  `interrupt()` exist but have no UI driving them yet.
- **Tool renderers** under `renderers/tools/` — Bash, Grep, Glob, Read,
  Write, Edit, Task (with nested children). Shared components in `tools/shared/`.

## Key rules

- **`transcript.ts` is vendor-agnostic.** No vendor-specific fields. Use the
  `metadata` bag. Read `.ai-reference/reference/` specs before changing types.
- **Adapter exports are vendor-prefixed** (`ClaudeAgentAdapter`,
  `adaptClaudeEntry`) to avoid confusion with universal types.
- **Schema versioning:** Claude Code's app version is the de facto schema
  version. Fixtures in `test/fixtures/claude/` are keyed by version.

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
