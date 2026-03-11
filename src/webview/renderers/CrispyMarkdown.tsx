/**
 * CrispyMarkdown — unified Markdown renderer with linkification
 *
 * Thin wrapper around react-markdown that bakes in the standard config:
 * remark-gfm for tables/strikethrough, PreBlock for fenced code,
 * and the four Linkified* components for automatic file-path linking.
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
import { PreBlock } from './markdown-components.js';
import { LinkifiedP, LinkifiedLi, LinkifiedTd, LinkifiedCode } from './linkify-components.js';
import type { Components } from 'react-markdown';

const plugins = [remarkGfm];
const pluginsWithBreaks = [remarkGfm, remarkBreaks];
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
      remarkPlugins={breaks ? pluginsWithBreaks : plugins}
      components={{ ...defaultComponents, ...components }}
    >
      {children}
    </Markdown>
  );
}
