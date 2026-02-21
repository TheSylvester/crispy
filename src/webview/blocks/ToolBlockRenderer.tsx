/**
 * Tool Block Renderer — renders a tool_use block using its ToolDefinition views
 *
 * Looks up the tool definition, gets the result from the registry,
 * computes status, selects the appropriate view, and renders it.
 *
 * @module webview/blocks/ToolBlockRenderer
 */

import { useCallback } from 'react';
import type { RichBlock, AnchorPoint, ToolViewProps } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import { getToolDefinition, getToolData, extractSubject } from './tool-definitions.js';
import { selectView } from './select-view.js';
import { GenericExpandedView } from './views/default-views.js';
import { ToolCard } from './views/ToolCard.js';
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

/** Tools that should never auto-expand in the tool panel (read-only / low-signal). */
const COMPACT_ONLY_TOOLS = new Set(['Read', 'Grep', 'WebFetch', 'WebSearch']);

/**
 * Extended tail: returns the last `tailSize + 1` items so the oldest
 * can be CSS-collapsed, preventing layout shift on unmount.
 */
function tailSlicePlus<T>(items: T[], tailSize: number): T[] {
  const take = tailSize + 1;
  return items.length > take ? items.slice(-take) : items;
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
  const handleClick = useCallback((e: React.MouseEvent) => {
    // In the panel, only toggle on header clicks — ignore clicks inside
    // the tool body (children, result text, code blocks, etc.)
    if (anchor.type === 'tool-panel') {
      const target = e.target as HTMLElement;
      if (target.closest('.crispy-blocks-tool-body, .crispy-blocks-task-children')) {
        return;
      }
    }
    panelDispatch({ type: 'USER_CLICKED', toolId: block.id });
  }, [panelDispatch, block.id, anchor.type]);

  // Compute status
  const status: ToolViewProps['status'] = !result
    ? 'running'
    : result.is_error
      ? 'error'
      : 'complete';

  // Get tool definition
  const def = getToolDefinition(block.name);

  // Extended tail: last N+1 children for main-thread running Task.
  // The oldest gets CSS-collapsed to zero height so its unmount is invisible.
  const deferredTail = tailSlicePlus(childEntries, TAIL_SIZE);

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

  // True when showing a tail window with an extra entry to collapse
  const isMainTail = anchor.type === 'main-thread' && visibleChildren.length > TAIL_SIZE;

  const renderedChildren = visibleChildren.length > 0 ? (
    <div className="crispy-blocks-task-children">
      {isMainTail
        ? visibleChildren.map((entry, i) => (
            <div
              key={entry.uuid}
              className={i === 0 ? 'crispy-blocks-task-child--exiting' : 'crispy-blocks-task-child'}
            >
              <BlocksEntryWithRegistry entry={entry} />
            </div>
          ))
        : visibleChildren.map((entry) => (
            <BlocksEntryWithRegistry key={entry.uuid} entry={entry} />
          ))
      }
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
    // Compact-only tools (Read, Grep, Web*) never auto-expand — only explicit
    // user pin can expand them (ignores active, latest-arrived, etc.)
    if (viewMode === 'expanded' && anchor.type === 'tool-panel') {
      if (COMPACT_ONLY_TOOLS.has(block.name)) {
        viewMode = panelState.userPinnedId === block.id ? 'expanded' : 'compact';
      } else if (!isToolExpanded(block.id, panelState, !!result)) {
        viewMode = 'compact';
      }
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

function FallbackToolView({ block, result, status, anchor, data }: FallbackToolViewProps): React.JSX.Element {
  const subject = extractSubject(block);
  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : formatCount(resultText, 'line')
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{data.icon}</span>
        <ToolBadge color={data.color} label={block.name} />
        <span className="crispy-blocks-compact-subject">{subject}</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      <div className="crispy-blocks-tool-body">
        <GenericExpandedView
          block={block}
          result={result}
          status={status}
          anchor={anchor}
        />
      </div>
    </ToolCard>
  );
}
