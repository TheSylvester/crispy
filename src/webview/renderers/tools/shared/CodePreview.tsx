/**
 * Code Preview — syntax-highlighted code block
 *
 * Reuses prism-react-renderer (already used in markdown-components.tsx)
 * with the vsDark theme.
 *
 * @module webview/renderers/tools/shared/CodePreview
 */

import { useEffect, useRef } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import { useThemeKind, isLightTheme } from '../../../hooks/useThemeKind.js';

interface CodePreviewProps {
  code: string;
  language?: string;
  maxHeight?: number;
  /** Show line number gutter. Default true. */
  lineNumbers?: boolean;
  /** 1-based line number to scroll to and highlight on mount. */
  targetLine?: number;
  /** Enable word wrapping. Default false. */
  wordWrap?: boolean;
}

export function CodePreview({
  code,
  language = 'text',
  maxHeight = 400,
  lineNumbers = true,
  targetLine,
  wordWrap = false,
}: CodePreviewProps): React.JSX.Element {
  const themeKind = useThemeKind();
  const prismTheme = isLightTheme(themeKind) ? themes.vsLight : themes.vsDark;
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll to target line after render
  useEffect(() => {
    if (!targetLine || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-line-number="${targetLine}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [targetLine]);

  return (
    <div className="crispy-code-preview" style={{ maxHeight }} ref={containerRef}>
      <Highlight theme={prismTheme} code={code} language={language}>
        {({ tokens, getLineProps, getTokenProps, style }) => (
          <pre style={{ ...style, background: 'transparent', margin: 0, padding: '8px 10px', fontSize: '12px', lineHeight: 1.5, ...(wordWrap ? { whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflowX: 'hidden' as const } : {}) }}>
            {tokens.map((line, i) => {
              const lineNum = i + 1;
              const lineProps = getLineProps({ line, key: i });
              const isTarget = targetLine === lineNum;
              return (
                <span
                  key={i}
                  {...lineProps}
                  data-line-number={lineNum}
                  className={isTarget ? 'crispy-code-preview__target-line' : undefined}
                >
                  {lineNumbers && (
                    <span style={{ color: 'var(--tint-strong)', display: 'inline-block', width: '3em', textAlign: 'right', marginRight: '1em', userSelect: 'none' }}>
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
