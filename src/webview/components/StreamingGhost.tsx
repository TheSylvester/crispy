/**
 * StreamingGhost — temporary assistant message rendered from streaming deltas
 *
 * Displays partial content blocks accumulated during live SDK streaming.
 * Text blocks use a stable/tail split: completed paragraphs (everything
 * before the last \n\n) render through CrispyMarkdown for full formatting;
 * the in-progress trailing fragment renders as plain text with a blinking
 * cursor. This prevents layout reflows from incomplete markdown structures
 * being re-parsed on every update.
 *
 * Thinking blocks render as collapsed sections, tool_use blocks as
 * name-only placeholders.
 *
 * @module StreamingGhost
 */

import { useEffect, useRef } from 'react';
import type { ContentBlock } from '../../core/transcript.js';
import { CrispyMarkdown } from '../renderers/CrispyMarkdown.js';
import './StreamingGhost.css';

interface StreamingGhostProps {
  content: ContentBlock[];
}

/**
 * Split text at the last paragraph boundary (\n\n).
 * Returns [stable, tail] where stable contains completed blocks
 * safe for markdown rendering, and tail is the in-progress fragment.
 */
function splitAtParagraphBoundary(text: string): [string, string] {
  const lastBreak = text.lastIndexOf('\n\n');
  if (lastBreak === -1) return ['', text];
  return [text.slice(0, lastBreak), text.slice(lastBreak + 2)];
}

/**
 * Streaming thinking block — renders a `<details>` whose open state is
 * controlled by the parent. While `open`, auto-scrolls the inner `<pre>`
 * to its bottom on every text update so live reasoning stays in view.
 */
function StreamingThinkingBlock({
  thinking,
  open,
}: {
  thinking: string;
  open: boolean;
}): React.JSX.Element {
  const preRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (open && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight;
    }
  }, [thinking, open]);
  return (
    <details className="streaming-ghost__thinking" open={open}>
      <summary>
        Thinking…
        <ThinkingChevron />
      </summary>
      <pre ref={preRef} className="streaming-ghost__thinking-text">
        {thinking}
      </pre>
    </details>
  );
}

/** SVG chevron — points right by default, rotated 90° via CSS when open */
function ThinkingChevron(): React.JSX.Element {
  return (
    <svg
      className="crispy-details-chevron"
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3,2 7,5 3,8" />
    </svg>
  );
}

export function StreamingGhost({ content }: StreamingGhostProps): React.JSX.Element {
  let lastMeaningfulIndex = -1;
  for (let idx = content.length - 1; idx >= 0; idx--) {
    const b = content[idx];
    if (
      (b.type === 'text' && Boolean(b.text)) ||
      (b.type === 'thinking' && Boolean(b.thinking)) ||
      b.type === 'tool_use'
    ) {
      lastMeaningfulIndex = idx;
      break;
    }
  }
  return (
    <div className="message assistant streaming-ghost">
      <div className="streaming-ghost__blocks">
        {content.map((block, i) => {
          switch (block.type) {
            case 'text': {
              if (!block.text) return null;
              const [stable, tail] = splitAtParagraphBoundary(block.text);
              return (
                <div key={i} className="prose assistant-text streaming-ghost__text">
                  {stable && <CrispyMarkdown>{stable}</CrispyMarkdown>}
                  {tail && (
                    <span className="streaming-ghost__tail">
                      {tail}
                      <span className="streaming-ghost__cursor" />
                    </span>
                  )}
                  {!tail && <span className="streaming-ghost__cursor" />}
                </div>
              );
            }

            case 'thinking':
              return block.thinking ? (
                <StreamingThinkingBlock
                  key={i}
                  thinking={block.thinking}
                  open={i === lastMeaningfulIndex}
                />
              ) : null;

            case 'tool_use':
              return (
                <span key={i} className="streaming-ghost__tool-pill">
                  {block.name}
                </span>
              );

            default:
              return null;
          }
        })}
      </div>
    </div>
  );
}
