# Crispy

**A coding agent workbench — with local agent memory, multi-agent collaboration, and controls you can't get in a terminal.**

Works with Claude Code and Codex. Runs standalone in your browser or as a VS Code / Cursor extension.

[![npm](https://img.shields.io/npm/v/crispy-code?label=npm&color=blue)](https://www.npmjs.com/package/crispy-code)
[![Version](https://img.shields.io/open-vsx/v/the-sylvester/crispy?label=OpenVSX&color=blue)](https://open-vsx.org/extension/the-sylvester/crispy)
[![Downloads](https://img.shields.io/open-vsx/dt/the-sylvester/crispy?color=green)](https://open-vsx.org/extension/the-sylvester/crispy)
[![License](https://img.shields.io/github/license/TheSylvester/crispy)](LICENSE)
[![Discord](https://img.shields.io/discord/1483243664389177479?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/e2vw4bTPup)

![Crispy — reading project docs, explaining the codebase, and making an edit in one conversation](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/hero.gif)

**Agent memory** — searchable transcripts across all vendors, fully local.
**Multi-agent collaboration** — resumable cross-vendor sessions, directed by your agent of choice.
**Coding agent workbench** — fork, rewind, agency modes, tool auditing, multiple browser tabs or side-by-side VS Code Editor panels, local voice input, and more.

---

## What's New in v0.2.3

### File viewer side panel

The file viewer is now a persistent side panel instead of a modal. Includes
word wrap, markdown preview (auto-enabled for .md files), and quoting from
preview mode.

![File viewer panel with markdown preview, titlebar with git branch, and file tree](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/file-viewer-panel.png)

### Workspace picker

The standalone landing page now shows all registered workspaces with an Add
Folder input. URL-based routing supports multiple projects from a single
daemon.

![Workspace picker — select a project to open in standalone mode](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/workspace-picker.png)

### Titlebar

App icon, git branch indicator with dirty-state marker, and compact Crispy
wordmark. Always visible, no session required.

### Standalone fixes

IPC socket path fix for daemon mode to enable multi-agent collaboration and other skills, startup progress messages, Windows
compatibility for postinstall, and dynamic version on the welcome screen.

### Emoji filename support

Emoji characters now work correctly in the file panel, @-mentions, and
linkified paths.

---

## What's New in v0.2

### Agent memory

Every session is indexed locally with full-text and semantic search. Your
agent can find past decisions, debugging threads, and design discussions
across Claude Code and Codex — and read the full conversation back. Not
summaries. Not rules files. The actual transcripts already saved on your
machine. Runs locally after first-use model download — no cloud services, no expiry.

![Agent memory — recall searching past sessions with skill and agent badges](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/agent-memory-recall.png)

### Multi-agent collaboration

Resumable Claude and Codex agents working together in back-and-forth
discussions directed by your coding agent of choice. Your agent dispatches
child sessions across vendors, gets parallel perspectives, and picks up
each session where it left off. No external MCP servers or configuration required.

### Icons render mode (new default)

The new default look. Minor tool calls are collapsed to inline icons that
flow with the conversation — click any icon to open the full detail in the
side panel. Keeps the focus on the conversation, not the tool calls.

### Voice input

Click-to-record voice input with local VAD and speech-to-text. Your speech
is transcribed locally and inserted into the chat input. Requires a
microphone.

### Inline quoting

Select text in any assistant response to quote it into your next message
with your own commentary. No more copy-pasting to reference something the
agent said.

### Copy-to-markdown

One-click copy buttons on assistant messages and tool output cards. Copies
clean, formatted Markdown to your clipboard.

---

## Capabilities

### Conversations

![Fork a conversation into a new side-by-side panel](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/fork.gif)

- Fork and rewind at any point — new session opens side-by-side with full context
- Side-by-side agent windows — as many as your editor can tile
- Execute Markdown files as prompts from the Explorer context menu
- Session browser with search and vendor filtering

### Agent intelligence

- Agent memory — full-text and semantic search across all sessions and vendors
- Multi-agent collaboration — resumable cross-vendor child sessions
- Claude Code and Codex adapters

### Execution control

![Cycle through agency modes — plan, ask, accept, bypass](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/permission-modes.gif)

- Agency modes — plan, ask-before-edits, auto-accept, bypass (persisted per session)
- Dedicated tool panel for auditing tool calls and sub-agent work
- One-click bypass mode and pop-out to external browser

### UI

- Four rendering modes — Icons (default), Blocks, Compact, YAML
- Inline quoting and copy-to-markdown
- Voice input with local VAD and speech-to-text
- Image attachments, @mentions, linkified file paths and URLs
- Light, dark, and high-contrast themes

### Providers

![Model selector showing multiple vendors, and the provider configuration form](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/models.gif)

- Custom model providers — route through any Claude-compatible endpoint
  (GLM-4.7, DeepSeek, local models)
- One-click model switching across vendors

### Standalone mode

- Run `npx crispy-code` — full UI in your browser, no VS Code required
- Background daemon with `crispy start` / `crispy stop` / `crispy status`
- Multiple browser tabs for parallel agent sessions
- Same core features — memory, collaboration, fork, rewind

---

## Coming Soon

- OpenCode adapter
- Gemini CLI adapter

---

## Installation

### Standalone (recommended)

```bash
npx crispy-code
```

Opens Crispy in your browser. No VS Code, no extension install, no config.
Run `npx crispy-code start` for a background daemon, `npx crispy-code stop` to shut it down.

### VS Code / Cursor Extension

Search for **"Crispy"** in the extensions panel, or:

```bash
code --install-extension the-sylvester.crispy
```

Also available on the
[OpenVSX Marketplace](https://open-vsx.org/extension/the-sylvester/crispy).

### From Source

```bash
git clone https://github.com/TheSylvester/crispy.git
cd crispy
npm install
npm run build
node dist/crispy-cli.js
```

---

## Usage

### Standalone

1. Run `npx crispy-code` — browser opens automatically
2. Browse sessions in the sidebar, or start a new conversation
3. Use the control panel at the bottom for chat input, model selection, and
   agency mode toggles
4. Open multiple tabs for parallel sessions

### VS Code

1. Open VS Code in any project
2. Run `Crispy: Open` from the command palette (`Ctrl+Shift+Alt+I`)
3. Same UI, embedded in your editor

---

## Requirements

- Node.js 18+ (standalone) or VS Code 1.94+ (extension)
- Claude Code CLI installed and authenticated
- Codex CLI (optional, for Codex sessions)
- Microphone (optional, for voice input)

---

## Community

- [Discord](https://discord.gg/e2vw4bTPup) — support, feature requests, and discussion
- [GitHub Issues](https://github.com/TheSylvester/crispy/issues) — bug reports and tracking

---

## Third-Party Notices

**`@anthropic-ai/claude-agent-sdk`** — The Claude adapter depends on
Anthropic's Agent SDK, which is proprietary ("All rights reserved") and
governed by [Anthropic's Terms of Service](https://code.claude.com/docs/en/legal-and-compliance).
This dependency is required for Claude Code integration. By using Crispy with
Claude Code, you accept Anthropic's terms for that SDK.

**Codex protocol types** — Files in `src/core/adapters/codex/protocol/` are
generated from the [OpenAI Codex CLI](https://github.com/openai/codex)
project, licensed under Apache-2.0. See `THIRD-PARTY-LICENSES` for details.

## License

MIT — see [LICENSE](LICENSE) for the full text.
