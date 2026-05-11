/**
 * Shared Markdown Components — code-block highlighting for react-markdown
 *
 * Provides custom `code` and `pre` components for react-markdown's
 * `components` prop. Used by both UserTextRenderer and AssistantTextRenderer
 * to avoid duplicating the prism-react-renderer wiring.
 *
 * - Fenced code blocks get syntax highlighting via prism-react-renderer
 * - Inline code renders as plain `<code>` with CSS styling
 * - `MarkdownCodeBlock` wraps `<pre>` and provides per-block hover affordances
 *   (copy + wrap toggle) for fenced code blocks
 *
 * @module webview/renderers/markdown-components
 */

import { Highlight, themes } from 'prism-react-renderer';
import { useRef, useState, type ComponentPropsWithoutRef } from 'react';
import { useThemeKind, isLightTheme } from '../hooks/useThemeKind.js';
import { CopyButton } from '../components/CopyButton.js';
import { WrapTextIcon } from '../components/control-panel/icons.js';

/**
 * Extract language identifier from a react-markdown className.
 *
 * react-markdown passes fenced code block language as `className="language-typescript"`.
 * This extracts the language name for prism-react-renderer.
 *
 * @returns Language string or null if no language class found
 */
export function extractLanguage(className: string | undefined): string | null {
  if (!className) return null;
  const match = className.match(/language-(\S+)/);
  return match ? match[1] : null;
}

/**
 * Custom `code` component for react-markdown.
 *
 * Fenced code blocks (identified by `language-*` className from the parent)
 * get syntax highlighting via prism-react-renderer with the vsDark theme.
 * Inline code renders as a plain `<code>` element.
 */
export function CodeBlock(props: ComponentPropsWithoutRef<'code'>): React.JSX.Element {
  const { children, className, ...rest } = props;
  const language = extractLanguage(className);

  // Hook must be called unconditionally (before any early return) to satisfy
  // React's rules-of-hooks — hook count must be stable across renders.
  const themeKind = useThemeKind();

  // Inline code — no language class means it's not a fenced block
  if (!language) {
    return (
      <code className={className} {...rest}>
        {children}
      </code>
    );
  }

  // Fenced code block — syntax highlight with prism
  const prismTheme = isLightTheme(themeKind) ? themes.vsLight : themes.vsDark;

  const code = String(children).replace(/\n$/, '');
  return (
    <Highlight theme={prismTheme} code={code} language={language}>
      {({ tokens, getLineProps, getTokenProps, style }) => (
        <code
          className="md-code-highlight"
          // Use theme colors but let CSS handle background — must override
          // both backgroundColor (set by Prism theme) and background (shorthand)
          style={{ ...style, backgroundColor: 'transparent', background: 'transparent' }}
        >
          {tokens.map((line, i) => {
            const lineProps = getLineProps({ line, key: i });
            return (
              <span key={i} {...lineProps}>
                {line.map((token, j) => (
                  <span key={j} {...getTokenProps({ token, key: j })} />
                ))}
                {'\n'}
              </span>
            );
          })}
        </code>
      )}
    </Highlight>
  );
}

/**
 * Custom `pre` component for react-markdown.
 *
 * Wraps the fenced code block in a `.md-code-block` div with per-block hover
 * affordances: copy button and wrap toggle. The actual <pre> sits inside the
 * wrapper with stripped defaults so the wrapper can host the overlay.
 *
 * Wrap state is local React state, transient (lost on rerender). Default off
 * — fenced code retains <pre> literal-fidelity semantics unless the user opts in.
 */
export function MarkdownCodeBlock(props: ComponentPropsWithoutRef<'pre'>): React.JSX.Element {
  const { className, ...rest } = props;
  const [wrapped, setWrapped] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  const wrapperClass = `md-code-block${wrapped ? ' md-code-block--wrap' : ''}`;
  const preClass = ['md-code-block__pre', className].filter(Boolean).join(' ');

  return (
    <div className={wrapperClass}>
      <pre ref={preRef} className={preClass} {...rest} />
      <div className="md-code-block__overlay">
        <CopyButton
          getText={() => preRef.current?.textContent ?? ''}
          title="Copy code"
          className="md-code-block__btn"
        />
        <button
          type="button"
          className={`crispy-copy-btn md-code-block__btn md-code-block__wrap-btn${wrapped ? ' md-code-block__wrap-btn--active' : ''}`}
          title={wrapped ? 'Disable word wrap' : 'Enable word wrap'}
          aria-label={wrapped ? 'Disable word wrap' : 'Enable word wrap'}
          aria-pressed={wrapped}
          onClick={(e) => { e.stopPropagation(); setWrapped((v) => !v); }}
        >
          <WrapTextIcon />
        </button>
      </div>
    </div>
  );
}
