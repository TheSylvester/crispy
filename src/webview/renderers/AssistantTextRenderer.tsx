/**
 * Assistant Text Renderer — full-width rich markdown
 *
 * Renders assistant text blocks as full-width markdown with rich
 * headings, lists, code blocks, and inline code. Uses CrispyMarkdown
 * for unified markdown rendering with linkification.
 *
 * The visual layout (full-width flow) is handled by the
 * `.assistant-text` CSS class in styles.css.
 *
 * @module webview/renderers/AssistantTextRenderer
 */

import { CrispyMarkdown } from './CrispyMarkdown.js';
import { isPerfMode } from '../perf/index.js';
import { PerfStore } from '../perf/profiler.js';
import type { ContentBlock, TextBlock } from '../../core/transcript.js';

export function AssistantTextRenderer({ block }: { block: ContentBlock }): React.JSX.Element {
  const { text } = block as TextBlock;

  if (isPerfMode) {
    const t0 = performance.now();
    const el = (
      <div className="prose assistant-text">
        <CrispyMarkdown>{text}</CrispyMarkdown>
      </div>
    );
    PerfStore.recordMarkdownRender(performance.now() - t0);
    return el;
  }

  return (
    <div className="prose assistant-text">
      <CrispyMarkdown>{text}</CrispyMarkdown>
    </div>
  );
}
