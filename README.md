# Crispy

**A zero-compromise UI for Claude Code and Codex — with agent memory, multi-agent collaboration, and a Discord bot that puts your entire workspace in your pocket.**

Runs standalone in your browser, as a VS Code / Cursor extension, or through Discord on your phone.

[![npm](https://img.shields.io/npm/v/crispy-code?label=npm&color=blue)](https://www.npmjs.com/package/crispy-code)
[![Version](https://img.shields.io/open-vsx/v/the-sylvester/crispy?label=OpenVSX&color=blue)](https://open-vsx.org/extension/the-sylvester/crispy)
[![Downloads](https://img.shields.io/open-vsx/dt/the-sylvester/crispy?color=green)](https://open-vsx.org/extension/the-sylvester/crispy)
[![License](https://img.shields.io/github/license/TheSylvester/crispy)](LICENSE)
[![Discord](https://img.shields.io/discord/1483243664389177479?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/e2vw4bTPup)

![Crispy — reading project docs, explaining the codebase, and making an edit in one conversation](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/hero.gif)

**Discord bot** — approve tool use, browse sessions, and manage your workspace from your phone. Not a chatbot — a live session monitor with full tool-call visibility.
**Agent memory** — every transcript indexed locally with full-text + semantic search. No cloud, no API calls.
**Multi-agent /superthink** — pit Claude and Codex against each other on the same question. Catches bugs and blind spots a single model misses.
**Fork, rewind, and control** — agency modes, tool audit panel, side-by-side panels, inline quoting, voice input, and more.

---

## What's New in v0.2.7

### Your entire workspace, in Discord

Crispy now runs a Discord bot that mirrors your coding sessions into your own
server — live transcript rendering, inline approval buttons, session
management, all from your phone or any device with Discord.

This isn't a chatbot. Every competitor (Claude Code Channels, OpenClaw, Hermes
Agent) builds a text pipe where Discord *is* the session and tool calls are
hidden. Crispy is different: Discord is a **live session monitor** with full
tool-call visibility, structured approvals, and a session browser — the same
information you see in the Crispy UI, rendered into Discord.

![Crispy Discord bot — live session monitor with tool calls, approvals, and forum-based session management](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/discord.png)

- **Forum-based sessions** — each workspace gets a forum channel, each session
  is a thread. Browse, search, and manage sessions naturally
- **Inline approvals** — approve or deny tool use with Discord buttons, right
  from your phone. No copy-pasting confirmation codes
- **Session management** — `!sessions` to browse, `!open` to resume, `!stop`
  to close. A concierge bot, not a dumb bridge
- **Multi-instance support** — run multiple Crispy instances against the same
  server. PID-scoped channels, automatic health probes, dead-bot cleanup
- **Setup wizard** — guided onboarding in Settings with token validation,
  auto-generated invite URL, and step-by-step instructions
- **Secure by default** — fail-closed authorization, allowlist-based access,
  OAuth owner resolution. Nobody interacts unless explicitly permitted

### Other improvements

- **Auto-reflect toggle** — enable automatic plan verification in Settings
- **Smarter session list** — two-line title + subtitle layout with display
  names matching the webview
- **Permission lifecycle diagnostics** — Rosie Log now surfaces permission
  mode transitions for debugging
- **Windows stability** — `windowsHide` on all spawn/exec calls prevents
  console flash on Windows
- **Recall fix** — embedding separator always set correctly in one-shot path

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

### Discord

![Crispy Discord bot — live session monitor with tool calls, approvals, and forum-based session management](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/discord.png)

- Live session monitor — full transcript rendering with tool-call visibility, not a hidden chatbot
- Forum-based session browser — each workspace is a forum channel, each session a thread
- Inline approval buttons — approve or deny tool use from your phone
- Session management commands — browse, open, and close sessions from Discord
- Multi-instance — multiple Crispy instances share one server without conflicts
- Secure by default — fail-closed auth, allowlist access, guided setup wizard

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
