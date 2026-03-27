/**
 * GitDiffView — hunk-native diff renderer with Prism syntax highlighting
 *
 * Consumes pre-parsed Hunk[] directly from the git diff parser.
 * Does NOT re-diff text — renders git's own hunk boundaries faithfully.
 * Reuses the same CSS classes as DiffView for visual consistency.
 *
 * @module git-panel/GitDiffView
 */

import { memo, useMemo } from 'react';
import { Highlight, themes } from 'prism-react-renderer';
import { useThemeKind, isLightTheme } from '../../hooks/useThemeKind.js';
import type { Hunk } from '../../../core/git-diff-parser.js';

interface GitDiffViewProps {
  hunks: Hunk[];
  language: string;
}

const LINE_PREFIX: Record<string, string> = {
  added: '+',
  removed: '-',
  context: ' ',
};

export const GitDiffView = memo(function GitDiffView({ hunks, language }: GitDiffViewProps): React.JSX.Element {
  const themeKind = useThemeKind();
  const prismTheme = isLightTheme(themeKind) ? themes.vsLight : themes.vsDark;

  const fullText = useMemo(() => hunks.flatMap(h => h.lines).map(l => l.text).join('\n'), [hunks]);

  return (
    <Highlight theme={prismTheme} code={fullText} language={language}>
      {({ tokens, getTokenProps }) => {
        let lineIdx = 0;
        return (
          <pre className="crispy-diff-pre">
            {hunks.map((hunk, hi) => {
              const hunkLines = hunk.lines;
              const startIdx = lineIdx;
              lineIdx += hunkLines.length;

              return (
                <div key={hi} className="crispy-git-diff__hunk">
                  <div className="crispy-git-diff__hunk-header">
                    @@ -{hunk.oldStart},{hunk.oldCount} +{hunk.newStart},{hunk.newCount} @@
                  </div>
                  {hunkLines.map((hl, li) => {
                    const tokenLine = tokens[startIdx + li];
                    if (!tokenLine) return null;
                    const prefix = LINE_PREFIX[hl.type] ?? ' ';

                    return (
                      <div
                        key={li}
                        className={`crispy-diff-${hl.type}`}
                        style={{ display: 'flex' }}
                      >
                        <span className="crispy-diff-gutter">
                          {hl.oldLineNo ?? ' '}
                        </span>
                        <span className="crispy-diff-gutter">
                          {hl.newLineNo ?? ' '}
                        </span>
                        <span className="crispy-diff-prefix">
                          {prefix}
                        </span>
                        <span className="crispy-diff-code">
                          {tokenLine.map((token, j) => (
                            <span key={j} {...getTokenProps({ token })} />
                          ))}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </pre>
        );
      }}
    </Highlight>
  );
});
