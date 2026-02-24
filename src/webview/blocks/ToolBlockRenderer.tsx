/**
 * Tool Block Renderer — renders a tool_use block using its ToolDefinition views
 *
 * Looks up the tool definition, gets the result from the registry,
 * computes status, selects the appropriate view, and renders it.
 *
 * @module webview/blocks/ToolBlockRenderer
 */

import { useCallback, useEffect, memo } from 'react';
import type { RichBlock, AnchorPoint, ToolViewProps } from './types.js';
import type { BlocksToolRegistry } from './blocks-tool-registry.js';
import type { TranscriptEntry, ToolResultBlock } from '../../core/transcript.js';
import { getToolDefinition, getToolData, extractSubject } from './tool-definitions.js';
import { selectView } from './select-view.js';
import { GenericExpandedView } from './views/default-views.js';
import { ToolCard } from './views/ToolCard.js';
import { ToolBadge } from '../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, formatCount } from '../renderers/tools/shared/tool-utils.js';
import { useBlocksChildEntries, useBlocksToolRegistry, useInjectChildEntries, useTabSessionId } from './BlocksToolRegistryContext.js';
import { BlocksEntry } from './BlocksEntry.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { usePanelDispatch, usePanelState, usePanelDisplayIds } from './PanelStateContext.js';
import { isToolExpanded } from './panel-reducer.js';
import { useBackgroundAgentTunnel } from '../hooks/useBackgroundAgentTunnel.js';

/** Max children visible in the transcript content tail preview. */
const TAIL_SIZE = 3;

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
  // Self-register this tool_use with the registry on mount.
  // The registry's orphan map handles ordering — if a result arrived before
  // this tool_use mounts, register() will immediately pair them.
  useEffect(() => {
    registry.register(block.id, block.name, block);
  }, [block.id, block.name, block, registry]);

  // Get result from registry
  const result = registry.useResult(block.id);

  // Debug: global tool view override from preferences (?debug=1 settings)
  const { toolViewOverride: globalOverride, toolPanelMode, toolPanelOpen, setToolPanelOpen } = usePreferences();

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
    // Auto-open the tools panel when clicking a compact tool in the transcript
    if (!toolPanelOpen && anchor.type === 'main-thread') {
      setToolPanelOpen(true);
    }
  }, [panelDispatch, block.id, anchor.type, toolPanelOpen, setToolPanelOpen]);

  // Compute status
  const status: ToolViewProps['status'] = !result
    ? 'running'
    : result.is_error
      ? 'error'
      : 'complete';

  // Get tool definition
  const def = getToolDefinition(block.name);

  // Task children: rendered by a dedicated component that owns the
  // useBlocksChildEntries subscription. This isolates child-list updates
  // from the parent ToolBlockRenderer — when a new child arrives, only
  // TaskChildrenRenderer re-renders, not the ToolCard/<details> container.
  // For non-Task tools the component returns null (EMPTY_ARRAY from hook).
  const renderedChildren = (
    <TaskChildrenRenderer toolId={block.id} anchor={anchor} result={result} />
  );

  // Build props for views
  const viewProps: ToolViewProps = {
    block,
    result,
    status,
    anchor,
    children: renderedChildren,
  };

  // Panel-active highlight: true when this tool is currently displayed in the
  // tool panel. Uses the display set published by BlocksToolPanel — the single
  // source of truth for what's shown in the panel.
  const panelDisplayIds = usePanelDisplayIds();
  const isPanelActive = panelDisplayIds.has(block.id);

  // Render with definition if available
  if (def) {
    // Select view: global debug override > auto selection
    let viewMode = globalOverride ?? selectView(def, anchor, block, siblingCount, registry);

    // Panel expansion override: in inspector mode, use the tool's declared
    // default unless the user has clicked or the tool is still streaming.
    if (viewMode === 'expanded' && anchor.type === 'tool-panel'
        && toolPanelMode === 'inspector') {
      const userOverride = panelState.userOverrides.get(block.id);
      if (userOverride !== undefined) {
        viewMode = userOverride ? 'expanded' : 'compact';
      } else if (!result) {
        viewMode = 'expanded';  // streaming → always show output
      } else {
        viewMode = def.inspectorDefault;  // completed → tool's declared default
      }
    } else if (viewMode === 'expanded' && anchor.type === 'tool-panel') {
      // Viewport mode: collapse completed tools, expand streaming
      if (!isToolExpanded(block.id, panelState, !!result)) {
        viewMode = 'compact';
      }
    }

    // Get the view renderer
    const viewFn = def.views[viewMode];

    if (viewFn) {
      return (
        <div className="crispy-blocks-tool" data-tool-id={block.id} data-tool-name={block.name} data-panel-active={isPanelActive || undefined} onClick={clickable ? handleClick : undefined}>
          {viewFn(viewProps)}
        </div>
      );
    }
  }

  // Fallback: generic view for unknown tools
  const data = getToolData(block.name);

  return (
    <div className="crispy-blocks-tool crispy-blocks-tool--unknown" data-tool-id={block.id} data-tool-name={block.name} data-panel-active={isPanelActive || undefined} onClick={clickable ? handleClick : undefined}>
      <FallbackToolView block={block} result={result} status={status} anchor={anchor} data={data} />
    </div>
  );
}

// ============================================================================
// Task Children Renderer — isolated subscription boundary
// ============================================================================

/**
 * Renders Task tool children in its own React subtree.
 *
 * By owning the useBlocksChildEntries subscription here (instead of in
 * ToolBlockRenderer), child-list updates only re-render this component —
 * the parent ToolBlockRenderer and its ToolCard/<details> stay untouched.
 * This prevents layout reflow flash when new children arrive.
 *
 * For non-Task tools, useBlocksChildEntries returns EMPTY_ARRAY and this
 * renders null — zero cost.
 */
interface TaskChildrenRendererProps {
  toolId: string;
  anchor: AnchorPoint;
  result: ToolResultBlock | undefined;
}

function TaskChildrenRenderer({ toolId, anchor, result }: TaskChildrenRendererProps): React.JSX.Element | null {
  const childEntries = useBlocksChildEntries(toolId);

  // Background agent tunnel — activate polling when expanded in panel
  const registry = useBlocksToolRegistry();
  const asyncAgentId = registry.getAsyncAgentId(toolId);
  const selectedSessionId = useTabSessionId();
  const injectChildEntries = useInjectChildEntries();
  const handlePolledEntries = useCallback(
    (entries: TranscriptEntry[]) => injectChildEntries(toolId, entries),
    [injectChildEntries, toolId],
  );

  // Only poll when this is a background Task AND it's in a panel anchor (expanded)
  const isInPanel = anchor.type === 'tool-panel' || anchor.type === 'task-in-panel';
  useBackgroundAgentTunnel(
    toolId,
    asyncAgentId,  // undefined for non-background tasks → hook is no-op
    selectedSessionId,
    isInPanel,
    handlePolledEntries,
  );

  if (childEntries.length === 0) return null;

  // Compute status from result presence
  const status: ToolViewProps['status'] = !result
    ? 'running'
    : result.is_error
      ? 'error'
      : 'complete';

  // Main-thread: completed Tasks hide children, running Tasks show tail.
  // Panel / nested: always show all children.
  let visibleChildren = childEntries;
  if (anchor.type === 'main-thread') {
    if (status === 'complete' || status === 'error') {
      return null;
    }
    // Extended tail: last N+1 children so the oldest can be CSS-collapsed.
    visibleChildren = tailSlicePlus(childEntries, TAIL_SIZE);
  }

  // True when showing a tail window with an extra entry to collapse
  const isMainTail = anchor.type === 'main-thread' && visibleChildren.length > TAIL_SIZE;

  return (
    <div className="crispy-blocks-task-children">
      {isMainTail
        ? visibleChildren.map((entry, i) => (
            <div
              key={entry.uuid}
              className={i === 0 ? 'crispy-blocks-task-child--exiting' : 'crispy-blocks-task-child'}
            >
              <MemoizedBlocksEntry entry={entry} />
            </div>
          ))
        : visibleChildren.map((entry) => (
            <MemoizedBlocksEntry key={entry.uuid} entry={entry} />
          ))
      }
    </div>
  );
}

/**
 * Memoized wrapper for BlocksEntry used in Task children.
 *
 * Without this, every child re-renders when the parent TaskChildrenRenderer
 * re-renders (e.g., when a new sibling arrives). The memo comparator checks
 * entry reference identity -- stable for existing entries since the provider
 * reuses the same TranscriptEntry objects.
 */
const MemoizedBlocksEntry = memo(
  BlocksEntry,
  (prev, next) => prev.entry === next.entry,
);

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
