---
paths:
  - "src/core/rosie/**"
  - "src/mcp/servers/external.ts"
---

# Rosie — Background Intelligence Layer

Rosie is Crispy's background agent system. Each Rosie function runs as an
ephemeral child session dispatched via `AgentDispatch.dispatchChild()`.

## Conventions

### Shared model setting

All Rosie functions read the same model from `rosie.summarize.model` in
settings (format: `"vendor:model"`, e.g. `"claude:haiku"`,
`"my-provider:glm-4.7"`). When adding a new Rosie function:

1. Read the model via `getSettingsSnapshotInternal().settings.rosie.summarize.model`
   (or accept it as a callback if you're outside `src/core/`)
2. Parse with `parseModelOption()` from `core/model-utils.ts` — returns
   `{ vendor, model }`
3. Pass `vendor` and `model` to `dispatchChild()` options
4. Default to `'haiku'` if the setting is undefined

The UI exposes this as a single "Model" dropdown under the "Rosie" section
in Settings. Don't hardcode model names.

### Feature toggles

Each Rosie function has an on/off toggle in the Settings UI under "Rosie":
- **Summarize** — `rosie.summarize.enabled` in settings
- **Recall** — `mcp.memory.{vscode|devServer}` in settings (controls whether
  the recall MCP server is attached to sessions)

When adding a new function, add a corresponding toggle.

### Architecture

- Functions in `src/core/rosie/` handle core-side hooks (e.g. summarize
  triggers on session idle)
- The recall system lives in `src/mcp/servers/external.ts` because it's an
  MCP tool, not a lifecycle hook — but it follows the same Rosie conventions
- Child sessions use `skipPersistSession: true` and `autoClose: true`
- Guard against re-entry with an inflight set (see `summarize-hook.ts`)

### Adding a new Rosie function

1. Create the hook/handler following existing patterns
2. Read model from the shared Rosie model setting (don't hardcode)
3. Add a toggle in the Settings UI under the "Rosie" section
4. Export from `src/core/rosie/index.ts` if it's a lifecycle hook
5. Update this file
