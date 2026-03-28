# Crispy

**A power-user's graphical controller for multiple Claude Code and Codex instances at a time, supercharged with agent memory, fork/rewind, multi-agent collaboration, full tool-call visibility, and inline quoting.**

Runs standalone in your browser or as a VS Code / Cursor extension.

[![npm](https://img.shields.io/npm/v/crispy-code?label=npm&color=blue)](https://www.npmjs.com/package/crispy-code)
[![Version](https://img.shields.io/open-vsx/v/the-sylvester/crispy?label=OpenVSX&color=blue)](https://open-vsx.org/extension/the-sylvester/crispy)
[![Downloads](https://img.shields.io/open-vsx/dt/the-sylvester/crispy?color=green)](https://open-vsx.org/extension/the-sylvester/crispy)
[![License](https://img.shields.io/github/license/TheSylvester/crispy)](LICENSE)
[![Discord](https://img.shields.io/discord/1483243664389177479?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/e2vw4bTPup)

![Crispy — reading project docs, explaining the codebase, and making an edit in one conversation](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/hero.gif)

**Agent memory** — every transcript indexed locally with full-text + semantic search. No cloud, no API calls.
**Multi-agent /superthink** — pit Claude and Codex against each other on the same question. Catches bugs and blind spots a single model misses.
**Fork, rewind, and control** — agency modes, tool audit panel, multiple browser tabs or side-by-side VS Code panels, inline quoting, local voice input, and more.

---

## What's New in v0.2.5

### v0.2.5 — Feature Requests + Codex Stability

- **LaTeX math rendering** — inline and display math via `$...$` and `$$...$$`
- **Skill autocomplete** — type `/` in the chat input for a searchable skill picker
- **Codex stability** — three fixes for turn-completion hangs and skill discovery
- **Scroll fix** — long conversations no longer truncate at viewport height

---

## What's New in v0.2.4

### Git diff panel

The sidebar now includes a Git panel showing your working tree changes —
staged, modified, and untracked files grouped by status. Click any file to
see a syntax-highlighted diff preview.

### Session rotation and handoff

Session rotation swaps the adapter on a live channel without tearing down
subscribers — no flash, no re-subscription. Two new plugin skills use it:

- **`/handoff`** — reflects on the conversation, distills a self-contained
  prompt, and rotates into a fresh session so context stays clean
- **`/clear-and-execute`** — clears context and continues with a prompt file,
  useful when context is bloated or you want a clean slate

### Fixes

- File links in VS Code / Cursor now open in the native editor again instead
  of routing through the built-in file viewer
- Fixed a race where the first turn could ignore your persisted agency mode
  if submitted before settings finished loading
- Fixed several Codex fork/resume issues: forked sessions now preserve
  history correctly, no longer duplicate the system prompt, and recover more
  reliably from missing approval state
- Fixed session rotation and discovery edge cases that could attach new
  sessions to the wrong working directory

---

## Capabilities

### Conversations

![Fork a conversation into a new side-by-side panel](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/fork.gif)

- Fork and rewind at any point — new session opens side-by-side with full context
- Side-by-side agent windows — as many as your editor can tile
- Session rotation and handoff — swap adapters on a live channel without re-subscription
- Execute Markdown files as prompts from the Explorer context menu
- Session browser with search and vendor filtering

### Agent intelligence

![Agent memory — recall searching past sessions with skill and agent badges](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/agent-memory-recall.png)

- Agent memory — every session indexed locally with full-text and semantic search across all vendors. Find past decisions, debugging threads, and design discussions — full transcripts, not summaries
- Multi-agent `/superthink` — pit Claude and Codex against each other on the same question. Catches bugs and blind spots a single model misses
- Built-in skills — tell your agent to `/handoff` when context gets long, `/clear-and-execute` a plan from markdown, or `/superthink` for a second opinion. One slash command, no setup
- Claude Code and Codex adapters

### Execution control

![Cycle through agency modes — plan, ask, accept, bypass](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/permission-modes.gif)

- Agency modes — plan, auto-accept, `--dangerously-skip-permissions`, browser mode — one click, persisted per session
- Tool audit panel — every tool call and sub-agent's work in a collapsible panel, not buried in your conversation
- One-click bypass mode and pop-out to external browser

### UI

![File viewer panel with markdown preview, titlebar with git branch, and file tree](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/file-viewer-panel.png)

- File viewer side panel with word wrap, markdown preview, and quoting
- Git diff panel — staged, modified, and untracked files with syntax-highlighted diffs
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

![Workspace picker — select a project to open in standalone mode](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/workspace-picker.png)

- Run `npx crispy-code` — full UI in your browser, no VS Code required
- Background daemon with `crispy start` / `crispy stop` / `crispy status`
- Workspace picker with URL-based routing for multiple projects
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
