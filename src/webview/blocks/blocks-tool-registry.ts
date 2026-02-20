/**
 * Blocks Tool Registry — slim pairing-only registry for blocks mode
 *
 * Manages the mapping between tool_use blocks and their tool_result blocks.
 * Unlike the full ToolRegistry, this registry ONLY handles pairing — no tree
 * structure, no depth tracking, no child relationships.
 *
 * Components subscribe via useSyncExternalStore for granular re-renders.
 *
 * @module webview/blocks/blocks-tool-registry
 */

import { useSyncExternalStore } from 'react';
import type { ToolResultBlock } from '../../core/transcript.js';
import type { RichBlock } from './types.js';

// ============================================================================
// BlocksToolRegistry — pairing-only external store
// ============================================================================

export class BlocksToolRegistry {
  /** Resolved results keyed by tool_use_id */
  private results = new Map<string, ToolResultBlock>();

  /** Tool name keyed by tool_use_id (e.g., "Bash", "Read") */
  private names = new Map<string, string>();

  /** RichBlock data keyed by tool_use_id — stored for panel expanded views */
  private blocks = new Map<string, RichBlock>();

  /** Registered tool_use IDs awaiting their result */
  private pending = new Set<string>();

  /** Results that arrived before their tool_use was registered */
  private orphans = new Map<string, ToolResultBlock>();

  /** Per-tool subscribers for useSyncExternalStore */
  private subscribers = new Map<string, Set<() => void>>();

  /** Dirty tool IDs collected during silent mode */
  private dirtyIds = new Set<string>();

  /** When true, notifications are deferred to dirtyIds */
  private silentMode = false;

  // --------------------------------------------------------------------------
  // Registration
  // --------------------------------------------------------------------------

  /**
   * Register a tool_use as awaiting its result.
   *
   * If a result was previously orphaned (arrived before registration),
   * it will be immediately paired.
   *
   * @param toolUseId - The tool_use block ID (UUID)
   * @param toolName - The tool name (e.g., "Bash", "Read") for definition lookups
   * @param block - Optional RichBlock data for panel expanded views
   */
  register(toolUseId: string, toolName?: string, block?: RichBlock): void {
    // Store block BEFORE the idempotent early-return so re-registration
    // updates the block (e.g., on playback rewind reprocessing)
    if (block) {
      this.blocks.set(toolUseId, block);
    }

    // Store name mapping (even on re-register, in case name was missing before)
    if (toolName && !this.names.has(toolUseId)) {
      this.names.set(toolUseId, toolName);
    }

    // Idempotent — don't re-register
    if (this.pending.has(toolUseId) || this.results.has(toolUseId)) {
      return;
    }

    // Check orphan queue — result arrived before tool_use
    const orphan = this.orphans.get(toolUseId);
    if (orphan) {
      this.orphans.delete(toolUseId);
      this.results.set(toolUseId, orphan);
      this.notify(toolUseId);
    } else {
      this.pending.add(toolUseId);
    }
  }

  // --------------------------------------------------------------------------
  // Resolution
  // --------------------------------------------------------------------------

  /**
   * Pair a tool_result with its tool_use.
   *
   * If the tool_use hasn't been registered yet, the result is queued
   * as an orphan and will be paired on the next register() call.
   */
  resolve(toolUseId: string, result: ToolResultBlock): void {
    // Already resolved — idempotent
    if (this.results.has(toolUseId)) {
      return;
    }

    if (this.pending.has(toolUseId)) {
      // Normal path — tool_use was registered, now we have the result
      this.pending.delete(toolUseId);
      this.results.set(toolUseId, result);
      this.notify(toolUseId);
    } else {
      // Result arrived before tool_use — queue as orphan
      this.orphans.set(toolUseId, result);
    }
  }

  // --------------------------------------------------------------------------
  // Getters
  // --------------------------------------------------------------------------

  /**
   * Get the result for a tool_use, if resolved.
   */
  getResult(toolUseId: string): ToolResultBlock | undefined {
    return this.results.get(toolUseId);
  }

  /**
   * Get the tool name for a tool_use_id (e.g., "Bash", "Read").
   * Returns undefined if the tool hasn't been registered with a name.
   */
  getName(toolUseId: string): string | undefined {
    return this.names.get(toolUseId);
  }

  /**
   * Get the RichBlock data for a tool_use_id.
   * Returns undefined if the tool hasn't been registered with a block.
   */
  getBlock(toolUseId: string): RichBlock | undefined {
    return this.blocks.get(toolUseId);
  }

  /**
   * Check if a tool is still pending (registered but no result yet).
   */
  isPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }

  /**
   * React hook that subscribes to a specific tool's block data.
   *
   * Re-renders only when this specific tool's block is stored.
   */
  useBlock(toolUseId: string): RichBlock | undefined {
    return useSyncExternalStore(
      (callback) => this.subscribeTool(toolUseId, callback),
      () => this.getBlock(toolUseId),
      () => this.getBlock(toolUseId),
    );
  }

  /**
   * React hook that subscribes to a specific tool's result.
   *
   * Re-renders only when this specific tool's result arrives.
   */
  useResult(toolUseId: string): ToolResultBlock | undefined {
    return useSyncExternalStore(
      (callback) => this.subscribeTool(toolUseId, callback),
      () => this.getResult(toolUseId),
      () => this.getResult(toolUseId),
    );
  }

  // --------------------------------------------------------------------------
  // Subscription
  // --------------------------------------------------------------------------

  /**
   * Subscribe to changes for a specific tool.
   *
   * Returns an unsubscribe function.
   */
  subscribeTool(toolUseId: string, callback: () => void): () => void {
    let listeners = this.subscribers.get(toolUseId);
    if (!listeners) {
      listeners = new Set();
      this.subscribers.set(toolUseId, listeners);
    }
    listeners.add(callback);

    return () => {
      listeners!.delete(callback);
      if (listeners!.size === 0) {
        this.subscribers.delete(toolUseId);
      }
    };
  }

  // --------------------------------------------------------------------------
  // Silent mode — suppress notifications during render
  // --------------------------------------------------------------------------

  /**
   * Execute a function without firing subscriber notifications.
   *
   * Used during React's render phase where the registry must be populated
   * before children render, but firing notifications would cause
   * useSyncExternalStore to trigger re-render cascades mid-render.
   *
   * Dirty IDs are collected and can be flushed via flushDirty().
   */
  silent(fn: () => void): void {
    this.silentMode = true;
    try {
      fn();
    } finally {
      this.silentMode = false;
    }
  }

  /**
   * Flush notifications that were suppressed during silent mode.
   *
   * Called from useEffect (post-commit) so subscriber re-renders are safe.
   * Returns true if any notifications were flushed.
   */
  flushDirty(): boolean {
    if (this.dirtyIds.size === 0) return false;

    for (const toolUseId of this.dirtyIds) {
      const listeners = this.subscribers.get(toolUseId);
      if (listeners) {
        for (const cb of listeners) cb();
      }
    }
    this.dirtyIds.clear();
    return true;
  }

  // --------------------------------------------------------------------------
  // Reset — called on session change
  // --------------------------------------------------------------------------

  /**
   * Clear all state. Called when switching sessions.
   */
  reset(): void {
    this.results.clear();
    this.names.clear();
    this.blocks.clear();
    this.pending.clear();
    this.orphans.clear();
    this.dirtyIds.clear();
    this.silentMode = false;
    // Don't clear subscribers — React components keep references
  }

  // --------------------------------------------------------------------------
  // Internal helpers
  // --------------------------------------------------------------------------

  private notify(toolUseId: string): void {
    if (this.silentMode) {
      this.dirtyIds.add(toolUseId);
      return;
    }

    const listeners = this.subscribers.get(toolUseId);
    if (listeners) {
      for (const cb of listeners) cb();
    }
  }
}
