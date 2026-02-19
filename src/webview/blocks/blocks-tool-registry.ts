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

// ============================================================================
// BlocksToolRegistry — pairing-only external store
// ============================================================================

export class BlocksToolRegistry {
  /** Resolved results keyed by tool_use_id */
  private results = new Map<string, ToolResultBlock>();

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
   */
  register(toolUseId: string): void {
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
