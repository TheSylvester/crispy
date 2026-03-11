/**
 * User Text Renderer — right-aligned bubble with markdown
 *
 * Renders user text blocks as right-aligned bubbles with a max-width
 * constraint. Uses CrispyMarkdown for unified markdown rendering
 * with linkification.
 *
 * The visual layout (right-alignment, max-width: 80%) is handled by
 * the `.user-text` CSS class in styles.css.
 *
 * @module webview/renderers/UserTextRenderer
 */

import { CrispyMarkdown } from './CrispyMarkdown.js';
import type { ContentBlock, TextBlock } from '../../core/transcript.js';

export function UserTextRenderer({ block }: { block: ContentBlock }): React.JSX.Element {
  const { text } = block as TextBlock;
  return (
    <div className="prose user-text">
      <CrispyMarkdown breaks>{text}</CrispyMarkdown>
    </div>
  );
}
