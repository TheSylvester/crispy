/**
 * Entry Renderer — per-entry dispatcher for transcript entries
 *
 * Dispatches on entry.type and content block types to render:
 * - Text blocks as <p>
 * - Thinking blocks as collapsible <details>
 * - Tool use blocks as collapsible with tool name + input preview
 * - Tool result blocks as collapsible, with red border if error
 * - Image blocks as placeholder
 * - Summary entries as <p>
 * - String content as <p>
 *
 * @module EntryRenderer
 */

import { useState } from 'react';
import type {
  TranscriptEntry,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
} from '../../core/transcript.js';

interface EntryRendererProps {
  entry: TranscriptEntry;
  index: number;
}

export function EntryRenderer({ entry, index }: EntryRendererProps): React.JSX.Element | null {
  // Skip non-renderable entry types
  if (entry.type === 'stream_event' || entry.type === 'progress' || entry.type === 'queue-operation' || entry.type === 'file-history-snapshot') {
    return null;
  }

  // Summary entries
  if (entry.type === 'summary' && entry.summary) {
    return (
      <div className="crispy-entry crispy-entry--system" data-index={index}>
        <div className="crispy-entry__role">summary</div>
        <div className="crispy-entry__content">{entry.summary}</div>
      </div>
    );
  }

  const message = entry.message;
  if (!message) return null;

  const role = message.role ?? entry.type;
  const roleClass = role === 'user' ? 'crispy-entry--user'
    : role === 'assistant' ? 'crispy-entry--assistant'
    : 'crispy-entry--system';

  return (
    <div className={`crispy-entry ${roleClass}`} data-index={index}>
      <div className="crispy-entry__role">{role}</div>
      <div className="crispy-entry__content">
        {typeof message.content === 'string' ? (
          <p>{message.content}</p>
        ) : (
          message.content.map((block, i) => (
            <ContentBlockRenderer key={i} block={block} />
          ))
        )}
      </div>
    </div>
  );
}

// --- Content Block Dispatcher ---

function ContentBlockRenderer({ block }: { block: ContentBlock }): React.JSX.Element {
  switch (block.type) {
    case 'text':
      return <p>{block.text}</p>;
    case 'thinking':
      return <ThinkingRenderer thinking={block.thinking} />;
    case 'tool_use':
      return <ToolUseRenderer block={block} />;
    case 'tool_result':
      return <ToolResultRenderer block={block} />;
    case 'image':
      return <p className="crispy-placeholder">[Image]</p>;
    default:
      return <p>[Unknown block type]</p>;
  }
}

// --- Thinking ---

function ThinkingRenderer({ thinking }: { thinking: string }): React.JSX.Element {
  return (
    <details className="crispy-thinking">
      <summary>💭 Thinking ({thinking.length} chars)</summary>
      <pre>{thinking}</pre>
    </details>
  );
}

// --- Tool Use ---

function getToolInputPreview(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  // Show first meaningful field as preview
  const previewFields = ['command', 'file_path', 'pattern', 'query', 'url', 'skill', 'prompt', 'description'];
  for (const field of previewFields) {
    if (obj[field] && typeof obj[field] === 'string') {
      const val = obj[field] as string;
      return val.length > 60 ? val.slice(0, 60) + '…' : val;
    }
  }
  return '';
}

function ToolUseRenderer({ block }: { block: ToolUseBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const preview = getToolInputPreview(block.input);

  return (
    <div className="crispy-tool-use">
      <div className="crispy-tool-use__header" onClick={() => setOpen(!open)}>
        <span>{open ? '▼' : '▶'}</span>
        <span className="crispy-tool-use__name">{block.name}</span>
        {!open && preview && (
          <span className="crispy-tool-use__preview">{preview}</span>
        )}
      </div>
      {open && (
        <div className="crispy-tool-use__body">
          {JSON.stringify(block.input, null, 2)}
        </div>
      )}
    </div>
  );
}

// --- Tool Result ---

function ToolResultRenderer({ block }: { block: ToolResultBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const errorClass = block.is_error ? ' crispy-tool-result--error' : '';

  const contentStr = typeof block.content === 'string'
    ? block.content
    : JSON.stringify(block.content, null, 2);

  const previewLen = 80;
  const preview = contentStr.length > previewLen ? contentStr.slice(0, previewLen) + '…' : contentStr;

  return (
    <div className={`crispy-tool-result${errorClass}`}>
      <div className="crispy-tool-result__header" onClick={() => setOpen(!open)}>
        <span>{open ? '▼' : '▶'}</span>
        <span>{block.is_error ? '❌ Error' : '✓ Result'}</span>
        {!open && <span className="crispy-tool-use__preview">{preview}</span>}
      </div>
      {open && (
        <div className="crispy-tool-result__body">
          {contentStr}
        </div>
      )}
    </div>
  );
}
