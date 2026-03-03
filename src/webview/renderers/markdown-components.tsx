/**
 * Shared Markdown Components — code-block highlighting for react-markdown
 *
 * Provides custom `code` and `pre` components for react-markdown's
 * `components` prop. Used by both UserTextRenderer and AssistantTextRenderer
 * to avoid duplicating the prism-react-renderer wiring.
 *
 * - Fenced code blocks get syntax highlighting via prism-react-renderer
 * - Inline code renders as plain `<code>` with CSS styling
 * - The `pre` wrapper adds a className for CSS targeting
 *
 * @module webview/renderers/markdown-components
 */

import { Highlight, themes } from 'prism-react-renderer';
import type { ComponentPropsWithoutRef } from 'react';
import { useThemeKind, isLightTheme } from '../hooks/useThemeKind.js';

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
          // Use theme colors but let CSS handle background
          style={{ ...style, background: 'transparent' }}
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
 * Adds `className="md-code-block"` for CSS targeting of fenced code blocks.
 */
export function PreBlock(props: ComponentPropsWithoutRef<'pre'>): React.JSX.Element {
  return <pre className="md-code-block" {...props} />;
}
