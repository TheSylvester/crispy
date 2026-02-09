# Crispy

Clean-room rewrite of [Leto](../leto/) — a VS Code extension that unifies
cross-vendor AI coding agents (Claude Code, Codex, Gemini, OpenCode) behind a
single UI. Not just a viewer — interactive chat, session history, vendor
delegation, transcript-as-data.

## Architecture

Universal transcript types (`src/core/transcript.ts`) are the foundation.
Every vendor has an adapter under `src/core/adapters/<vendor>/` that converts
raw transcript formats into `TranscriptEntry`.

```
src/core/
├── transcript.ts                  ← Universal types (the contract)
├── agent-adapter.ts               ← AgentAdapter interface + ChannelMessage types
├── channel-events.ts              ← Status & notification event types
├── async-iterable-queue.ts        ← Async queue (bridges input/output streams)
└── adapters/
    └── claude/
        ├── jsonl-reader.ts        ← Claude JSONL parsing + session discovery
        ├── claude-entry-adapter.ts ← Raw JSONL → TranscriptEntry
        └── claude-code-adapter.ts ← ClaudeAgentAdapter (SDK + history/discovery)
```

## Key rules

- **`transcript.ts` is vendor-agnostic.** Don't add vendor-specific fields.
  Use the `metadata` bag for vendor extensions. Read the format specs in
  `.ai-reference/reference/` before changing universal types.
- **Adapter exports are prefixed** with vendor name (`ClaudeAgentAdapter`,
  `adaptClaudeEntry`) to avoid confusion with universal types.
- **Claude Code's app version is the de facto schema version.** Test fixtures
  in `test/fixtures/claude/` are keyed by version. `npm test` runs the
  pipeline against a real transcript via `scripts/check-claude-fixture.sh`.

## Commands

- `npm run typecheck` — strict TypeScript check
- `npm test` — end-to-end pipeline test (finds richest local transcript)
- `npm run test:unit` — vitest unit tests only

## Reference files (`.ai-reference/`, not committed)

### Format specs (`reference/`)

- `claude-jsonl-format.md` — Claude Code JSONL transcript format
- `codex-jsonl-format.md` — Codex CLI JSONL transcript format
- `gemini-json-format.md` — Gemini CLI JSON transcript format
- `agent-sdk-typescript-CLAUDE.md` — Claude Agent SDK TypeScript docs

### Leto source (`leto-source/`) — predecessor patterns to reference

- `core/adapters/claude-entry-adapter.ts` — original Claude adapter
- `core/adapters/claude-connector.ts` — SDK live session connection
- `core/adapters/claude-loader.ts` — disk history loading
- `core/adapters/claude.ts` — ClaudeAgentAdapter (wraps connector + loader)
- `core/session-channel.ts` — session multiplexer (1 adapter → N subscribers)
- `core/agent-adapter.ts` — vendor-agnostic adapter interface
- `core/agent-session.ts` — vendor type definitions
- `core/types.ts` — permission types, SDK re-exports

## Skills (`.claude/skills/`)

- **Add Git Worktree** (`add-worktree/`) — Creates an isolated worktree at
  `../crispy-<branch>` with `.ai-reference/` symlinked from the main repo.
  Use when starting parallel feature work. Run:
  `${SKILL_ROOT}/scripts/add-worktree.sh <branch-name>`

### Reference Repos

- `/home/silver/dev/leto/` - Repo for the original Leto extension, contains the strangler's fig of the never completed 'webview-next' that never completed
