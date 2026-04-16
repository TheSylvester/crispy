/**
 * Canonical Input Normalizer — Vendor-polymorphic input → matchable strings
 *
 * Extracts matchable strings from vendor-polymorphic tool call inputs.
 * Knows about input shapes (Claude, Codex, OpenCode) but imports nothing
 * from adapters or vendors. Pure function: input object in, strings out.
 *
 * @module core/arbiter/normalize-input
 */

/** Matches Codex bash wrapper: `/bin/bash -lc "actual command"` */
const CODEX_BASH_WRAPPER = /^\/bin\/bash\s+-lc\s+["'](.+)["']$/;

/**
 * Extract matchable strings from a tool call's input.
 *
 * Returns an array because some tools operate on multiple targets
 * (e.g., Codex Edit with a `changes` map touching multiple files).
 *
 * Empty array means the tool has no matchable input — only tool name
 * matching applies (e.g., Agent tool in v1).
 */
export function normalizeMatchTarget(toolName: string, input: unknown): string[] {
  if (input == null || typeof input !== 'object') return [];
  if (Array.isArray(input)) return [];

  const obj = input as Record<string, unknown>;

  switch (toolName) {
    case 'Bash': {
      let cmd = (obj.command as string) ?? '';
      const codexMatch = cmd.match(CODEX_BASH_WRAPPER);
      if (codexMatch) cmd = codexMatch[1]!;
      return cmd ? [cmd] : [];
    }

    case 'Read':
    case 'Write':
      return obj.file_path ? [obj.file_path as string] : [];

    case 'Edit': {
      if (obj.file_path) return [obj.file_path as string];
      // Codex Edit uses a `changes` map keyed by file path
      if (obj.changes && typeof obj.changes === 'object') {
        return Object.keys(obj.changes as Record<string, unknown>);
      }
      return [];
    }

    case 'Glob':
    case 'Grep':
      return obj.pattern ? [obj.pattern as string] : [];

    case 'WebFetch':
      return obj.url ? [obj.url as string] : [];

    case 'Agent':
      return [];

    default: {
      // OpenCode and unknown vendors: check metadata.path, then pattern
      const meta = obj.metadata as Record<string, unknown> | undefined;
      if (meta?.path) return [meta.path as string];
      if (obj.pattern) return [obj.pattern as string];
      return [];
    }
  }
}
