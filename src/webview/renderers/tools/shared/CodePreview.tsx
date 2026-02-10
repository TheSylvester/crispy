/**
 * Code Preview — syntax-highlighted code block
 *
 * Reuses prism-react-renderer (already used in markdown-components.tsx)
 * with the vsDark theme.
 *
 * @module webview/renderers/tools/shared/CodePreview
 */

import { Highlight, themes } from 'prism-react-renderer';

interface CodePreviewProps {
  code: string;
  language?: string;
  maxHeight?: number;
}

export function CodePreview({ code, language = 'text', maxHeight = 400 }: CodePreviewProps): React.JSX.Element {
  return (
    <div className="crispy-code-preview" style={{ maxHeight, overflowY: 'auto' }}>
      <Highlight theme={themes.vsDark} code={code} language={language}>
        {({ tokens, getLineProps, getTokenProps, style }) => (
          <pre style={{ ...style, background: 'transparent', margin: 0, padding: '8px 10px', fontSize: '12px', lineHeight: 1.5 }}>
            {tokens.map((line, i) => {
              const lineProps = getLineProps({ line, key: i });
              return (
                <span key={i} {...lineProps}>
                  <span style={{ color: 'rgba(255,255,255,0.25)', display: 'inline-block', width: '3em', textAlign: 'right', marginRight: '1em', userSelect: 'none' }}>
                    {i + 1}
                  </span>
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
