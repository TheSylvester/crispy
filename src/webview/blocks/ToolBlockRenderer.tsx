/**
 * Tool Block Renderer — renders a tool_use block using its ToolDefinition views
 *
 * Looks up the tool definition, gets the result from the registry,
 * computes status, selects the appropriate view, and renders it.
 *
 * @module webview/blocks/ToolBlockRenderer
 */

import { useCallback, useRef, useEffect, memo } from 'react';
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
import { useBlocksChildEntries, useBlocksToolRegistry, useInjectChildEntries } from './BlocksToolRegistryContext.js';
import { BlocksEntryWithRegistry } from './BlocksEntryWithRegistry.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { usePanelDispatch, usePanelState, usePanelDisplayIds } from './PanelStateContext.js';
import { isToolExpanded } from './panel-reducer.js';
import { useSession } from '../context/SessionContext.js';
import { useBackgroundAgentTunnel } from '../hooks/useBackgroundAgentTunnel.js';

/** Max children visible in the transcript content tail preview. */
const TAIL_SIZE = 3;

/** px from bottom — auto-scroll task children in panel when within this threshold */
const CHILDREN_SCROLL_THRESHOLD = 80;

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

  // Debug: global tool view override from preferences (?debug=1 settings)
  const { toolViewOverride: globalOverride, toolPanelMode, toolPanelOpen, setToolPanelOpen, inlineToolMode } = usePreferences();

  // Panel state: used for expansion override in tool-panel anchors
  const panelState = usePanelState();

  // Click-to-panel: dispatch USER_CLICKED to pin/expand the tool.
  // Active on main-thread, task-tool, AND tool-panel (so compact panel tools can be clicked to expand).
  const panelDispatch = usePanelDispatch();
  const clickable = anchor.type === 'main-thread' || anchor.type === 'task-tool' || anchor.type === 'tool-panel';
  const handleClick = useCallback((e: React.MouseEvent) => {
    // Bail out if clicking an interactive element (link, button, input) —
    // let the element handle its own click instead of activating the card.
    const target = e.target as HTMLElement;
    if (target.closest('a[href]')) {
      return;
    }
    // In the panel, only toggle on header clicks — ignore clicks inside
    // the tool body (children, result text, code blocks, etc.)
    if (anchor.type === 'tool-panel') {
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
    let viewMode: 'compact' | 'expanded' | 'inline' = globalOverride ?? selectView(def, anchor, block, siblingCount, registry, inlineToolMode);

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

    // Get the view renderer — must be rendered as a React component (not a
    // plain function call) so hooks inside the view belong to their own fiber,
    // not to ToolBlockRenderer.  Compact and expanded views may call different
    // hooks, so a plain `viewFn(viewProps)` would violate rules-of-hooks when
    // the view mode flips.
    const ViewComponent = def.views[viewMode] ?? (viewMode === 'inline' ? def.views.compact : undefined);

    if (ViewComponent) {
      // Panel tinted cards: expanded tools get tinted border/background using the tool's color
      const panelTintStyle = (anchor.type === 'tool-panel' && viewMode === 'expanded')
        ? { border: `1px solid ${hexToRgba(def.color, 0.2)}`, background: hexToRgba(def.color, 0.04), borderRadius: '6px', margin: '4px 0', overflow: 'hidden' as const }
        : undefined;

      return (
        <div className="crispy-blocks-tool" data-tool-id={block.id} data-tool-name={block.name} data-panel-active={isPanelActive || undefined} onClick={clickable ? handleClick : undefined} style={panelTintStyle}>
          <ViewComponent {...viewProps} />
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
  const { selectedSessionId } = useSession();
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

  // ---------------------------------------------------------------------------
  // Auto-scroll: keep panel task-children pinned to bottom as new entries arrive.
  // The .crispy-blocks-task-children container becomes scrollable via CSS
  // (overflow-y: auto; max-height: 40vh) when rendered inside the tool panel.
  // ---------------------------------------------------------------------------
  const childrenScrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);

  const handleChildrenScroll = useCallback(() => {
    const el = childrenScrollRef.current;
    if (!el) return;
    wasNearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < CHILDREN_SCROLL_THRESHOLD;
  }, []);

  // Scroll to bottom when new children arrive (effect fires after DOM update)
  useEffect(() => {
    if (!isInPanel) return;
    const el = childrenScrollRef.current;
    if (!el) return;
    if (wasNearBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [childEntries.length, isInPanel]);

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
    <div
      className="crispy-blocks-task-children"
      ref={isInPanel ? childrenScrollRef : undefined}
      onScroll={isInPanel ? handleChildrenScroll : undefined}
    >
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
 * Memoized wrapper for BlocksEntryWithRegistry used in Task children.
 *
 * Without this, every child re-renders when the parent TaskChildrenRenderer
 * re-renders (e.g., when a new sibling arrives). The memo comparator checks
 * entry reference identity — stable for existing entries since the provider
 * reuses the same TranscriptEntry objects.
 */
const MemoizedBlocksEntry = memo(
  BlocksEntryWithRegistry,
  (prev, next) => prev.entry === next.entry,
);

// ============================================================================
// Fallback View for Tools Without Definition
// ============================================================================

interface FallbackToolViewProps extends ToolViewProps {
  data: ReturnType<typeof getToolData>;
}

/**
 * Convert a hex color (#rrggbb) to rgba() with the given alpha.
 */
function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
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
