/**
 * Tool Use Renderer — generic tool card component
 *
 * Renders a tool_use content block as an interactive card that updates
 * in-place when the matching tool_result arrives via the ToolRegistry.
 * Status transitions from 'running' → 'complete'/'error' happen without
 * re-rendering the parent — only this component re-renders via its
 * useSyncExternalStore subscription.
 *
 * Conforms to the BlockRenderer dispatch signature: `{ block: ContentBlock }`.
 *
 * @module webview/renderers/ToolUseRenderer
 */

import { useToolEntry } from '../context/ToolRegistryContext.js';
import { YamlDump } from './YamlDump.js';
import type { ContentBlock, ToolUseBlock } from '../../core/transcript.js';

// ============================================================================
// Status badge labels
// ============================================================================

const STATUS_LABELS: Record<string, string> = {
  running: '⏳ Running',
  complete: '✓ Complete',
  error: '✗ Error',
};

// ============================================================================
// Component
// ============================================================================

interface ToolUseRendererProps {
  block: ContentBlock;
}

export function ToolUseRenderer({ block }: ToolUseRendererProps): React.JSX.Element {
  const toolUse = block as ToolUseBlock;
  const entry = useToolEntry(toolUse.id);

  // Derive display values — entry may not exist yet (shouldn't happen in
  // normal flow, but defensive for edge cases)
  const status = entry?.status ?? 'running';
  const name = entry?.name ?? toolUse.name;
  const statusLabel = STATUS_LABELS[status] ?? status;

  return (
    <div className={`crispy-tool-card crispy-tool-card--${status}`}>
      <div className="crispy-tool-card__header">
        <span className="crispy-tool-card__name">{name}</span>
        <span className={`crispy-tool-card__status crispy-tool-card__status--${status}`}>
          {statusLabel}
        </span>
      </div>

      <details className="crispy-tool-card__input">
        <summary>Input</summary>
        <pre className="yaml-dump">
          <YamlDump value={toolUse.input} />
        </pre>
      </details>

      {entry?.result && (
        <div className="crispy-tool-card__result">
          <ToolResultContent content={entry.result.content} isError={entry.result.is_error} />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Result content renderer
// ============================================================================

interface ToolResultContentProps {
  content: string | ContentBlock[];
  isError?: boolean;
}

function ToolResultContent({ content, isError }: ToolResultContentProps): React.JSX.Element {
  if (typeof content === 'string') {
    return (
      <pre className={`crispy-tool-card__result-text ${isError ? 'crispy-tool-card__result-text--error' : ''}`}>
        {content}
      </pre>
    );
  }

  // ContentBlock[] — render as YAML dump for now (rich nested rendering
  // is a future enhancement)
  return (
    <pre className="crispy-tool-card__result-text yaml-dump">
      <YamlDump value={content} />
    </pre>
  );
}
