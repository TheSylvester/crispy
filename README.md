# Leto

**Cross-vendor agent orchestration for AI coding tools**

Leto is an open-source VS Code extension that unifies AI coding agents --
Claude Code, Codex, Gemini CLI, OpenCode -- behind a single UI. Interactive
chat, session management, transcript rendering, approval flows, and
fork/resume, all working today. One interface for every agent.

---

## Why Leto?

Every AI coding tool operates in isolation. Each session starts cold. Switching
vendors means switching UIs. Your conversation history is scattered across
vendor-specific formats in hidden directories.

Leto fixes this. It normalizes vendor transcripts into a universal format, gives
you a single UI to interact with any agent, and keeps your history browsable,
searchable, and actionable.

---

## Features

**Session Browser** -- Browse sessions by project. Select, resume, or create
new conversations from a sidebar.

**Transcript Viewer** -- Three rendering modes: Rich (structured tool cards,
syntax highlighting, diffs), Compact (dense overview), and YAML (raw data).

**Interactive Chat** -- Send messages, resume sessions, start new conversations,
fork from any point. Fully wired to the Claude Code SDK, not a read-only viewer.

**Fork & Resume** -- Branch any conversation from any message. Fork to a new
panel. Resume where you left off.

**Approval System** -- Handle tool approvals inline: standard permission
prompts, AskUser questions, ExitPlanMode decisions. Three distinct approval
flows with contextual UI.

**Agency Modes** -- Plan mode, auto-accept, ask-before-edits, bypass
permissions. Switch modes mid-conversation.

**Model Selection** -- Switch between Opus, Sonnet, and Haiku mid-conversation.

**Tool Visualization** -- Collapsible, syntax-highlighted cards for Bash, Grep,
Glob, Read, Write, Edit, Task, Todo, WebFetch, WebSearch. Generic fallback for
MCP and custom tools.

**Image Attachments** -- Drag and drop files or paste from clipboard.

**Theme Integration** -- Automatic VS Code light/dark theme support via CSS
variables.

**Browser Mode** -- Run the full UI in a browser at `localhost:3456` via the
dev server. Same features, no VS Code required.

---

## Coming Soon

- Multi-vendor adapters (Codex, Gemini, OpenCode)
- Session sidebar with cross-vendor history
- Cross-vendor memory system
- Agent delegation across vendors
- Replay-based eval framework
- Transcript blame and commit

---

## Installation

Leto is not yet published to a marketplace. Install from source:

```bash
git clone https://github.com/TheSylvester/crispy.git
cd crispy
npm install
npm run build
```

Then in VS Code: **Extensions > Install from VSIX** or press `F5` to launch
the extension development host.

---

## Usage

1. Open VS Code in a project that has Claude Code sessions
2. Run `Crispy: Open` from the command palette (`Ctrl+Shift+Alt+I`)
3. Browse sessions in the sidebar, or start a new conversation
4. Use the control panel at the bottom for chat input, model selection, and
   agency mode toggles

For browser mode:

```bash
npm run dev
# Open http://localhost:3456
```

---

## Architecture

Two halves: **core** and **webview**.

**Core** (`src/core/`) -- Vendor-agnostic transcript types, per-vendor adapters
that normalize raw formats into `TranscriptEntry`, session management, and the
`AgentAdapter` interface. The adapter layer means adding a new vendor is
isolated work -- implement the interface, register the adapter.

**Webview** (`src/webview/`) -- React 19 UI with esbuild bundling. Vanilla CSS
using VS Code theme variables. Three rendering pipelines (Rich/Compact/YAML),
a tool registry for tracking tool lifecycle, and a transport layer that
abstracts communication (postMessage for VS Code, WebSocket for browser mode).

**Dev Server** (`src/host/dev-server.ts`) -- Lightweight HTTP + WebSocket
server. Serves the webview bundle and provides the same RPC interface as the
VS Code extension host. Uses the same session manager and adapter registration.

---

## Development

### Prerequisites

- Node.js 20+
- npm
- Claude Code CLI (for live session interaction)

### Scripts

```bash
npm run build          # Build extension + webview + dev server
npm run dev            # Build webview and start dev server at localhost:3456
npm run typecheck      # Strict TypeScript check
npm test               # E2E pipeline test
npm run test:unit      # Vitest unit tests
```

### Project Structure

```
src/
  core/
    transcript.ts          # Universal transcript types
    agent-adapter.ts       # AgentAdapter interface
    session-manager.ts     # Session lifecycle
    session-channel.ts     # Live session streaming
    adapters/
      claude/              # Claude Code adapter
  webview/
    App.tsx                # Root component
    transport.ts           # SessionService interface
    transport-vscode.ts    # VS Code postMessage transport
    transport-websocket.ts # WebSocket transport
    tool-registry.ts       # Tool use/result lifecycle tracking
    components/
      TranscriptViewer.tsx # Main transcript display
      SessionSelector.tsx  # Session browser sidebar
      control-panel/       # Chat input, toggles, settings
      approval/            # Approval flow components
    renderers/
      RichEntry.tsx        # Rich mode entry renderer
      CompactEntry.tsx     # Compact mode renderer
      BlockRenderer.tsx    # Block type dispatcher
      tools/               # Per-tool renderers
    context/               # React context providers
    hooks/                 # Custom hooks
  host/
    dev-server.ts          # Browser mode server
    webview-host.ts        # VS Code webview panel host
    client-connection.ts   # RPC handler (shared by both hosts)
  extension.ts             # VS Code extension entry point
```

---

## Requirements

- VS Code 1.94+ (or any compatible fork)
- Claude Code CLI installed and authenticated

---

## License

MIT
