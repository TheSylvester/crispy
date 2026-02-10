/**
 * Diff View — inline diff display for Edit tool
 *
 * Simple line-by-line diff without external library.
 * Shows removed lines in red and added lines in green.
 *
 * @module webview/renderers/tools/shared/DiffView
 */

interface DiffViewProps {
  oldText: string;
  newText: string;
  maxHeight?: number;
}

interface DiffLine {
  type: 'context' | 'added' | 'removed';
  text: string;
}

/**
 * Generate a simple diff between two strings.
 * Shows all removed lines first, then all added lines.
 * For the Edit tool's old_string/new_string this is the natural display.
 */
function computeDiff(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const lines: DiffLine[] = [];

  // Find common prefix
  let prefixLen = 0;
  while (prefixLen < oldLines.length && prefixLen < newLines.length && oldLines[prefixLen] === newLines[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix
  let suffixLen = 0;
  while (
    suffixLen < oldLines.length - prefixLen &&
    suffixLen < newLines.length - prefixLen &&
    oldLines[oldLines.length - 1 - suffixLen] === newLines[newLines.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // Common prefix lines
  for (let i = 0; i < prefixLen; i++) {
    lines.push({ type: 'context', text: oldLines[i] });
  }

  // Removed lines (middle section of old)
  for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
    lines.push({ type: 'removed', text: oldLines[i] });
  }

  // Added lines (middle section of new)
  for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
    lines.push({ type: 'added', text: newLines[i] });
  }

  // Common suffix lines
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
    lines.push({ type: 'context', text: oldLines[i] });
  }

  return lines;
}

const LINE_COLORS: Record<string, { bg: string; prefix: string }> = {
  added:   { bg: 'rgba(46, 160, 67, 0.15)', prefix: '+' },
  removed: { bg: 'rgba(248, 81, 73, 0.15)', prefix: '-' },
  context: { bg: 'transparent', prefix: ' ' },
};

export function DiffView({ oldText, newText, maxHeight = 400 }: DiffViewProps): React.JSX.Element {
  const lines = computeDiff(oldText, newText);

  return (
    <div className="crispy-diff" style={{ maxHeight, overflowY: 'auto' }}>
      <pre style={{ margin: 0, padding: '8px 10px', fontSize: '12px', lineHeight: 1.5 }}>
        {lines.map((line, i) => {
          const { bg, prefix } = LINE_COLORS[line.type] ?? LINE_COLORS.context;
          return (
            <div key={i} className={`crispy-diff-${line.type}`} style={{ background: bg }}>
              <span style={{ color: 'rgba(255,255,255,0.35)', display: 'inline-block', width: '1.5em', userSelect: 'none' }}>
                {prefix}
              </span>
              {line.text}
            </div>
          );
        })}
      </pre>
    </div>
  );
}
