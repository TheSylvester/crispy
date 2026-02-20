/**
 * Block Types — type foundation for the blocks rendering mode
 *
 * Defines the structural context that enriches ContentBlock into RichBlock,
 * plus supporting types for anchor points, render runs, tool views, and
 * tool definitions.
 *
 * @module webview/blocks/types
 */

import type { ReactNode } from 'react';
import type { ContentBlock, ToolResultBlock } from '../../core/transcript.js';

// ============================================================================
// Block Context — immutable structural data attached to every block
// ============================================================================

/**
 * Structural context for a content block.
 *
 * Computed at normalization time, immutable thereafter.
 * No UI state — purely describes where the block lives in the tree.
 */
export interface BlockContext {
  /** UUID of the parent TranscriptEntry */
  entryUuid: string;
  /** Role from the entry (user, assistant, system, etc.) */
  role: string;
  /** If this block is inside a sub-agent turn, the parent Task tool_use_id */
  parentToolUseId?: string;
  /** Agent ID if from a sub-agent */
  agentId?: string;
  /** Nesting depth (0 = root, increments per Task tool) */
  depth: number;
  /** True if this entry is part of a sidechain (collapsed sub-agent) */
  isSidechain?: boolean;
}

// ============================================================================
// Rich Block — ContentBlock with structural context attached
// ============================================================================

/**
 * A ContentBlock enriched with its structural context.
 *
 * Intersection type preserves discriminated union ergonomics —
 * `block.type` switching works as expected.
 */
export type RichBlock = ContentBlock & { context: BlockContext };

// ============================================================================
// Anchor Point — where a block renders in the UI
// ============================================================================

/**
 * Describes the rendering location for a block or tool.
 *
 * Used by tool views to know their placement context.
 */
export type AnchorPoint =
  | { type: 'main-thread' }
  | { type: 'task-tool'; parentId: string }
  | { type: 'tool-panel'; toolId: string }
  | { type: 'task-in-panel'; parentId: string };

// ============================================================================
// Render Run — grouping for consecutive blocks
// ============================================================================

/**
 * A render run is either a single block or a collapsed group of blocks.
 *
 * Used by the block renderer to handle coalescing of similar tool uses
 * (e.g., multiple Read calls collapsed into an expandable group).
 */
export type RenderRun =
  | { type: 'single'; block: RichBlock }
  | { type: 'collapsed-group'; blocks: RichBlock[] };

// ============================================================================
// Tool View Props — standard props passed to tool renderers
// ============================================================================

/**
 * Props passed to tool view components.
 *
 * Provides the tool_use block, its result (if resolved), status,
 * and anchor point for context-aware rendering.
 */
export interface ToolViewProps {
  /** The tool_use block (narrowed to tool_use type) */
  block: RichBlock & { type: 'tool_use' };
  /** The paired tool_result, if resolved */
  result: ToolResultBlock | undefined;
  /** Current status of the tool invocation */
  status: 'running' | 'complete' | 'error';
  /** Where this tool is being rendered */
  anchor: AnchorPoint;
  /** Rendered child content (for container tools like Task) */
  children?: ReactNode;
}

// ============================================================================
// Tool Definition — registry entry for a tool renderer
// ============================================================================

/**
 * Definition for a tool type's rendering behavior.
 *
 * Registered in a tool definition registry (future phase) to enable
 * dynamic dispatch to the appropriate renderer.
 */
export interface ToolDefinition {
  /** Tool name (e.g., "Bash", "Read") */
  name: string;
  /** Emoji icon for display */
  icon: string;
  /** Hex color for badge/accent */
  color: string;
  /** Activity verbs for status display */
  activity: { verb: string; pastVerb: string };
  /** View components for different display states */
  views: {
    collapsed?: (props: ToolViewProps) => ReactNode;
    compact: (props: ToolViewProps) => ReactNode;
    expanded: (props: ToolViewProps) => ReactNode;
  };
}

// ============================================================================
// Panel State — tool panel visibility management
// ============================================================================

/**
 * Actions that can affect panel state.
 */
export type PanelAction =
  | { type: 'TOOL_ARRIVED'; toolId: string }
  | { type: 'TOOL_LEFT_VIEW'; toolId: string }
  | { type: 'USER_CLICKED'; toolId: string }
  | { type: 'STREAM_STARTED'; toolId: string }
  | { type: 'STREAM_ENDED'; toolId: string };

/**
 * State for the tool detail panel.
 *
 * Tracks user pinning, recency, and streaming activity.
 */
export interface PanelState {
  /** User-pinned tool ID (takes priority over auto-selection) */
  userPinnedId: string | null;
  /** Most recently arrived tool ID (for auto-follow) */
  latestArrivedId: string | null;
  /** Set of tool IDs currently streaming */
  activeToolIds: Set<string>;
}
