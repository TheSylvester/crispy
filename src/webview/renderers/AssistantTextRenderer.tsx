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

import type { ReactNode } from 'react';
import { CrispyMarkdown } from './CrispyMarkdown.js';
import { LinkifiedP } from './linkify-components.js';
import { isPerfMode } from '../perf/index.js';
import { PerfStore } from '../perf/profiler.js';
import { usePreferences } from '../context/PreferencesContext.js';
import type { ContentBlock, TextBlock } from '../../core/transcript.js';

interface AssistantTextRendererProps {
  block: ContentBlock;
  trailingInlineContent?: ReactNode;
}

function canAppendInlineTail(text: string): boolean {
  return !text.includes('\n\n')
    && !text.includes('```')
    && !/^\s{0,3}(?:#|>|\||[-*+] |\d+\. )/m.test(text);
}

export function AssistantTextRenderer({
  block,
  trailingInlineContent,
}: AssistantTextRendererProps): React.JSX.Element {
  const { text } = block as TextBlock;
  const { markdownSkin } = usePreferences();
  const skinClass = markdownSkin !== 'crispy' ? ` skin-${markdownSkin}` : '';
  const inlineTail = trailingInlineContent && canAppendInlineTail(text)
    ? {
        p: (props: React.HTMLAttributes<HTMLParagraphElement>) => (
          <LinkifiedP {...props}>
            {props.children}
            {trailingInlineContent}
          </LinkifiedP>
        ),
      }
    : undefined;

  if (isPerfMode) {
    const t0 = performance.now();
    const el = (
      <div className={`prose assistant-text${skinClass}`}>
        <CrispyMarkdown components={inlineTail}>{text}</CrispyMarkdown>
        {!inlineTail && trailingInlineContent}
      </div>
    );
    PerfStore.recordMarkdownRender(performance.now() - t0);
    return el;
  }

  return (
    <div className={`prose assistant-text${skinClass}`}>
      <CrispyMarkdown components={inlineTail}>{text}</CrispyMarkdown>
      {!inlineTail && trailingInlineContent}
    </div>
  );
}
