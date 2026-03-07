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

export function StreamingGhost({ content }: StreamingGhostProps): React.JSX.Element {
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
                <details key={i} className="streaming-ghost__thinking">
                  <summary>Thinking…</summary>
                  <pre className="streaming-ghost__thinking-text">{block.thinking}</pre>
                </details>
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
