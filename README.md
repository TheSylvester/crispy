# Crispy

**A GUI for Claude Code and Codex, built for multi-agent orchestration — with 'superthink' adversarial verification, agent memory, and Discord remote access.**

[![npm](https://img.shields.io/npm/v/crispy-code?label=npm&color=blue)](https://www.npmjs.com/package/crispy-code)
[![Version](https://img.shields.io/open-vsx/v/the-sylvester/crispy?label=OpenVSX&color=blue)](https://open-vsx.org/extension/the-sylvester/crispy)
[![Downloads](https://img.shields.io/open-vsx/dt/the-sylvester/crispy?color=green)](https://open-vsx.org/extension/the-sylvester/crispy)
[![License](https://img.shields.io/github/license/TheSylvester/crispy)](LICENSE)
[![Discord](https://img.shields.io/discord/1483243664389177479?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/e2vw4bTPup)

![Crispy — multi-tab agent workbench with visible sub-agent orchestration](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/hero.gif)

- **Discord bot** — live session monitor with inline approval buttons, session browser, and forum-based workspace channels. Approve tool use from your phone.
- **Agent memory** — every transcript indexed locally with full-text search (instant) and semantic search (local model downloaded on first use). Backfills from your existing transcripts across vendors.
- **/superthink** — pit Claude and Codex against each other on the same question. Catches bugs and blind spots a single model misses.
- **Fork or rewind** from any message — opens as a split tab with full context
- **Tool audit panel** — every tool call and sub-agent's work in a collapsible panel with timing and status badges
- **Agency modes** — plan, auto-accept, `--dangerously-skip-permissions` — one click, persisted per session

---

## What's New in v0.3.2

Stability, polish, and a big pass on Windows compatibility.

- **Lower idle GPU usage** — replaced the animated SVG logo with a static PNG.
- **Windows compatibility** — better detection of existing Claude installs across Windows, plus spawn/path-quoting fixes for npm and bun global installs, paths with spaces, and UNC prefixes.
- **Recall upgrades** — search results now show why they matched (provenance), a budget-based reader pulls the right amount of context, and the matched-message workflow jumps straight to the relevant turn. New `--until <date>` filter and `--recent` recency boost on the CLI.
- **SuperThink continuity** — child agents launched by SuperThink now inherit the parent's model, and converge rounds resume cleanly after a reconnect.
- **Fork button** — now targets the correct message based on session state.
- **Smoother transcripts** — reduced flash when switching sessions or vendors, and fixed a scrolling bug that inadvertently cut off conversations during thinking blocks and parallel tool calls.
- **File viewer fixes** — images render instead of crashing on binary extensions, markdown preview scrolls correctly.
- **Per-host Discord controls** — separate Discord bot toggles per host, so you can run multiple Crispies and only have one posting.
- **Rosie tool gating (arbiter)** — new arbiter module governs Rosie Tracker's tool access. Rosie is still experimental, but can no longer go rogue.

## What's New in v0.3.1

Stability fixes and a superthink upgrade.

- **Superthink converge mode** — agents now cross-review each other's findings and produce a unified verdict, not just parallel opinions
- **Fork fix** — fork button now targets the right message (assistant turn before the last user message)
- **Windows compatibility** — fixed crispy-agent failures on native Windows and Git Bash
- **Windows extension paths** — stripped UNC prefix that broke tool paths in VS Code on Windows
- **Singleton guard** — running `crispy` twice no longer spawns duplicate background processes
- **Approval UI fix** — stale approval popups no longer linger after resolution
- **Tauri updater fix** — corrected artifact signature path so auto-updates work reliably

## What's New in v0.3.0

### Multi-tab agent workbench

The Windows native app and standalone browser now work like a full IDE — multiple agent sessions open as tabs you can split, resize, and drag into any arrangement, with a built-in terminal, file browser, and Git panel.

![Multi-tab workbench — split sessions, file browser, terminal, and model selector in the Windows native app](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/multi-tab-workbench.png)

- **Multi-tab sessions** — open multiple Claude/Codex conversations side-by-side in split views
- **Visible agent orchestration** — agents from /superthink surface as live read-only tabs you can watch in real time. No more black-box tool calls

![Superthink visible dispatch — agents open as live tabs you can watch and fork](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/superthink-visual-full-1.gif)

- **Built-in terminal** — integrated terminal docked at the bottom, just like VS Code
- **Dockable side panels** — Files and Git panels dock to left or right borders independently, with persisted layout preference
- **File viewer tabs** — open files as editor-style tabs alongside your sessions, with syntax highlighting and "Execute in Crispy"
- **Auto-reconnect** — the UI recovers automatically from connection drops and re-subscribes to all your sessions

### 10 display styles

![Display styles — Crispy, T3, ChatGPT, Claude.ai, Gemini, Cursor, Copilot, DeepSeek, Perplexity, Terminal](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/crispy-markdown-skins-dark-supercut.gif)

Customize how Crispy looks with 10 display styles (Crispy, T3, ChatGPT, Claude.ai, Gemini, Cursor, Copilot, DeepSeek, Perplexity, Terminal) and 3 badge styles (Frosted, Tinted, Solid).

### Other

- Improved light mode support
- Fork button now works during streaming
- Fixed an issue where the activity database could become corrupted under concurrent access

---

## Capabilities

### Agent recall

![Agent memory — recall searching past sessions with skill and agent badges](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/agent-memory-recall.png)

- Every session indexed locally with full-text and semantic search across all vendors
- Find past decisions, debugging threads, and design discussions — full transcripts, not summaries
- Backfills from your existing Claude Code and Codex transcripts automatically
- Works with Claude Code and Codex transcripts out of the box

### Discord remote

![Crispy Discord bot — live session monitor with tool calls, approvals, and forum-based session management](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/discord.png)

- Live session monitor — browse, open, and manage sessions with full tool-call visibility from Discord
- Inline approval buttons — approve or deny tool use from your phone
- Multi-instance — multiple Crispy instances share one server without conflicts
- Secure by default — fail-closed auth, allowlist access, guided setup wizard

### Multi-agent coordination

- `/superthink` — pit Claude and Codex against each other on the same question. Sub-agents open as live tabs you can watch. Catches bugs and blind spots a single model misses
- `/super-implement` — turn plans into self-contained execution prompts, auto-decomposed if too large
- `/reflect` — verify prompts and plans against the codebase before execution
- `/handoff` — distill context and rotate into a fresh session when context gets long
- `/spec-mode` — interactive spec-building through conversation

### Observability and control

![Tool audit panel — sub-agent badge, expanded tool output with timing and status](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/tool-panel.gif)

- See everything your sub-agents are doing in the tool audit panel — timing, status badges, and nested sub-agent trees
- Sub-agents open as live tabs you can watch and fork — visible orchestration, not black-box tool calls
- Agency modes — plan, auto-accept, `--dangerously-skip-permissions` — one click, persisted per session

### Conversations

![Fork a conversation into a new side-by-side panel](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/fork.gif)

- Fork and rewind at any point — new session opens as a split tab with full context
- Multi-tab workspace — as many agent sessions as you want, arranged however you like
- Session rotation — switch between Claude and Codex mid-conversation without losing context
- Execute prompts in Markdown files with one click from the Explorer or file panel
- Session browser with search and vendor filtering

### UI

![File viewer panel with markdown preview, titlebar with git branch, and file tree](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/file-viewer-panel.png)

- File viewer side panel with word wrap, markdown preview, and quoting
- Git diff panel — staged, modified, and untracked files with syntax-highlighted diffs
- 10 display styles and 3 badge styles — make Crispy look like ChatGPT, Claude.ai, Cursor, or your own thing
- Inline quoting and copy-to-markdown
- Voice input with local VAD and speech-to-text
- Image attachments, @mentions, linkified file paths and URLs
- Light, dark, and high-contrast themes

### Providers

![Model selector showing multiple vendors, and the provider configuration form](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/models.gif)

- Custom model providers — add Anthropic-compatible providers with a custom base URL and model names
- Start a conversation with Claude, continue it in Codex — switch vendors mid-session

### Standalone mode

![Workspace picker — select a project to open in standalone mode](https://raw.githubusercontent.com/TheSylvester/crispy/main/media/workspace-picker.png)

- **Native Windows app (Tauri)** — download the installer, no terminal required. Auto-provisions WSL and the Crispy daemon
- Run `npm i -g crispy-code && crispy` — full UI in your browser, no VS Code required
- Background daemon with `crispy start` / `crispy stop` / `crispy status`
- Workspace picker with URL-based routing for multiple projects
- Multi-tab workbench with split views, dockable panels, and built-in terminal
- Same core features — memory, superthink, fork, rewind

---

## Coming Soon

- Gemini CLI and OpenCode support

---

## Installation

### Windows Desktop App

[Download the installer](https://github.com/TheSylvester/crispy/releases/latest/download/Crispy-windows-x64-setup.exe) — run it and Crispy handles WSL setup and daemon provisioning automatically. The app auto-updates after install.

### Standalone (npm)

```bash
npm i -g crispy-code
crispy
```

Opens Crispy in your browser. No VS Code, no extension install, no config.
Run `crispy start` for a background daemon, `crispy stop` to shut it down.

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

1. `crispy start` runs it as a background daemon
2. Navigate to `http://localhost:3456`, or run `crispy` to open it automatically
3. Start a conversation, or browse existing sessions in the sidebar

### VS Code

1. Open VS Code in any project
2. Run `Crispy: Open` from the command palette (`Ctrl+Shift+Alt+I`)
3. Same UI, embedded in your editor

---

## Requirements

- Node.js 18+ (standalone) or VS Code 1.94+ (extension)
- Claude Code CLI and/or Codex CLI — install whichever vendors you use
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
