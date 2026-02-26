# Crispy

**Cross-vendor agent orchestration for AI coding tools**

Crispy is an open-source VS Code extension that unifies AI coding agents --
Claude Code, Codex CLI, Gemini CLI, OpenCode -- behind a single UI. Interactive
chat, session management, transcript rendering, approval flows, and
fork/resume, all working today. One interface for every agent.

---

## Why Crispy?

Every AI coding tool operates in isolation. Each session starts cold. Switching
vendors means switching UIs. Your conversation history is scattered across
vendor-specific formats in hidden directories.

Crispy fixes this. It normalizes vendor transcripts into a universal format,
gives you a single UI to interact with any agent, and keeps your history
browsable, searchable, and actionable.

---

## Features

**Multi-Vendor Support** -- Claude Code and Codex CLI adapters are implemented
and working. Vendor transcripts are normalized into a universal format so you
get the same UI experience regardless of which agent you use.

**Session Browser** -- Browse sessions by project across vendors. Select,
resume, or create new conversations from a sidebar.

**Transcript Viewer** -- Three rendering modes: Blocks (structured tool cards,
syntax highlighting, diffs), Compact (dense overview), and YAML (raw data).

**Interactive Chat** -- Send messages, resume sessions, start new conversations,
fork from any point. Fully wired to agent SDKs, not a read-only viewer.

**Fork & Resume** -- Branch any conversation from any message. Fork to a new
panel. Resume where you left off.

**Approval System** -- Handle tool approvals inline: standard permission
prompts, AskUser questions, ExitPlanMode decisions. Three distinct approval
flows with contextual UI.

**Agency Modes** -- Plan mode, auto-accept, ask-before-edits, bypass
permissions. Switch modes mid-conversation.

**Model Selection** -- Switch between Opus, Sonnet, and Haiku mid-conversation.

**Tool Visualization** -- Collapsible, syntax-highlighted cards for Bash, Read,
Write, Edit, MultiEdit, NotebookEdit, Glob, Grep, Task, TodoWrite, WebFetch,
WebSearch, Chrome, Skill, EnterPlanMode, ExitPlanMode, AskUserQuestion.
Generic fallback for MCP and custom tools.

**Image Attachments** -- Drag and drop files or paste from clipboard.

**Theme Integration** -- Automatic VS Code light/dark theme support via CSS
variables.

**Browser Mode** -- Run the full UI in a browser at `localhost:3456` via the
dev server. Same features, no VS Code required.

---

## Coming Soon

- Gemini CLI adapter
- OpenCode adapter
- Cross-vendor memory system
- Agent delegation across vendors
- Replay-based eval framework
- Transcript blame and commit

---

## Installation

### Option 1: OpenVSX Marketplace

Search for **"Crispy"** in the VS Code extensions panel and install it
directly.

### Option 2: CLI

```bash
code --install-extension TheSylvester.crispy
```

Or download the `.vsix` file from the
[OpenVSX Marketplace](https://open-vsx.org/extension/TheSylvester/crispy) and
install manually via **Extensions > Install from VSIX**.

### Option 3: From Source

```bash
git clone https://github.com/TheSylvester/crispy.git
cd crispy
npm install
npm run build
```

Then press `F5` in VS Code to launch the extension development host.

---

## Usage

1. Open VS Code in a project that has Claude Code or Codex sessions
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

Three layers: **core**, **host**, and **webview**.

**Core** (`src/core/`) -- Vendor-agnostic transcript types (`transcript.ts`),
the `AgentAdapter` interface (`agent-adapter.ts`), session management
(`session-manager.ts`, `session-channel.ts`, `session-list-manager.ts`), and
per-vendor adapters under `adapters/`. Claude and Codex adapters are
implemented. The adapter layer means adding a new vendor is isolated work --
implement the interface, register the adapter.

**Host** (`src/host/`) -- Two host implementations share the same
`client-connection.ts` RPC protocol. `webview-host.ts` manages VS Code webview
panels. `dev-server.ts` is a lightweight HTTP + WebSocket server that serves
the webview bundle and provides the same RPC interface for browser mode.

**Webview** (`src/webview/`) -- React 19 UI with esbuild bundling. Vanilla CSS
using VS Code theme variables. Three rendering pipelines (Blocks/Compact/YAML),
a blocks tool registry for tracking tool lifecycle, and a transport layer that
abstracts communication (postMessage for VS Code, WebSocket for browser mode).

---

## Development

### Prerequisites

- Node.js 20+
- npm
- Claude Code CLI (for Claude sessions)
- Codex CLI (optional, for Codex sessions)

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
    transcript.ts                   # Universal transcript types
    agent-adapter.ts                # AgentAdapter interface
    session-manager.ts              # Session lifecycle
    session-channel.ts              # Live session streaming
    session-list-manager.ts         # Background session list updates
    adapters/
      claude/                       # Claude Code adapter
      codex/                        # Codex CLI adapter
  webview/
    App.tsx                         # Root component
    transport.ts                    # SessionService interface
    transport-vscode.ts             # VS Code postMessage transport
    transport-websocket.ts          # WebSocket transport
    blocks/
      blocks-tool-registry.ts       # Tool use/result lifecycle tracking
      BlocksBlockRenderer.tsx       # Block type dispatcher
      ToolBlockRenderer.tsx         # Tool card renderer
      tool-definitions.ts           # Tool metadata registry
      views/                        # Per-tool view components
    components/
      TranscriptViewer.tsx          # Main transcript display
      session-selector/             # Session browser sidebar
      control-panel/                # Chat input, toggles, settings
      approval/                     # Approval flow components
    renderers/
      CompactEntry.tsx              # Compact mode renderer
      YamlEntry.tsx                 # YAML mode renderer
    context/                        # React context providers
    hooks/                          # Custom hooks
  host/
    dev-server.ts                   # Browser mode server
    webview-host.ts                 # VS Code webview panel host
    client-connection.ts            # RPC handler (shared by both hosts)
  extension.ts                      # VS Code extension entry point
```

---

## Requirements

- VS Code 1.94+ (or any compatible fork)
- Claude Code CLI installed and authenticated
- Codex CLI (optional, for Codex sessions)

---

## License

MIT
