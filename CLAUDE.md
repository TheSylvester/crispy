# Crispy

A zero-compromise UI for Claude Code, Codex, and more — with controls you
can't get in a terminal. VS Code / Cursor extension today, standalone browser
app after v0.1.x.

Claude and Codex adapters are shipping. Gemini CLI and OpenCode are next.

## Architecture

Three layers: **core** (`src/core/`), **host** (`src/host/`), **webview**
(`src/webview/`). Core owns state and logic; host is a thin RPC router;
webview derives state client-side from channel events.

**Full detail:** [`architecture.md`](./architecture.md)

### Core (`src/core/`) — logic and state

Vendor-agnostic contracts, session orchestration, persistence. Free functions
with module-level state, not classes — no `this`.

- Universal types (`transcript.ts`) — vendor-agnostic; use `metadata` bag for vendor extras
- Adapter contract (`agent-adapter.ts`) — new adapters implement, never extend
- Event types (`channel-events.ts`) — idle/active/approval state transitions
- Session multiplexer (`session-channel.ts`) — dumb pub/sub, no transformation; adapters emit, UI interprets
- Session orchestration (`session-manager.ts`) — adapter registry, create/load/fork, pending→real ID re-keying
- Session list (`session-list-manager.ts`) — background rescan, push notifications
- Persistence (`activity-index.ts`) — owns all `~/.crispy/` I/O
- File service (`file-service.ts`) — git-backed file listing, @-mention indexing
- Provider config (`provider-config.ts`) — dynamic provider CRUD, hot-reload watch
- Per-vendor adapters (`adapters/claude/`, `adapters/codex/`)

**State ownership:** session lifecycle, pending approvals, adapter registry,
disk persistence. **When adding behavior, ask:** does this touch session
state, transcript data, or vendor logic? → it belongs here.

### Host (`src/host/`) — transport and wiring

Thin RPC router. Creates transport abstractions, routes client requests to
core, wires adapters at startup. No business logic.

- RPC protocol (`client-connection.ts`) — JSON-RPC wire protocol, request/response correlation
- Adapter registration (`adapter-registry.ts`) — one-shot startup wiring
- Internal dispatch (`agent-dispatch.ts`) — in-process loopback client
- VS Code host (`webview-host.ts`) — panel management, VS Code–specific methods
- Dev server (`dev-server.ts`) — HTTP + WebSocket on port 3456

**State ownership:** connection lifecycle, subscription tracking — nothing
else. **When adding behavior, ask:** is this just routing a call or managing
a transport? → it belongs here. Anything else → push down to core.

### Webview (`src/webview/`) — UI rendering

React 19, esbuild, vanilla CSS. Derives all state client-side from channel
events. No direct file I/O or process spawning. **State ownership:** UI-only
(scroll position, panel expand/collapse, render mode, playback position).

- Provider cascade (`context/`) — Transport → Environment → Session → FileIndex → Preferences
- Blocks rendering pipeline (`blocks/`) — normalize → dispatch → tool-specific views
- Tool views (`blocks/views/`) — per-tool compact/expanded renderers
- Components (`components/`) — TranscriptViewer, ControlPanel, approval flow, session browser
- Hooks (`hooks/`) — reusable React logic (transcript, status, approvals, scroll)
- Alternative renderers (`renderers/`) — Compact and YAML modes

**Extending the UI:**
- New tool → metadata in `tool-definitions.ts`, view in `blocks/views/`, register in `register-views.ts`
- New approval type → variant in `ApprovalContent.tsx`, new component
- New context → file in `context/`, add to cascade in `App.tsx`

## Do not

- **Add business logic to host.** `client-connection.ts` routes RPCs — it
  does not interpret session events, manage state transitions, or reach into
  core internals. The core-plumbing refactor (beaf021) cleaned up exactly
  this: duplicated re-keying, copy-pasted pending-channel boilerplate, and
  `getChannel()` leaking core state to host. Don't recreate it.
- **Add vendor-specific fields to `transcript.ts`.** Use the `metadata` bag.
  Rule of thumb: all vendors need it → base type; one vendor needs it →
  metadata; unsure → metadata first, promote later.
- **Extend the adapter contract.** New adapters implement `AgentAdapter` —
  they do not add fields to it.
- **Add switch statements to `BlocksEntry` or `BlocksBlockRenderer`.** Extend
  via `tool-definitions.ts` → `register-views.ts` → new view component.
- **Replace `useRef` with `useMemo` in `BlocksToolRegistryContext.tsx`.**
  useMemo's cache is discarded unpredictably — causes Task children to vanish.
- **Modify generated Codex protocol files** (`adapters/codex/protocol/**/*.ts`).
  They're auto-generated from ts-rs.
- **Write to `~/.crispy/` outside `activity-index.ts`.** It owns all reads/writes.
- **Use `console.log/warn/error` in `src/core/` or `src/mcp/`.** Use `log()` from
  `src/core/log.ts` instead. `console.*` calls bypass the structured ring buffer
  and won't appear in the Rosie Log panel or respond to `CRISPY_LOG_LEVEL`
  gating. Only exception: fatal subprocess paths where the process is dying and
  structured logging may be unavailable.
- **Use deprecated APIs:** `Transport` → `SessionService`,
  `useSessionCwd()` → `useCwd()`, `extractBashOutput()` → `extractTailMetadata()`.
- **Use vendor adapters or SDKs directly.** All LLM operations go through
  `AgentDispatch`. Only adapter registration (`adapter-registry.ts`,
  `provider-sync.ts`) imports vendor code.
- **Ignore `spec.env` in adapter factories.** Every factory case (fresh,
  resume, fork) must forward `spec.env` to the adapter constructor.
  session-manager injects `CRISPY_SESSION_ID` and `CRISPY_SOCK` there.
- **Create duplicate data structures.** Before adding a map, registry, or
  type union — search for an existing one. Canonical singles:
  `BlocksToolRegistry` (tool pairing), `session-manager.ts` (adapter
  orchestration), `activity-index.ts` (`~/.crispy/` I/O).


## Key rules

- **`transcript.ts` is vendor-agnostic.** No vendor-specific fields. Use the
  `metadata` bag. Read `.ai-reference/reference/` specs before changing types.
- **Adapter exports are vendor-prefixed** (`ClaudeAgentAdapter`,
  `adaptClaudeEntry`) to avoid confusion with universal types.
- **Schema versioning:** Claude Code's app version is the de facto schema
  version. Fixtures in `test/fixtures/claude/` are keyed by version.
- **One API surface per concept.** If there are three ways to do the same
  thing, there should be one. Consolidate before shipping.
- **File headers are contracts.** Every module header declares scope and
  boundaries. Respect them. To expand scope, update the header first. If the
  header feels contradictory, that usually means a split — not an expansion.
- **Session IDs from external input** (CLI args, UI, env vars) must pass
  through `resolveSessionPrefix()` in `session-manager.ts` before use.

### Stable layer boundaries — modify with care

- **`agent-adapter.ts`** — The adapter contract: `AgentAdapter`,
  `VendorDiscovery`, `SessionInfo`, `ChannelMessage`, `TurnIntent`,
  `TurnSettings`, `TurnTarget`, `SessionOpenSpec`, `AdapterSettings`,
  `SubagentEntriesResult`. New adapters implement these types — they do not
  extend them.
- **`channel-events.ts`** — The event types adapters emit.
- **`session-channel.ts`** — Dumb pub/sub broker. Forwards `ChannelMessage`
  as-is to all subscribers. No transformation, no interpretation, no new
  event types. Frontend derives state client-side.
- **`transcript.ts`** — Vendor-agnostic universal types. No vendor-specific
  fields. Use the `metadata` bag for vendor extras.

## Vendor model guidance

When dispatching child sessions or referencing models in tests/scripts:

- **Claude**: `haiku` for fast/cheap Rosie tasks, `sonnet` for quality.
  Model strings: `claude-haiku-4-5`, `claude-sonnet-4-5`.
- **Codex** (ChatGPT account): Models are queried live via `model/list` RPC.
  Available models depend on account type. When in doubt, omit the model
  and let Codex pick its default.
- **Gemini**: Always leave on Auto (omit model). OpenCode: TBD.
- **Cross-vendor format**: `vendor:model` (e.g. `codex:o3`).
  Parsed by `parseModelOption()` in `model-utils.ts`.

## Packaging

**Cursor caches extensions by version directory name.** You cannot rebuild the
same version and expect Cursor to pick up changes — it serves the cached copy.
Every rebuild that needs testing requires a version bump. Always use
`/package-cursor` (which auto-bumps) instead of manually running
`npm run package:linux-x64` + install.

## Commands

- `npm run typecheck` — strict TypeScript check
- `npm test` — e2e pipeline test (finds richest local transcript)
- `npm run test:unit` — vitest unit tests
- `npm run dev` — build webview + dev server at `http://localhost:3456`

## Dev server & visual testing

`npm run dev` serves the webview bundle with real session data from disk.

**Visual verification:** Use the `browser-qa` sub-agent with Chrome automation
tools (`mcp__claude-in-chrome__*`) to navigate to `http://localhost:3456`,
interact, and screenshot. Kill the server when done (`kill $(lsof -i :3456 -t -sTCP:LISTEN)`).

## Reference files (`.ai-reference/`, not committed)

- `reference/` — format specs (Claude JSONL, Codex JSONL, Gemini JSON),
  adapter blueprints, Agent SDK docs. **Read before changing `transcript.ts`
  or writing a new adapter.**
- `behavioral-specs/` — 10 frozen regression contracts documenting current UI
  behavior. **Read before modifying UI behavior.**
- `plans/` — implementation plans and feature designs.
- `prompts/` — orchestration chains for multi-phase implementations.
- `playgrounds/` — interactive HTML/TS playground tools (search explorers,
  visualizers, etc.). All playground artifacts go here, not in the repo root.

## Plugin (`src/plugin/`)

Crispy ships a Claude Code plugin bundled into the extension. It provides
skills, agents, and hooks that are distributed to all Crispy users — they
appear as `crispy:*` in the skill list (e.g. `crispy:recall`,
`crispy:superthink`).

- **Skills** go in `src/plugin/skills/<name>/SKILL.md`
- **Agents** go in `src/plugin/agents/<name>.md`
- **Hooks** go in `src/plugin/hooks/`

**When to use `src/plugin/skills/` vs `.claude/skills/`:**
- `src/plugin/skills/` — distributed to users. Features that work in any
  Crispy-managed session (recall, superthink, handoff, clear-and-execute).
  These rely on Crispy infrastructure (`crispy-dispatch`, `$CRISPY_SESSION_ID`,
  RPC pipe).
- `.claude/skills/` — dev-only. Tools for developing Crispy itself (retro,
  tracker-lab, audit-plans). Not shipped in the extension.

Do not put user-facing skills in `.claude/skills/`. Do not put dev tools
in `src/plugin/skills/`.

## Skills (`.claude/skills/`)

- **Add Git Worktree** (`add-worktree/`) — Isolated worktree at
  `../crispy-<branch>` with `.ai-reference/` symlinked. Run:
  `${SKILL_ROOT}/scripts/add-worktree.sh <branch-name>`

### Reference Repos

- Original Leto extension (local reference at `../leto/`, not included in this repo) — includes the never-completed `webview-next`
