/**
 * Tool Block Renderer — renders a tool_use block using its ToolDefinition views
 *
 * Looks up the tool definition, gets the result from the registry,
 * computes status, selects the appropriate view, and renders it.
 *
 * @module webview/blocks/ToolBlockRenderer
 */

import { useCallback, useState, useEffect, useRef } from 'react';
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
import { usePanelDispatch, usePanelState } from './PanelStateContext.js';
import { isToolExpanded } from './panel-reducer.js';

/** Max children visible in the transcript content tail preview. */
const TAIL_SIZE = 3;

/**
 * Two-phase tail window: when items grow beyond tailSize, first render
 * drops the oldest entry (shrink), then a rAF later adds the newest (grow).
 * Prevents simultaneous add+remove layout flash.
 *
 * No-op when items.length <= tailSize or when the array didn't grow.
 */
function useDeferredTail<T>(items: T[], tailSize: number): T[] {
  // Phase flag: when non-null, we're in the "shrink" frame showing trimmed
  const [pending, setPending] = useState<T[] | null>(null);
  const prevLenRef = useRef(items.length);

  const len = items.length;
  const prevLen = prevLenRef.current;

  // Detect growth beyond tailSize — enter shrink phase
  if (len > prevLen && len > tailSize) {
    // New tail window minus the newest entry: [B, C] not [B, C, D]
    const trimmed = items.slice(-tailSize - 1, -1);
    prevLenRef.current = len;
    // Render-phase setState: legal when conditional and non-looping.
    // React will re-render, but we return trimmed synchronously below
    // so THIS render already shows the shrunk state.
    setPending(trimmed);
    return trimmed;
  }

  prevLenRef.current = len;

  // After the shrink render paints, clear pending → triggers grow render
  useEffect(() => {
    if (pending !== null) {
      const id = requestAnimationFrame(() => setPending(null));
      return () => cancelAnimationFrame(id);
    }
  }, [pending]);

  // Shrink phase (re-render from setPending): return the trimmed array
  if (pending !== null) return pending;

  // Normal: return the tail slice (or full array if within tailSize)
  return len > tailSize ? items.slice(-tailSize) : items;
}

interface ToolBlockRendererProps {
  block: RichBlock & { type: 'tool_use' };
  anchor: AnchorPoint;
  registry: BlocksToolRegistry;
  /** Number of sibling tool_use blocks in same entry (for view selection) */
  siblingCount: number;
}

export function ToolBlockRenderer({
  block,
  anchor,
  registry,
  siblingCount,
}: ToolBlockRendererProps): React.JSX.Element {
  // Get result from registry
  const result = registry.useResult(block.id);

  // Get child entries for this tool (non-empty only for Task tools).
  // Must be called unconditionally (React hook rules).
  const childEntries = useBlocksChildEntries(block.id);

  // Debug: global tool view override from preferences (?debug=1 settings)
  const { toolViewOverride: globalOverride } = usePreferences();

  // Panel state: used for expansion override in tool-panel anchors
  const panelState = usePanelState();

  // Click-to-panel: dispatch USER_CLICKED to pin/expand the tool.
  // Active on main-thread, task-tool, AND tool-panel (so compact panel tools can be clicked to expand).
  const panelDispatch = usePanelDispatch();
  const clickable = anchor.type === 'main-thread' || anchor.type === 'task-tool' || anchor.type === 'tool-panel';
  const handleClick = useCallback(() => {
    panelDispatch({ type: 'USER_CLICKED', toolId: block.id });
  }, [panelDispatch, block.id]);

  // Compute status
  const status: ToolViewProps['status'] = !result
    ? 'running'
    : result.is_error
      ? 'error'
      : 'complete';

  // Get tool definition
  const def = getToolDefinition(block.name);

  // Deferred tail: two-phase add/remove to prevent layout flash.
  // Called unconditionally (React hook rules) but no-op for non-Task tools.
  const deferredTail = useDeferredTail(childEntries, TAIL_SIZE);

  // Render child entries for Task tools (zero cost for non-Task tools).
  // Main-thread: completed Tasks hide children, running Tasks show tail.
  // Panel / nested: always show all children.
  let visibleChildren = childEntries;
  if (anchor.type === 'main-thread' && childEntries.length > 0) {
    if (status === 'complete' || status === 'error') {
      visibleChildren = [];
    } else {
      visibleChildren = deferredTail;
    }
  }

  const renderedChildren = visibleChildren.length > 0 ? (
    <div className="crispy-blocks-task-children">
      {visibleChildren.map((entry) => (
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
    // Select view: global debug override > auto selection
    let viewMode = globalOverride ?? selectView(def, anchor, block, siblingCount, registry);

    // Panel expansion override: tools in tool-panel default to compact unless
    // isToolExpanded says otherwise (active/streaming, pinned, or latest).
    if (viewMode === 'expanded' && anchor.type === 'tool-panel' && !isToolExpanded(block.id, panelState, !!result)) {
      viewMode = 'compact';
    }

    // Get the view renderer
    const viewFn = def.views[viewMode];

    if (viewFn) {
      return (
        <div className="crispy-blocks-tool" data-tool-id={block.id} data-tool-name={block.name} onClick={clickable ? handleClick : undefined}>
          {viewFn(viewProps)}
        </div>
      );
    }
  }

  // Fallback: generic view for unknown tools
  const data = getToolData(block.name);

  return (
    <div className="crispy-blocks-tool crispy-blocks-tool--unknown" data-tool-id={block.id} data-tool-name={block.name} onClick={clickable ? handleClick : undefined}>
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
    <details className="crispy-blocks-tool-card" open={status === 'running'}>
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
