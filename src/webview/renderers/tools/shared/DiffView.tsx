/**
 * Diff View — syntax-highlighted diff display for Edit tool
 *
 * Two modes: unified (inline) and split (side-by-side).
 * Both use prism-react-renderer for language-aware token coloring.
 * Line numbers are shown in dual gutters (old/new) for unified,
 * single gutter per pane for split.
 *
 * @module webview/renderers/tools/shared/DiffView
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { Highlight, themes, type Token } from 'prism-react-renderer';

// Re-export for backwards compatibility
export { inferLanguage } from './tool-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DiffViewProps {
  oldText: string;
  newText: string;
  language?: string;
  maxHeight?: number;
  /** 1-based line number where the edit starts in the original file. Defaults to 1. */
  startLine?: number;
}

interface DiffLine {
  type: 'context' | 'added' | 'removed';
  text: string;
}

/** Augmented diff line with dual line numbers for unified view. */
interface NumberedDiffLine extends DiffLine {
  oldLineNo: number | null;
  newLineNo: number | null;
}

/** Side-by-side row: one or both sides may be null. */
interface DiffPair {
  left:  { lineNo: number; text: string; type: 'context' | 'removed' } | null;
  right: { lineNo: number; text: string; type: 'context' | 'added' } | null;
}


// ---------------------------------------------------------------------------
// Diff algorithms
// ---------------------------------------------------------------------------

/**
 * Compute a unified diff with line numbers.
 * Prefix/suffix matching, then removed lines followed by added lines.
 *
 * @param startLine - 1-based line number offset for the edit location in the file
 */
function computeUnifiedDiff(oldText: string, newText: string, startLine = 1): NumberedDiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const result: NumberedDiffLine[] = [];

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

  let oldNo = startLine;
  let newNo = startLine;

  // Common prefix
  for (let i = 0; i < prefixLen; i++) {
    result.push({ type: 'context', text: oldLines[i], oldLineNo: oldNo++, newLineNo: newNo++ });
  }

  // Removed lines
  for (let i = prefixLen; i < oldLines.length - suffixLen; i++) {
    result.push({ type: 'removed', text: oldLines[i], oldLineNo: oldNo++, newLineNo: null });
  }

  // Added lines
  for (let i = prefixLen; i < newLines.length - suffixLen; i++) {
    result.push({ type: 'added', text: newLines[i], oldLineNo: null, newLineNo: newNo++ });
  }

  // Common suffix
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
    result.push({ type: 'context', text: oldLines[i], oldLineNo: oldNo++, newLineNo: newNo++ });
  }

  return result;
}

/**
 * Compute side-by-side diff pairs with interleaved removed/added rows.
 * Context lines appear on both sides. Removed[i] pairs with added[i].
 *
 * @param startLine - 1-based line number offset for the edit location in the file
 */
function computeDiffPairs(oldText: string, newText: string, startLine = 1): DiffPair[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const pairs: DiffPair[] = [];

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

  let oldNo = startLine;
  let newNo = startLine;

  // Common prefix
  for (let i = 0; i < prefixLen; i++) {
    pairs.push({
      left:  { lineNo: oldNo++, text: oldLines[i], type: 'context' },
      right: { lineNo: newNo++, text: newLines[i], type: 'context' },
    });
  }

  // Changed region — interleave removed/added
  const removedStart = prefixLen;
  const removedEnd = oldLines.length - suffixLen;
  const addedStart = prefixLen;
  const addedEnd = newLines.length - suffixLen;
  const removedCount = removedEnd - removedStart;
  const addedCount = addedEnd - addedStart;
  const maxChanged = Math.max(removedCount, addedCount);

  for (let i = 0; i < maxChanged; i++) {
    const left = i < removedCount
      ? { lineNo: oldNo++, text: oldLines[removedStart + i], type: 'removed' as const }
      : null;
    const right = i < addedCount
      ? { lineNo: newNo++, text: newLines[addedStart + i], type: 'added' as const }
      : null;
    pairs.push({ left, right });
  }

  // Common suffix
  for (let i = oldLines.length - suffixLen; i < oldLines.length; i++) {
    const ni = i - (oldLines.length - suffixLen);
    pairs.push({
      left:  { lineNo: oldNo++, text: oldLines[i], type: 'context' },
      right: { lineNo: newNo++, text: newLines[newLines.length - suffixLen + ni], type: 'context' },
    });
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Style constants
// ---------------------------------------------------------------------------

const LINE_BG: Record<string, string> = {
  added:   'rgba(46, 160, 67, 0.15)',
  removed: 'rgba(248, 81, 73, 0.15)',
  context: 'transparent',
};

const LINE_PREFIX: Record<string, string> = {
  added: '+',
  removed: '-',
  context: ' ',
};

// ---------------------------------------------------------------------------
// UnifiedDiff — inline view with dual line-number gutters
// ---------------------------------------------------------------------------

interface UnifiedDiffProps {
  oldText: string;
  newText: string;
  language: string;
  maxHeight: number;
  startLine: number;
}

function UnifiedDiff({ oldText, newText, language, maxHeight, startLine }: UnifiedDiffProps) {
  const diffLines = computeUnifiedDiff(oldText, newText, startLine);
  const fullText = diffLines.map((l) => l.text).join('\n');

  return (
    <Highlight theme={themes.vsDark} code={fullText} language={language}>
      {({ tokens, getLineProps, getTokenProps }) => (
        <div className="crispy-diff-scroll" style={{ maxHeight, overflowY: 'auto' }}>
          <pre className="crispy-diff-pre">
            {tokens.map((tokenLine, i) => {
              const diff = diffLines[i];
              if (!diff) return null;
              const bg = LINE_BG[diff.type] ?? LINE_BG.context;
              const prefix = LINE_PREFIX[diff.type] ?? ' ';
              const lineProps = getLineProps({ line: tokenLine, key: i });

              return (
                <div
                  key={i}
                  {...lineProps}
                  className={`crispy-diff-${diff.type}`}
                  style={{ ...lineProps.style, background: bg, display: 'flex' }}
                >
                  <span className="crispy-diff-gutter">
                    {diff.oldLineNo ?? ' '}
                  </span>
                  <span className="crispy-diff-gutter">
                    {diff.newLineNo ?? ' '}
                  </span>
                  <span className="crispy-diff-prefix">
                    {prefix}
                  </span>
                  <span className="crispy-diff-code">
                    {tokenLine.map((token, j) => (
                      <span key={j} {...getTokenProps({ token, key: j })} />
                    ))}
                  </span>
                </div>
              );
            })}
          </pre>
        </div>
      )}
    </Highlight>
  );
}

// ---------------------------------------------------------------------------
// SplitDiff — side-by-side view with CSS Grid
// ---------------------------------------------------------------------------

interface SplitDiffProps {
  oldText: string;
  newText: string;
  language: string;
  maxHeight: number;
  startLine: number;
}

function SplitDiff({ oldText, newText, language, maxHeight, startLine }: SplitDiffProps) {
  const pairs = computeDiffPairs(oldText, newText, startLine);

  // Build full source for each side so Prism tokenizes with correct multi-line state
  const leftLines = oldText.split('\n');
  const rightLines = newText.split('\n');
  const leftCode = leftLines.join('\n');
  const rightCode = rightLines.join('\n');

  return (
    <Highlight theme={themes.vsDark} code={leftCode} language={language}>
      {({ tokens: leftTokens, getTokenProps: getLeftTokenProps }) => (
        <Highlight theme={themes.vsDark} code={rightCode} language={language}>
          {({ tokens: rightTokens, getTokenProps: getRightTokenProps }) => (
            <SplitDiffGrid
              pairs={pairs}
              leftTokens={leftTokens}
              rightTokens={rightTokens}
              getLeftTokenProps={getLeftTokenProps}
              getRightTokenProps={getRightTokenProps}
              maxHeight={maxHeight}
              startLine={startLine}
            />
          )}
        </Highlight>
      )}
    </Highlight>
  );
}

interface SplitDiffGridProps {
  pairs: DiffPair[];
  leftTokens: Token[][];
  rightTokens: Token[][];
  getLeftTokenProps: (input: { token: Token; key: number }) => Record<string, unknown>;
  getRightTokenProps: (input: { token: Token; key: number }) => Record<string, unknown>;
  maxHeight: number;
  startLine: number;
}

function SplitDiffGrid({
  pairs, leftTokens, rightTokens,
  getLeftTokenProps, getRightTokenProps,
  maxHeight, startLine,
}: SplitDiffGridProps) {
  return (
    <div className="crispy-diff-scroll" style={{ maxHeight, overflowY: 'auto' }}>
      <pre className="crispy-diff-pre">
        <div className="crispy-diff-split">
          {/* Left pane — scrolls independently */}
          <div className="crispy-diff-split-pane crispy-diff-split-left">
            {pairs.map((pair, i) => {
              const leftIdx = pair.left ? pair.left.lineNo - startLine : -1;
              const leftToks = leftIdx >= 0 && leftIdx < leftTokens.length ? leftTokens[leftIdx] : null;

              return (
                <div
                  key={i}
                  className={`crispy-diff-split-row ${pair.left ? `crispy-diff-${pair.left.type}` : 'crispy-diff-split-empty'}`}
                >
                  <span className="crispy-diff-gutter">
                    {pair.left?.lineNo ?? ' '}
                  </span>
                  <span className="crispy-diff-code">
                    {leftToks
                      ? leftToks.map((token, j) => {
                          const props = getLeftTokenProps({ token, key: j });
                          return <span key={j} {...props} />;
                        })
                      : '\u00A0'}
                  </span>
                </div>
              );
            })}
          </div>
          {/* Right pane — scrolls independently */}
          <div className="crispy-diff-split-pane">
            {pairs.map((pair, i) => {
              const rightIdx = pair.right ? pair.right.lineNo - startLine : -1;
              const rightToks = rightIdx >= 0 && rightIdx < rightTokens.length ? rightTokens[rightIdx] : null;

              return (
                <div
                  key={i}
                  className={`crispy-diff-split-row ${pair.right ? `crispy-diff-${pair.right.type}` : 'crispy-diff-split-empty'}`}
                >
                  <span className="crispy-diff-gutter">
                    {pair.right?.lineNo ?? ' '}
                  </span>
                  <span className="crispy-diff-code">
                    {rightToks
                      ? rightToks.map((token, j) => {
                          const props = getRightTokenProps({ token, key: j });
                          return <span key={j} {...props} />;
                        })
                      : '\u00A0'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </pre>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffView — public component
// ---------------------------------------------------------------------------

export function DiffView({ oldText, newText, language = 'text', maxHeight = 400, startLine = 1 }: DiffViewProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooNarrow, setTooNarrow] = useState(false);

  // Responsive: force unified below 380px (each split pane needs ~190px min).
  // At 450px tool-panel width the diff container is ~398px after padding,
  // so 380px keeps split diffs usable at the minimum panel size.
  const checkWidth = useCallback(() => {
    if (!containerRef.current) return;
    setTooNarrow(containerRef.current.offsetWidth < 380);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    checkWidth();
    const observer = new ResizeObserver(checkWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkWidth]);

  return (
    <div className="crispy-diff" ref={containerRef}>
      {tooNarrow
        ? <UnifiedDiff oldText={oldText} newText={newText} language={language} maxHeight={maxHeight} startLine={startLine} />
        : <SplitDiff oldText={oldText} newText={newText} language={language} maxHeight={maxHeight} startLine={startLine} />}
    </div>
  );
}
