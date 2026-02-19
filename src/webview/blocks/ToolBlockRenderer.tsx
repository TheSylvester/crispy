/**
 * Tool Block Renderer — renders a tool_use block using its ToolDefinition views
 *
 * Looks up the tool definition, gets the result from the registry,
 * computes status, selects the appropriate view, and renders it.
 *
 * @module webview/blocks/ToolBlockRenderer
 */

import type { RichBlock, AnchorPoint, ToolViewProps } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import { getToolDefinition, getToolData, extractSubject } from './tool-definitions.js';
import { selectView } from './select-view.js';
import { GenericExpandedView } from './views/default-views.js';
import { ToolBadge } from '../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../renderers/tools/shared/tool-utils.js';
import { useBlocksChildEntries } from './BlocksToolRegistryContext.js';
import { BlocksEntryWithRegistry } from './BlocksEntryWithRegistry.js';
import { usePreferences } from '../context/PreferencesContext.js';

interface ToolBlockRendererProps {
  block: RichBlock & { type: 'tool_use' };
  anchor: AnchorPoint;
  registry: BlocksToolRegistry;
  /** Number of sibling tool_use blocks in same entry (for view selection) */
  siblingCount: number;
  /** Override the view selection (for collapsed groups rendering in compact) */
  viewOverride?: 'collapsed' | 'compact' | 'expanded';
}

export function ToolBlockRenderer({
  block,
  anchor,
  registry,
  siblingCount,
  viewOverride,
}: ToolBlockRendererProps): React.JSX.Element {
  // Get result from registry
  const result = registry.useResult(block.id);

  // Get child entries for this tool (non-empty only for Task tools).
  // Must be called unconditionally (React hook rules).
  const childEntries = useBlocksChildEntries(block.id);

  // Debug: global tool view override from preferences (?debug=1 settings)
  const { toolViewOverride: globalOverride } = usePreferences();

  // Compute status
  const status: ToolViewProps['status'] = !result
    ? 'running'
    : result.is_error
      ? 'error'
      : 'complete';

  // Get tool definition
  const def = getToolDefinition(block.name);

  // Render child entries for Task tools (zero cost for non-Task tools)
  const renderedChildren = childEntries.length > 0 ? (
    <div className="crispy-blocks-task-children">
      {childEntries.map((entry) => (
        <BlocksEntryWithRegistry key={entry.uuid} entry={entry} />
      ))}
    </div>
  ) : undefined;

  // Build props for views
  const viewProps: ToolViewProps = {
    block,
    result,
    status,
    anchor,
    children: renderedChildren,
  };

  // Render with definition if available
  if (def) {
    // Select view: global debug override > prop override > auto selection
    const viewMode = globalOverride ?? viewOverride ?? selectView(def, anchor, block, siblingCount, registry);

    // Get the view renderer
    const viewFn = def.views[viewMode];

    if (viewFn) {
      return (
        <div className="crispy-blocks-tool" data-tool-id={block.id} data-tool-name={block.name}>
          {viewFn(viewProps)}
        </div>
      );
    }
  }

  // Fallback: generic view for unknown tools
  const data = getToolData(block.name);

  return (
    <div className="crispy-blocks-tool crispy-blocks-tool--unknown" data-tool-id={block.id} data-tool-name={block.name}>
      <FallbackToolView block={block} result={result} status={status} anchor={anchor} data={data} />
    </div>
  );
}

// ============================================================================
// Fallback View for Tools Without Definition
// ============================================================================

interface FallbackToolViewProps extends ToolViewProps {
  data: ReturnType<typeof getToolData>;
}

function FallbackToolView({ block, result, status, data }: FallbackToolViewProps): React.JSX.Element {
  const subject = extractSubject(block);
  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <details className="crispy-blocks-tool-card" open>
      <summary className="crispy-blocks-tool-summary">
        <span className="crispy-blocks-tool-header">
          <span className="crispy-blocks-tool-icon">{data.icon}</span>
          <ToolBadge color={data.color} label={block.name} />
          <span className="crispy-blocks-compact-subject">{subject}</span>
        </span>
        <StatusIndicator status={status} summary={resultSummary} />
      </summary>
      <div className="crispy-blocks-tool-body">
        <GenericExpandedView
          block={block}
          result={result}
          status={status}
          anchor={{ type: 'main-thread' }}
        />
      </div>
    </details>
  );
}
