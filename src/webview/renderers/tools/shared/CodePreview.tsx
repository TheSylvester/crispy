/**
 * Code Preview — syntax-highlighted code block
 *
 * Reuses prism-react-renderer (already used in markdown-components.tsx)
 * with the vsDark theme. Supports optional line selection for annotation.
 *
 * @module webview/renderers/tools/shared/CodePreview
 */

import { useCallback } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import { useThemeKind, isLightTheme } from '../../../hooks/useThemeKind.js';

/** 1-based inclusive line range */
export interface LineRange {
  start: number;
  end: number;
}

interface CodePreviewProps {
  code: string;
  language?: string;
  maxHeight?: number;
  /** Show line number gutter. Default true. */
  lineNumbers?: boolean;
  /** Enable clickable line selection. Shift-click for ranges. */
  selectable?: boolean;
  /** Currently selected line range (1-based, inclusive). Controlled. */
  selectedLines?: LineRange | null;
  /** Called when the user clicks/shift-clicks a line number. */
  onLineSelect?: (range: LineRange | null) => void;
}

export function CodePreview({
  code,
  language = 'text',
  maxHeight = 400,
  lineNumbers = true,
  selectable = false,
  selectedLines,
  onLineSelect,
}: CodePreviewProps): React.JSX.Element {
  const themeKind = useThemeKind();
  const prismTheme = isLightTheme(themeKind) ? themes.vsLight : themes.vsDark;

  const handleLineClick = useCallback((lineNum: number, shiftKey: boolean) => {
    if (!selectable || !onLineSelect) return;
    if (shiftKey && selectedLines) {
      // Extend selection from existing anchor
      const start = Math.min(selectedLines.start, lineNum);
      const end = Math.max(selectedLines.end, lineNum);
      onLineSelect({ start, end });
    } else {
      // Single line toggle
      if (selectedLines && selectedLines.start === lineNum && selectedLines.end === lineNum) {
        onLineSelect(null);
      } else {
        onLineSelect({ start: lineNum, end: lineNum });
      }
    }
  }, [selectable, onLineSelect, selectedLines]);

  const isLineSelected = (lineNum: number): boolean =>
    !!selectedLines && lineNum >= selectedLines.start && lineNum <= selectedLines.end;

  return (
    <div className="crispy-code-preview" style={{ maxHeight }}>
      <Highlight theme={prismTheme} code={code} language={language}>
        {({ tokens, getLineProps, getTokenProps, style }) => (
          <pre style={{ ...style, background: 'transparent', margin: 0, padding: '8px 10px', fontSize: '12px', lineHeight: 1.5 }}>
            {tokens.map((line, i) => {
              const lineNum = i + 1;
              const lineProps = getLineProps({ line, key: i });
              const selected = selectable && isLineSelected(lineNum);
              return (
                <span
                  key={i}
                  {...lineProps}
                  className={selected ? 'crispy-code-line--selected' : undefined}
                >
                  {lineNumbers && (
                    <span
                      className={selectable ? 'crispy-code-line-number--selectable' : undefined}
                      style={{ color: 'var(--tint-strong)', display: 'inline-block', width: '3em', textAlign: 'right', marginRight: '1em', userSelect: 'none' }}
                      onClick={selectable ? (e) => handleLineClick(lineNum, e.shiftKey) : undefined}
                    >
                      {lineNum}
                    </span>
                  )}
                  {line.map((token, j) => (
                    <span key={j} {...getTokenProps({ token, key: j })} />
                  ))}
                  {'\n'}
                </span>
              );
            })}
          </pre>
        )}
      </Highlight>
    </div>
  );
}
