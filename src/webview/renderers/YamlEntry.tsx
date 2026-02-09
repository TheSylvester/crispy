/**
 * YAML Entry Renderer — recursive YAML-like dump for data inspection
 *
 * Renders the entire TranscriptEntry object as indented YAML with colored
 * keys. Ported from Leto's `webview-next/renderer/yaml-renderer.ts`,
 * adapted from HTML string returns to React JSX.
 *
 * React handles HTML escaping automatically — no manual escapeHtml needed.
 *
 * @module webview/renderers/YamlEntry
 */

import type { TranscriptEntry } from '../../core/transcript.js';

// ============================================================================
// Recursive YAML Dump — returns JSX fragments
// ============================================================================

/**
 * Recursively converts a value to YAML-like formatted JSX.
 *
 * Preserves Leto's formatting rules:
 * - null/undefined → "null"
 * - string (single-line, no special chars) → the string itself
 * - string (contains : # or starts with space/') → "quoted"
 * - string (multi-line) → |\n  line1\n  line2
 * - number/boolean → toString
 * - array (empty) → []
 * - array → - item (each recursively rendered, indented)
 * - object (empty) → {}
 * - object → key: value (key in colored span, complex values on next line)
 */
function YamlDump({ value, indent = 0 }: { value: unknown; indent?: number }): React.JSX.Element {
  const pad = '  '.repeat(indent);

  if (value === null || value === undefined) {
    return <>{pad}null</>;
  }

  if (typeof value === 'string') {
    // Multi-line strings
    if (value.includes('\n')) {
      const lines = value.split('\n').map((line) => `${pad}  ${line}`).join('\n');
      return <>{pad}|{'\n'}{lines}</>;
    }
    // Quote if contains special chars
    if (value.includes(':') || value.includes('#') || value.startsWith(' ') || value.startsWith("'")) {
      return <>{pad}&quot;{value.replace(/"/g, '\\"')}&quot;</>;
    }
    return <>{pad}{value}</>;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return <>{pad}{String(value)}</>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <>{pad}[]</>;
    return (
      <>
        {value.map((item, i) => (
          <span key={i}>
            {i > 0 && '\n'}
            {pad}- <YamlDump value={item} indent={indent + 1} />
          </span>
        ))}
      </>
    );
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return <>{pad}{'{}'}</>;
    return (
      <>
        {entries.map(([key, val], i) => {
          const isComplex = val !== null && typeof val === 'object';
          return (
            <span key={key}>
              {i > 0 && '\n'}
              {pad}<span className="yaml-key">{key}</span>:
              {isComplex ? (
                <>
                  {'\n'}<YamlDump value={val} indent={indent + 1} />
                </>
              ) : (
                <> <YamlDump value={val} indent={0} /></>
              )}
            </span>
          );
        })}
      </>
    );
  }

  return <>{pad}{String(value)}</>;
}

// ============================================================================
// YAML Entry Wrapper
// ============================================================================

interface YamlEntryProps {
  entry: TranscriptEntry;
}

/**
 * Renders a transcript entry as a YAML-like structured dump.
 * Shows the complete entry object for debugging and data inspection.
 */
export function YamlEntry({ entry }: YamlEntryProps): React.JSX.Element {
  const role = entry.message?.role ?? entry.type;

  return (
    <div className={`message ${role} yaml-entry`} data-uuid={entry.uuid}>
      <pre className="yaml-dump">
        <YamlDump value={entry} />
      </pre>
    </div>
  );
}
