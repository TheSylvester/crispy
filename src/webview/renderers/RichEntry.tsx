/**
 * Rich Entry Renderer — structured content-block rendering
 *
 * Renders transcript entries as semantic HTML: text paragraphs, thinking
 * blocks, tool-use stubs, and images. The critical design decision from
 * Leto: tool_result blocks return null (never rendered standalone) —
 * CSS `.message:empty` hides the wrapper when all children are null.
 *
 * @module webview/renderers/RichEntry
 */

import type {
  TranscriptEntry,
  ContentBlock,
  ToolUseBlock,
} from '../../core/transcript.js';

// ============================================================================
// Rich Entry
// ============================================================================

/**
 * Rich mode entry renderer (stub).
 *
 * Handles summary entries, string content, and array content blocks.
 * The critical behavior: ContentBlockRenderer returns null for tool_result.
 */
export function RichEntry({ entry }: { entry: TranscriptEntry }): React.JSX.Element | null {
  // Summary entries
  if (entry.type === 'summary' && entry.summary) {
    return (
      <div className="message system" data-uuid={entry.uuid}>
        <div className="text-content">{entry.summary}</div>
      </div>
    );
  }

  const content = entry.message?.content;
  if (!content) return null;

  const role = entry.message!.role ?? entry.type;

  if (typeof content === 'string') {
    return (
      <div className={`message ${role}`} data-uuid={entry.uuid}>
        <div className="text-content">{content}</div>
      </div>
    );
  }

  // Array of content blocks — render each, let null returns be invisible.
  // CSS .message:empty hides wrapper divs when all children are null.
  return (
    <div className={`message ${role}`} data-uuid={entry.uuid}>
      {content.map((block, i) => (
        <ContentBlockRenderer
          key={block.type === 'tool_use' ? (block as ToolUseBlock).id : `${entry.uuid}-${i}`}
          block={block}
        />
      ))}
    </div>
  );
}

// ============================================================================
// Content Block Renderer — stub dispatcher
// ============================================================================

/**
 * Dispatches individual content blocks in Rich mode.
 * tool_result → null is the critical design from Leto.
 */
function ContentBlockRenderer({ block }: { block: ContentBlock }): React.JSX.Element | null {
  switch (block.type) {
    case 'text':
      return <p>{block.text}</p>;
    case 'thinking':
      return (
        <details>
          <summary>Thinking</summary>
          <pre>{block.thinking}</pre>
        </details>
      );
    case 'tool_use':
      return <div className="tool-card-stub">[{block.name}]</div>;
    case 'tool_result':
      return null; // CRITICAL: never rendered standalone
    case 'image':
      return <p>[Image]</p>;
    default:
      return null;
  }
}
