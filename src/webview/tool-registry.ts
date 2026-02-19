/**
 * Tool Registry — external store for tool lifecycle state
 *
 * Manages the mapping between tool_use blocks (which appear in the stream)
 * and their eventual tool_result blocks (which arrive later). Components
 * subscribe to individual tool entries via useSyncExternalStore for
 * granular re-renders — no need to re-render the entire chat.
 *
 * Designed as a mutable singleton per session, held in a useRef by the
 * React provider. Pure TypeScript — no React dependency.
 *
 * @module webview/tool-registry
 */

import type {
  TranscriptEntry,
  ToolResultBlock,
  ContentBlock,
} from '../core/transcript.js';
import { getToolMeta, type ToolActivity } from './renderers/tools/shared/tool-metadata.js';

// Re-export ToolActivity for consumers that import from tool-registry
export type { ToolActivity };

// ============================================================================
// Tool Activity — verb classification for activity groups
// ============================================================================

const MCP_ACTIVITY_PATTERNS: [RegExp, ToolActivity][] = [
  [/search|list|get/, 'search'],
  [/fetch/, 'fetch'],
  [/read/, 'read'],
];

export function classifyToolActivity(name: string): ToolActivity {
  const known = getToolMeta(name).activity;
  if (known) return known;
  if (name.startsWith('mcp__')) {
    const lower = name.toLowerCase();
    for (const [pattern, activity] of MCP_ACTIVITY_PATTERNS) {
      if (pattern.test(lower)) return activity;
    }
    return 'invoke';
  }
  return 'invoke';
}

// ============================================================================
// ToolEntry — snapshot of a single tool invocation
// ============================================================================

export interface ToolEntry {
  id: string;                       // tool_use_id
  name: string;                     // "Bash", "Task", etc.
  input: Record<string, unknown>;
  status: 'running' | 'complete' | 'error';
  result?: ToolResultBlock;
  parentId: string | null;          // effective parent (parentTaskToolId takes priority)
  childIds: string[];               // children registered under this tool
  depth: number;                    // 0 = root
  agentId?: string;
  parentTaskToolId?: string;
  isTaskTool: boolean;              // name === 'Task'
  activity: ToolActivity;           // verb classification for display grouping
}

// ============================================================================
// ToolRegistry — the external store
// ============================================================================

export class ToolRegistry {
  // Canonical store
  private tools = new Map<string, ToolEntry>();

  // Results that arrived before their tool_use
  private orphanResults = new Map<string, ToolResultBlock>();

  // Per-tool subscribers (keyed by tool id)
  private toolListeners = new Map<string, Set<() => void>>();

  // Structural change subscribers (root list, new tools)
  private globalListeners = new Set<() => void>();

  // Stable reference for useSyncExternalStore — only replaced when roots change
  private _cachedRootIds: string[] = [];

  // Batch mode — defers notifications until batch completes
  private _batching = false;
  private _pendingToolNotifications = new Set<string>();
  private _pendingGlobalNotification = false;

  // Silent mode — collects dirty IDs for post-render flush
  private _silent = false;
  private _dirtyTools = new Set<string>();
  private _dirtyGlobal = false;

  // Status version — monotonic counter that increments on every resolveTool
  // or reset. Used by coalescing useMemo to re-run when tool statuses change.
  private _statusVersion = 0;
  private _statusListeners = new Set<() => void>();
  private _dirtyStatus = false;

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  registerTool(
    id: string,
    name: string,
    input: Record<string, unknown>,
    parentTaskToolId?: string,
    agentId?: string,
  ): void {
    // Idempotent — don't re-register
    if (this.tools.has(id)) return;

    // Compute depth and effective parent
    let parentId: string | null = null;
    let depth = 0;

    if (parentTaskToolId) {
      const parentEntry = this.tools.get(parentTaskToolId);
      if (parentEntry) {
        parentId = parentTaskToolId;
        depth = parentEntry.depth + 1;

        // Link child to parent (immutable swap)
        this.tools.set(parentTaskToolId, {
          ...parentEntry,
          childIds: [...parentEntry.childIds, id],
        });
        this.notifyTool(parentTaskToolId);
      }
    }

    let entry: ToolEntry = {
      id,
      name,
      input,
      status: 'running',
      parentId,
      childIds: [],
      depth,
      agentId,
      parentTaskToolId,
      isTaskTool: name === 'Task',
      activity: classifyToolActivity(name),
    };

    // Check orphan queue — result arrived before tool_use
    const orphan = this.orphanResults.get(id);
    if (orphan) {
      console.debug(`[ToolRegistry] Orphan resolved for ${id} (${name})`);
      this.orphanResults.delete(id);
      entry = {
        ...entry,
        result: orphan,
        status: orphan.is_error ? 'error' : 'complete',
      };
    }

    this.tools.set(id, entry);
    this.notifyTool(id);
    this.rebuildRootCache();
    this.notifyGlobal();
  }

  // --------------------------------------------------------------------------
  // Resolution
  // --------------------------------------------------------------------------

  resolveTool(toolUseId: string, result: ToolResultBlock): void {
    const entry = this.tools.get(toolUseId);

    if (!entry) {
      // Tool_use hasn't been registered yet — bank in orphan queue
      this.orphanResults.set(toolUseId, result);
      return;
    }

    // Immutable swap
    this.tools.set(toolUseId, {
      ...entry,
      result,
      status: result.is_error ? 'error' : 'complete',
    });

    this._statusVersion++;
    this.notifyTool(toolUseId);
    this.notifyStatus();
  }

  // --------------------------------------------------------------------------
  // Getters (snapshot functions for useSyncExternalStore)
  // --------------------------------------------------------------------------

  getToolEntry(id: string): ToolEntry | undefined {
    return this.tools.get(id);
  }

  getRootToolIds(): string[] {
    return this._cachedRootIds;
  }

  getToolCount(): number {
    return this.tools.size;
  }

  getOrphanCount(): number {
    return this.orphanResults.size;
  }

  /**
   * Monotonic counter that increments when any tool is resolved or the
   * registry is reset. Used as a useMemo dependency so coalescing re-runs
   * when tool statuses change (not just when new entries arrive).
   */
  getStatusVersion(): number {
    return this._statusVersion;
  }

  // --------------------------------------------------------------------------
  // Subscriptions
  // --------------------------------------------------------------------------

  subscribeStatus(callback: () => void): () => void {
    this._statusListeners.add(callback);
    return () => { this._statusListeners.delete(callback); };
  }

  subscribeTool(id: string, callback: () => void): () => void {
    let listeners = this.toolListeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.toolListeners.set(id, listeners);
    }
    listeners.add(callback);

    return () => {
      listeners!.delete(callback);
      if (listeners!.size === 0) {
        this.toolListeners.delete(id);
      }
    };
  }

  subscribeGlobal(callback: () => void): () => void {
    this.globalListeners.add(callback);
    return () => {
      this.globalListeners.delete(callback);
    };
  }

  // --------------------------------------------------------------------------
  // Batch mode — defer notifications during bulk operations
  // --------------------------------------------------------------------------

  batch(fn: () => void): void {
    this._batching = true;
    this._pendingToolNotifications.clear();
    this._pendingGlobalNotification = false;

    try {
      fn();
    } finally {
      this._batching = false;

      // Flush pending notifications
      for (const toolId of this._pendingToolNotifications) {
        const listeners = this.toolListeners.get(toolId);
        if (listeners) {
          for (const cb of listeners) cb();
        }
      }
      this._pendingToolNotifications.clear();

      if (this._pendingGlobalNotification) {
        this._pendingGlobalNotification = false;
        for (const cb of this.globalListeners) cb();
      }

      if (this._dirtyStatus) {
        this._dirtyStatus = false;
        for (const cb of this._statusListeners) cb();
      }
    }
  }

  // --------------------------------------------------------------------------
  // Silent mode — suppress notifications during render, flush post-commit
  // --------------------------------------------------------------------------

  /**
   * Process entries without firing subscriber notifications during render.
   *
   * Used during React's render phase where the registry must be populated
   * before children render, but firing notifications would cause
   * useSyncExternalStore to trigger re-render cascades mid-render.
   *
   * Newly-mounted components pick up state via getSnapshot() during their
   * own render. Already-mounted components (e.g. a TaskTool whose childIds
   * changed) need a post-render notification — dirty IDs are collected here
   * and flushed by the provider's useEffect via flushDirty().
   */
  silent(fn: () => void): void {
    this._batching = true;
    this._silent = true;
    this._pendingToolNotifications.clear();
    this._pendingGlobalNotification = false;

    try {
      fn();
    } finally {
      this._batching = false;
      this._silent = false;
      // Move pending notifications to dirty sets for post-render flush
      for (const id of this._pendingToolNotifications) {
        this._dirtyTools.add(id);
      }
      if (this._pendingGlobalNotification) {
        this._dirtyGlobal = true;
      }
      this._pendingToolNotifications.clear();
      this._pendingGlobalNotification = false;
    }
  }

  /**
   * Flush notifications that were suppressed during silent-mode render.
   * Called from useEffect (post-commit) so subscriber re-renders are safe.
   * Returns true if any notifications were flushed.
   */
  flushDirty(): boolean {
    if (this._dirtyTools.size === 0 && !this._dirtyGlobal && !this._dirtyStatus) return false;

    for (const toolId of this._dirtyTools) {
      const listeners = this.toolListeners.get(toolId);
      if (listeners) {
        for (const cb of listeners) cb();
      }
    }
    this._dirtyTools.clear();

    if (this._dirtyGlobal) {
      this._dirtyGlobal = false;
      for (const cb of this.globalListeners) cb();
    }

    if (this._dirtyStatus) {
      this._dirtyStatus = false;
      for (const cb of this._statusListeners) cb();
    }

    return true;
  }

  // --------------------------------------------------------------------------
  // Reset — called on session change
  // --------------------------------------------------------------------------

  /**
   * Clear all tool state. Pass `{ silent: true }` when calling during
   * React's render phase to suppress the global notification — children
   * will pick up the empty state via getSnapshot().
   */
  reset(opts?: { silent?: boolean }): void {
    this.tools.clear();
    this.orphanResults.clear();
    // Don't clear toolListeners or globalListeners — React components using
    // useSyncExternalStore keep references to their subscribe callbacks.
    // Clearing listeners would orphan surviving components during playback
    // rewind (where components stay mounted but registry state is rebuilt).
    this._cachedRootIds = [];
    this._batching = false;
    this._silent = false;
    this._pendingToolNotifications.clear();
    this._pendingGlobalNotification = false;
    this._dirtyTools.clear();
    this._dirtyGlobal = false;
    this._dirtyStatus = false;
    this._statusVersion++;
    if (!opts?.silent) {
      this.notifyGlobal();
      this.notifyStatus();
    }
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private notifyTool(id: string): void {
    if (this._batching) {
      this._pendingToolNotifications.add(id);
      return;
    }
    const listeners = this.toolListeners.get(id);
    if (listeners) {
      for (const cb of listeners) cb();
    }
  }

  private notifyGlobal(): void {
    if (this._batching) {
      this._pendingGlobalNotification = true;
      return;
    }
    for (const cb of this.globalListeners) cb();
  }

  private notifyStatus(): void {
    if (this._batching) {
      // Status notifications are deferred like global — they'll flush
      // via flushDirty() after render or at batch end.
      this._dirtyStatus = true;
      return;
    }
    for (const cb of this._statusListeners) cb();
  }

  private rebuildRootCache(): void {
    const roots: string[] = [];
    for (const entry of this.tools.values()) {
      if (entry.parentId === null) {
        roots.push(entry.id);
      }
    }
    // Only replace reference if contents changed
    if (
      roots.length !== this._cachedRootIds.length ||
      roots.some((id, i) => id !== this._cachedRootIds[i])
    ) {
      this._cachedRootIds = roots;
    }
  }
}

// ============================================================================
// Entry processor — bridge between transcript stream and registry
// ============================================================================

/**
 * Process a TranscriptEntry and register/resolve tools in the registry.
 *
 * - tool_use blocks → registerTool
 * - tool_result blocks → resolveTool (+ recurse into nested content)
 */
export function processEntryForRegistry(
  entry: TranscriptEntry,
  registry: ToolRegistry,
): void {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_use') {
      registry.registerTool(
        block.id,
        block.name,
        block.input as Record<string, unknown>,
        entry.parentToolUseID,
        entry.agentId,
      );
    } else if (block.type === 'tool_result') {
      registry.resolveTool(block.tool_use_id, block);

      // Recurse into nested content (Task tool results contain sub-agent blocks)
      if (Array.isArray(block.content)) {
        walkNestedContent(block.content, block.tool_use_id, registry, entry.agentId);
      }
    }
  }
}

/**
 * Walk nested content blocks within a tool_result, threading the parent
 * tool_use_id and agentId for tree linkage.
 */
function walkNestedContent(
  blocks: ContentBlock[],
  parentToolUseId: string,
  registry: ToolRegistry,
  agentId?: string,
): void {
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      registry.registerTool(
        block.id,
        block.name,
        block.input as Record<string, unknown>,
        parentToolUseId,
        agentId,
      );
    } else if (block.type === 'tool_result') {
      registry.resolveTool(block.tool_use_id, block);

      if (Array.isArray(block.content)) {
        walkNestedContent(block.content, block.tool_use_id, registry, agentId);
      }
    }
  }
}
