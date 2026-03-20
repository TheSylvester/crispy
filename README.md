# Crispy

**A zero-compromise UI for Claude Code, Codex, and more — with controls you can't get in a terminal.**

Rendered Markdown. Fork and rewind conversations. Multiple agent windows side by side. Audit tool calls and sub-agent work in a dedicated panel. One-click bypass, Chrome, models, and permissions. Execute Markdown files directly as prompts.

VS Code / Cursor extension.

[![Version](https://img.shields.io/open-vsx/v/the-sylvester/crispy?label=OpenVSX&color=blue)](https://open-vsx.org/extension/the-sylvester/crispy)
[![Downloads](https://img.shields.io/open-vsx/dt/the-sylvester/crispy?color=green)](https://open-vsx.org/extension/the-sylvester/crispy)
[![License](https://img.shields.io/github/license/TheSylvester/crispy)](LICENSE)
[![Discord](https://img.shields.io/discord/1483243664389177479?color=5865F2&logo=discord&logoColor=white&label=Discord)](https://discord.gg/e2vw4bTPup)

![Crispy — sub-agent running with real-time tool auditing, then forking to side-by-side panels](./media/hero.gif)

---

## What's New in v0.2.0

### Agent memory

Every session is indexed locally with full-text and semantic search. Your
agent can find past decisions, debugging threads, and design discussions
across Claude Code, Codex, and OpenCode — and read the full conversation
back. Not summaries. Not rules files. The actual transcripts already saved
on your machine. No cloud, no API calls, no expiry.

<!-- TODO: ![Recall finding a past session](./media/recall.gif) -->

### Icons render mode (new default)

The new default look. Minor tool calls are collapsed to inline icons that
flow with the conversation — click any icon to open the full detail in the
side panel. Keeps the focus on the conversation, not the tool calls.

<!-- TODO: ![Icons mode with inline tool flow](./media/icons-mode.gif) -->

### Voice input

Click-to-record voice input with local VAD and speech-to-text. Your speech
is transcribed locally and inserted into the chat input. Requires a
microphone.

<!-- TODO: ![Voice input transcription](./media/voice.gif) -->

### Inline quoting

Select text in any assistant response to quote it into your next message
with your own commentary. No more copy-pasting to reference something the
agent said.

### Copy-to-markdown

One-click copy buttons on assistant messages and tool output cards. Copies
clean, formatted Markdown to your clipboard.

### Multi-agent collaboration

Resumable Claude and Codex agents working together in back-and-forth
discussions directed by your coding agent of choice. Your agent dispatches
child sessions across vendors, gets parallel perspectives, and picks up
where it left off. No external MCP servers or configuration required.

### Project tracker (Experimental)

An AI-powered project tracker that watches your sessions and automatically
classifies what you're working on, what stage it's in, and what changed. View
tracked projects in a dedicated sidebar with stage-based grouping. Off by
default — enable in Settings.

<!-- TODO: ![Projects view with stage grouping](./media/projects.gif) -->

---

## Why Crispy?

The official Claude Code VS Code extension is good. But it ships a subset of
what the TUI can do, and it locks you into one vendor. Crispy fills the gaps.

---

## Feature Highlights

### Fork and rewind conversations

![Fork a conversation into a new side-by-side panel](./media/fork.gif)

Fork at any point in a conversation. The new session opens in a second panel
with full context — branch into parallel explorations or try a different
approach.

### Execute Markdown files as agent prompts

![Right-click a Markdown file to execute it in Crispy](./media/execute.gif)

Right-click any `.md` file in the Explorer and select **Execute in Crispy**.
Your prompt loads into a new session, ready to send — the agent starts
immediately.

### Session browser with search and filtering

![Session browser — vendor filtering, search, chronological grouping](./media/sessions.gif)

Browse every session across vendors in one place. Filter by Claude or Codex,
search by title, and jump between conversations grouped by day.

### Four rendering modes

![Switch between Blocks, YAML, Compact, and Icons views on the same conversation](./media/rendering-modes.gif)

**Blocks** for daily use with rich tool cards, **Icons** for skimming with
inline tool icons, **Compact** for dense transcripts, **YAML** for raw
observability. Switch instantly on the same conversation.

### Four agency modes

![Cycle through agency modes — plan, ask, accept, bypass](./media/permission-modes.gif)

One click to cycle between **plan**, **ask before edits**, **auto-accept**, and
**bypass**. Each mode has a distinct border color and icon so you always know
the agent's leash. Your default mode persists across sessions.

### Models and custom providers

![Model selector showing multiple vendors, and the provider configuration form](./media/models.gif)

Switch between Claude and Codex, or add custom Claude-compatible providers
with their own base URLs, API keys, and model mappings.

---

## Features

- Fork and rewind conversations
- Side-by-side agent windows — as many as your editor can tile
- Dedicated tool panel for auditing tool calls and sub-agent work
- Cross-session recall with full-text and semantic search
- Inline quoting — select text to quote into your next message
- Copy-to-markdown for messages and tool output
- One-click bypass mode and Chrome toggle
- Execute Markdown files as prompts from the Explorer
- Claude and Codex adapters today — Gemini CLI and OpenCode next
- Custom model providers — route Claude through any Claude-compatible endpoint
  (GLM-4.7, DeepSeek, local models)
- Four rendering modes — Blocks, Icons, Compact, YAML
- Agency modes — plan, auto-accept, ask-before-edits, bypass (persisted)
- Session browser with search and vendor filtering
- Voice input with local VAD and speech-to-text
- Image attachments, @mentions, linkified file paths and URLs
- Structured log stream for debugging
- Light, dark, and high-contrast themes
- **Experimental:** Project tracker — AI-powered project classification (off by default)
- **Experimental (insecure):** Browser mode at `localhost:3456`

---

## Coming Soon

- Gemini CLI and OpenCode adapters
- Standalone browser app

---

## Installation

### Option 1: OpenVSX Marketplace

Search for **"Crispy"** in the VS Code extensions panel and install it
directly.

### Option 2: CLI

```bash
code --install-extension the-sylvester.crispy
```

Or download the `.vsix` file from the
[OpenVSX Marketplace](https://open-vsx.org/extension/the-sylvester/crispy) and
install manually via **Extensions > Install from VSIX**.

### Option 3: From Source

```bash
git clone https://github.com/TheSylvester/crispy.git
cd crispy
npm install
npm run build
```

Then press `F5` in VS Code to launch the extension development host.

To build a target-specific VSIX that only includes the matching native voice
runtime, use one of:

```bash
npm run package:linux-x64
npm run package:linux-arm64
npm run package:darwin-x64
npm run package:darwin-arm64
npm run package:win32-x64
npm run package:win32-arm64
```

---

## Usage

1. Open VS Code in a project that has Claude Code or Codex sessions
2. Run `Crispy: Open` from the command palette (`Ctrl+Shift+Alt+I`)
3. Browse sessions in the sidebar, or start a new conversation
4. Use the control panel at the bottom for chat input, model selection, and
   agency mode toggles

---

## Requirements

- VS Code 1.94+ (or any compatible fork)
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
