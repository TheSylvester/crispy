/**
 * Blocks Tool Panel — reducer-based tool panel for blocks mode
 *
 * Uses the panel reducer for expansion state with:
 * - Sticky user pin (click to lock expansion)
 * - Active/streaming tools always expanded
 * - Latest arrived tool auto-focused
 *
 * Syncs with BlocksVisibilityContext to track visible tools.
 * Renders expanded views for focused tools, collapsed headers for others.
 *
 * @module webview/blocks/BlocksToolPanel
 */

import { useReducer, useRef, useEffect, useCallback, useMemo } from 'react';
import { useBlocksToolRegistry } from './BlocksToolRegistryContext.js';
import { useBlocksVisibleToolIds } from './BlocksVisibilityContext.js';
import { usePreferences } from '../context/PreferencesContext.js';
import { RenderLocationProvider } from '../context/RenderLocationContext.js';
import { panelReducer, initialPanelState, isToolExpanded, getFocusedToolId } from './panel-reducer.js';
import { getToolDefinition, getToolData } from './tool-definitions.js';
import { StatusIndicator } from '../renderers/tools/shared/StatusIndicator.js';
import type { ToolResultBlock } from '../../core/transcript.js';

/** Threshold in px — auto-scroll when within this distance of the bottom */
const AUTO_SCROLL_THRESHOLD = 80;

export function BlocksToolPanel(): React.JSX.Element {
  const [state, dispatch] = useReducer(panelReducer, initialPanelState);
  const visibleToolIds = useBlocksVisibleToolIds();
  const registry = useBlocksToolRegistry();
  const { setToolPanelWidthPx } = usePreferences();
  const scrollRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const prevVisibleRef = useRef<Set<string>>(new Set());

  // ---------------------------------------------------------------------------
  // Sync visibility changes into reducer
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const currentSet = new Set(visibleToolIds);
    const prevSet = prevVisibleRef.current;

    // Dispatch TOOL_ARRIVED for newly visible tools
    for (const id of visibleToolIds) {
      if (!prevSet.has(id)) {
        dispatch({ type: 'TOOL_ARRIVED', toolId: id });
      }
    }

    // Dispatch TOOL_LEFT_VIEW for tools that left
    for (const id of prevSet) {
      if (!currentSet.has(id)) {
        dispatch({ type: 'TOOL_LEFT_VIEW', toolId: id });
      }
    }

    prevVisibleRef.current = currentSet;
  }, [visibleToolIds]);

  // ---------------------------------------------------------------------------
  // Expansion logic: partition visible tools
  // ---------------------------------------------------------------------------
  const { expandedIds, collapsedIds } = useMemo(() => {
    const expanded: string[] = [];
    const collapsed: string[] = [];
    for (const id of visibleToolIds) {
      if (isToolExpanded(id, state)) {
        expanded.push(id);
      } else {
        collapsed.push(id);
      }
    }
    return { expandedIds: expanded, collapsedIds: collapsed };
  }, [visibleToolIds, state]);

  const focusedId = getFocusedToolId(state);

  // ---------------------------------------------------------------------------
  // Auto-scroll
  // ---------------------------------------------------------------------------
  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < AUTO_SCROLL_THRESHOLD;
  }, []);

  const handleScroll = useCallback(() => {
    wasNearBottomRef.current = isNearBottom();
  }, [isNearBottom]);

  useEffect(() => {
    if (wasNearBottomRef.current) {
      const el = scrollRef.current;
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [visibleToolIds.length]);

  // ---------------------------------------------------------------------------
  // Drag-to-resize
  // ---------------------------------------------------------------------------
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const panel = (e.target as HTMLElement).closest('.crispy-tool-panel');
    const startWidth = panel?.clientWidth ?? 350;
    const layout = document.querySelector('.crispy-layout');

    layout?.setAttribute('data-resizing', '');

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaPx = startX - moveEvent.clientX;
      setToolPanelWidthPx(Math.round(startWidth + deltaPx));
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      layout?.removeAttribute('data-resizing');
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [setToolPanelWidthPx]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const emptyMessage = visibleToolIds.length === 0
    ? 'No tools in view'
    : 'No tools to display';

  return (
    <div className="crispy-tool-panel">
      <div
        className="crispy-tool-panel__resize-handle"
        onMouseDown={handleResizeStart}
      />
      <div className="crispy-tool-panel__header">
        <span className="crispy-tool-panel__title">TOOLS</span>
        <span className="crispy-tool-panel__count">
          {visibleToolIds.length} visible
        </span>
      </div>
      <div
        className="crispy-tool-panel__scroll"
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {visibleToolIds.length === 0 ? (
          <div className="crispy-tool-panel__empty">{emptyMessage}</div>
        ) : (
          <RenderLocationProvider location="panel">
            {/* Expanded tools first */}
            {expandedIds.map(id => (
              <ExpandedPanelTool
                key={id}
                toolId={id}
                registry={registry}
                isPinned={state.userPinnedId === id}
                isFocused={focusedId === id}
                onPin={() => dispatch({ type: 'USER_CLICKED', toolId: id })}
              />
            ))}
            {/* Collapsed headers */}
            {collapsedIds.map(id => (
              <CollapsedPanelHeader
                key={id}
                toolId={id}
                registry={registry}
                onClick={() => dispatch({ type: 'USER_CLICKED', toolId: id })}
              />
            ))}
          </RenderLocationProvider>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// Expanded Panel Tool
// ============================================================================

interface ExpandedPanelToolProps {
  toolId: string;
  registry: import('./blocks-tool-registry.js').BlocksToolRegistry;
  isPinned: boolean;
  isFocused: boolean;
  onPin: () => void;
}

function ExpandedPanelTool({
  toolId,
  registry,
  isPinned,
  isFocused,
  onPin,
}: ExpandedPanelToolProps): React.JSX.Element | null {
  const result = registry.useResult(toolId);
  const toolName = registry.getName(toolId) ?? 'Unknown';

  const def = getToolDefinition(toolName);
  const data = getToolData(toolName);
  const status: 'running' | 'complete' | 'error' = result
    ? result.is_error
      ? 'error'
      : 'complete'
    : 'running';

  // Pin indicator
  const cardClass = [
    'crispy-blocks-panel-tool',
    isPinned ? 'crispy-blocks-panel-tool--pinned' : '',
    isFocused ? 'crispy-blocks-panel-tool--focused' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={cardClass} onClick={onPin}>
      <div className="crispy-blocks-panel-tool__header">
        <span className="crispy-blocks-panel-tool__icon">{data.icon}</span>
        <span className="crispy-blocks-panel-tool__name">{toolName}</span>
        <StatusIndicator status={status} />
        {isPinned && <span className="crispy-blocks-panel-tool__pin">📌</span>}
      </div>
      {def?.views.expanded && result && (
        <div className="crispy-blocks-panel-tool__body">
          {/* Render expanded view if we had the full block */}
          <div className="crispy-blocks-panel-tool__result">
            {extractResultPreview(result)}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Collapsed Panel Header
// ============================================================================

interface CollapsedPanelHeaderProps {
  toolId: string;
  registry: import('./blocks-tool-registry.js').BlocksToolRegistry;
  onClick: () => void;
}

function CollapsedPanelHeader({
  toolId,
  registry,
  onClick,
}: CollapsedPanelHeaderProps): React.JSX.Element {
  const result = registry.useResult(toolId);
  const toolName = registry.getName(toolId) ?? 'Unknown';
  const data = getToolData(toolName);
  const status: 'running' | 'complete' | 'error' = result
    ? result.is_error
      ? 'error'
      : 'complete'
    : 'running';

  return (
    <button
      className="crispy-blocks-panel-header"
      onClick={onClick}
    >
      <span className="crispy-blocks-panel-header__icon">{data.icon}</span>
      <span className="crispy-blocks-panel-header__name">
        {toolName}
      </span>
      <StatusIndicator status={status} />
    </button>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function extractResultPreview(result: ToolResultBlock): string {
  const content = result.content;
  if (typeof content === 'string') {
    return content.slice(0, 200) + (content.length > 200 ? '...' : '');
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text' && 'text' in item) {
        const text = (item as { text: string }).text;
        return text.slice(0, 200) + (text.length > 200 ? '...' : '');
      }
    }
  }
  return '[Result]';
}
