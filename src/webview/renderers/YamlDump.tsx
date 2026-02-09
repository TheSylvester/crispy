/**
 * Recursive YAML Dump — shared JSX component for YAML-like data display
 *
 * Extracted from YamlEntry.tsx for reuse by BlockRenderer (YAML-default
 * rendering) and any future component that needs structured data display.
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
 *
 * @module webview/renderers/YamlDump
 */

/**
 * Recursively converts a value to YAML-like formatted JSX.
 *
 * React handles HTML escaping automatically — no manual escapeHtml needed.
 */
export function YamlDump({ value, indent = 0 }: { value: unknown; indent?: number }): React.JSX.Element {
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
