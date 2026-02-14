/**
 * User Text Renderer — right-aligned bubble with markdown
 *
 * Renders user text blocks as right-aligned bubbles with a max-width
 * constraint. Uses react-markdown with shared code-block highlighting.
 *
 * The visual layout (right-alignment, max-width: 80%) is handled by
 * the `.user-text` CSS class in styles.css.
 *
 * @module webview/renderers/UserTextRenderer
 */

import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PreBlock } from './markdown-components.js';
import { LinkifiedP, LinkifiedLi, LinkifiedTd, LinkifiedCode } from './linkify-components.js';
import type { ContentBlock, TextBlock } from '../../core/transcript.js';

export function UserTextRenderer({ block }: { block: ContentBlock }): React.JSX.Element {
  const { text } = block as TextBlock;
  return (
    <div className="prose user-text">
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
