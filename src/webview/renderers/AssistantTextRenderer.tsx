/**
 * Assistant Text Renderer — full-width rich markdown
 *
 * Renders assistant text blocks as full-width markdown with rich
 * headings, lists, code blocks, and inline code. Uses react-markdown
 * with shared code-block highlighting.
 *
 * The visual layout (full-width flow) is handled by the
 * `.assistant-text` CSS class in styles.css.
 *
 * @module webview/renderers/AssistantTextRenderer
 */

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PreBlock } from './markdown-components.js';
import { LinkifiedP, LinkifiedLi, LinkifiedTd, LinkifiedCode } from './linkify-components.js';
import type { ContentBlock, TextBlock } from '../../core/transcript.js';

export function AssistantTextRenderer({ block }: { block: ContentBlock }): React.JSX.Element {
  const { text } = block as TextBlock;
  return (
    <div className="prose assistant-text">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          code: LinkifiedCode,
          pre: PreBlock,
          p: LinkifiedP,
          li: LinkifiedLi,
          td: LinkifiedTd,
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}
