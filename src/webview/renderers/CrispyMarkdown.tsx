/**
 * CrispyMarkdown — unified Markdown renderer with linkification
 *
 * Thin wrapper around react-markdown that bakes in the standard config:
 * remark-gfm for tables/strikethrough, remark-math + rehype-katex for
 * LaTeX math rendering (MathML output, $$-only delimiters), PreBlock
 * for fenced code, and the four Linkified* components for file-path linking.
 *
 * "Wherever there's Markdown, there's Linkify."
 *
 * Module-level constants prevent react-markdown pipeline re-init on
 * every render (same pattern previously used in User/AssistantTextRenderer).
 *
 * @module webview/renderers/CrispyMarkdown
 */

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { PreBlock } from './markdown-components.js';
import { LinkifiedP, LinkifiedLi, LinkifiedTd, LinkifiedCode } from './linkify-components.js';
import type { Components } from 'react-markdown';
import type { PluggableList } from 'unified';

const remarkPlugins: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: false }]];
const remarkPluginsWithBreaks: PluggableList = [remarkGfm, [remarkMath, { singleDollarTextMath: false }], remarkBreaks];
const rehypePlugins: PluggableList = [[rehypeKatex, { output: 'mathml' }]];
const defaultComponents = {
  code: LinkifiedCode,
  pre: PreBlock,
  p: LinkifiedP,
  li: LinkifiedLi,
  td: LinkifiedTd,
};

interface CrispyMarkdownProps {
  children: string;
  components?: Components;
  /** When true, single newlines become <br> instead of being ignored. */
  breaks?: boolean;
}

export function CrispyMarkdown({ children, components, breaks }: CrispyMarkdownProps): React.JSX.Element {
  return (
    <Markdown
      remarkPlugins={breaks ? remarkPluginsWithBreaks : remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={{ ...defaultComponents, ...components }}
    >
      {children}
    </Markdown>
  );
}
