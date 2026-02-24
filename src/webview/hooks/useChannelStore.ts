/**
 * useChannelStore — single source of truth for per-session state
 *
 * Reduces ChannelMessage | HistoryMessage | ChannelCatchupMessage into a
 * single ChannelStore state object. Uses useSyncExternalStore for efficient
 * re-renders — only affected components re-render when their slice changes.
 *
 * Also owns the subscribe/load lifecycle via connectSession(), replacing the
 * old useTranscript hook. And provides the channel-state selector with
 * setOptimistic, replacing the old useSessionStatus hook.
 *
 * Pattern: Modeled after ToolRegistry's external store approach.
 *
 * @module useChannelStore
 */

import { useEffect, useRef, useSyncExternalStore, useCallback } from 'react';
import type { TranscriptEntry, ContextUsage } from '../../core/transcript.js';
import type { AdapterSettings, ChannelMessage } from '../../core/agent-adapter.js';
import type { ChannelCatchupMessage, HistoryMessage, PendingApprovalInfo } from '../../core/channel-events.js';
import { useTransport } from '../context/TransportContext.js';
import type { SessionService } from '../transport.js';
import type { ApprovalRequest } from '../components/approval/types.js';

// ============================================================================
// Channel Store — the state shape
// ============================================================================

export type ChannelState = 'unattached' | 'idle' | 'streaming' | 'awaiting_approval';

export interface ChannelStore {
  entries: TranscriptEntry[];
  channelState: ChannelState;
  approvalRequest: ApprovalRequest | null;
  settings: AdapterSettings | null;
  contextUsage: ContextUsage | null;
  sessionId: string | undefined;
  /** Error message from the last error event */
  lastError: string | null;
  /** True while subscribe + loadSession is in flight */
  isLoading: boolean;
  /** Error from the subscribe/load lifecycle (not agent errors) */
  error: string | null;
}

const INITIAL_STATE: ChannelStore = {
  entries: [],
  channelState: 'unattached',
  approvalRequest: null,
  settings: null,
  contextUsage: null,
  sessionId: undefined,
  lastError: null,
  isLoading: false,
  error: null,
};

// ============================================================================
// Message Reducer
// ============================================================================

function pendingApprovalToRequest(approval: PendingApprovalInfo): ApprovalRequest {
  return {
    toolUseId: approval.toolUseId,
    toolName: approval.toolName,
    input: approval.input,
    reason: approval.reason,
    options: approval.options,
  };
}

function reduceMessage(
  state: ChannelStore,
  msg: ChannelMessage | HistoryMessage | ChannelCatchupMessage,
): ChannelStore {
  switch (msg.type) {
    case 'entry': {
      // Dedup: if the incoming entry is a user message and the last entry is
      // an optimistic placeholder, replace it with the real backend echo.
      const entries = state.entries;
      const last = entries[entries.length - 1];
      if (
        msg.entry.type === 'user' &&
        last?.uuid?.startsWith('optimistic-')
      ) {
        return { ...state, entries: [...entries.slice(0, -1), msg.entry] };
      }
      return { ...state, entries: [...entries, msg.entry] };
    }

    case 'history':
      return { ...state, entries: msg.entries };

    case 'catchup': {
      // Map catchup state to ChannelState
      let channelState: ChannelState;
      if (msg.state === 'idle') channelState = 'idle';
      else if (msg.state === 'active' || msg.state === 'streaming') channelState = 'streaming';
      else if (msg.state === 'awaiting_approval') channelState = 'awaiting_approval';
      else channelState = 'unattached';

      // Extract first pending approval for display
      const approvalRequest = msg.pendingApprovals.length > 0
        ? pendingApprovalToRequest(msg.pendingApprovals[0])
        : null;

      return {
        ...state,
        channelState,
        sessionId: msg.sessionId,
        settings: msg.settings,
        contextUsage: msg.contextUsage,
        approvalRequest,
      };
    }

    case 'event': {
      const event = msg.event;

      if (event.type === 'status') {
        switch (event.status) {
          case 'active':
            return { ...state, channelState: 'streaming' };

          case 'idle':
            return {
              ...state,
              channelState: 'idle',
              approvalRequest: null,
            };

          case 'awaiting_approval':
            return {
              ...state,
              channelState: 'awaiting_approval',
              approvalRequest: {
                toolUseId: event.toolUseId,
                toolName: event.toolName,
                input: event.input,
                reason: event.reason,
                options: event.options,
              },
            };
        }
      }

      if (event.type === 'notification') {
        switch (event.kind) {
          case 'session_changed':
            return { ...state, sessionId: event.sessionId };

          case 'permission_mode_changed':
            return {
              ...state,
              settings: state.settings
                ? { ...state.settings, permissionMode: event.mode }
                : null,
            };

          case 'settings_changed':
            return { ...state, settings: event.settings };

          case 'error':
            return {
              ...state,
              lastError: typeof event.error === 'string'
                ? event.error
                : event.error.message,
            };

          case 'compacting':
            // No state change for compacting notification
            return state;
        }
      }

      return state;
    }
  }

  return state;
}

// ============================================================================
// Store Factory — per-session external stores
// ============================================================================

interface StoreInstance {
  state: ChannelStore;
  listeners: Set<() => void>;
}

class ChannelStoreManager {
  private stores = new Map<string | null, StoreInstance>();

  private getOrCreate(sessionId: string | null): StoreInstance {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = {
        state: { ...INITIAL_STATE },
        listeners: new Set(),
      };
      this.stores.set(sessionId, store);
    }
    return store;
  }

  subscribe(sessionId: string | null, listener: () => void): () => void {
    const store = this.getOrCreate(sessionId);
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
      // Clean up empty stores (optional optimization)
      if (store.listeners.size === 0 && store.state === INITIAL_STATE) {
        this.stores.delete(sessionId);
      }
    };
  }

  getSnapshot(sessionId: string | null): ChannelStore {
    return this.stores.get(sessionId)?.state ?? INITIAL_STATE;
  }

  dispatch(sessionId: string | null, msg: ChannelMessage | HistoryMessage | ChannelCatchupMessage): void {
    const store = this.getOrCreate(sessionId);
    const next = reduceMessage(store.state, msg);
    if (next !== store.state) {
      store.state = next;
      // Notify listeners
      for (const listener of store.listeners) {
        listener();
      }
    }
  }

  /** Add an optimistic entry to the store */
  addOptimisticEntry(sessionId: string | null, entry: TranscriptEntry): void {
    const store = this.getOrCreate(sessionId);
    store.state = {
      ...store.state,
      entries: [...store.state.entries, entry],
    };
    for (const listener of store.listeners) {
      listener();
    }
  }

  /** Reset store for a session (e.g., on session change) */
  reset(sessionId: string | null): void {
    const store = this.stores.get(sessionId);
    if (store) {
      store.state = { ...INITIAL_STATE };
      for (const listener of store.listeners) {
        listener();
      }
    }
  }

  /** Set fork history entries directly */
  setForkHistory(sessionId: string | null, entries: TranscriptEntry[]): void {
    const store = this.getOrCreate(sessionId);
    store.state = {
      ...store.state,
      entries,
    };
    for (const listener of store.listeners) {
      listener();
    }
  }

  /** Clear approval request (for optimistic UI after resolve) */
  clearApproval(sessionId: string | null): void {
    const store = this.stores.get(sessionId);
    if (store && store.state.approvalRequest) {
      store.state = {
        ...store.state,
        approvalRequest: null,
      };
      for (const listener of store.listeners) {
        listener();
      }
    }
  }

  /** Set optimistic channel state */
  setOptimisticState(sessionId: string | null, channelState: ChannelState): void {
    const store = this.getOrCreate(sessionId);
    store.state = {
      ...store.state,
      channelState,
    };
    for (const listener of store.listeners) {
      listener();
    }
  }

  /** Set isLoading flag */
  setLoading(sessionId: string | null, isLoading: boolean): void {
    const store = this.getOrCreate(sessionId);
    if (store.state.isLoading === isLoading) return;
    store.state = { ...store.state, isLoading };
    for (const listener of store.listeners) {
      listener();
    }
  }

  /** Set error from subscribe/load lifecycle */
  setError(sessionId: string | null, error: string | null): void {
    const store = this.getOrCreate(sessionId);
    if (store.state.error === error) return;
    store.state = { ...store.state, error };
    for (const listener of store.listeners) {
      listener();
    }
  }

  /**
   * connectSession — subscribe to transport events, load history.
   *
   * Handles:
   * - Pending sessions (skip subscribe/load — host sets up the subscription)
   * - Pending→real transitions (preserve entries, skip destructive reload)
   * - Normal sessions (subscribe + loadSession, merge optimistic entries)
   *
   * Returns a cleanup function that removes the event listener and unsubscribes.
   */
  connectSession(
    sessionId: string,
    prevSessionId: string | null,
    transport: SessionService,
  ): () => void {
    let unmounted = false;

    // Clear stale entries immediately so optimistic messages from a
    // previous session never bleed into the newly selected one.
    // Skip the clear for pending→real transitions (entries are already correct).
    if (!prevSessionId?.startsWith('pending:') && !sessionId.startsWith('pending:')) {
      const store = this.getOrCreate(sessionId);
      store.state = { ...store.state, entries: [] };
      for (const listener of store.listeners) {
        listener();
      }
    }

    // Listen for live events — dispatched into the store's reducer
    const off = transport.onEvent((sid, msg) => {
      if (unmounted || sid !== sessionId) return;
      this.dispatch(sessionId, msg as ChannelMessage | HistoryMessage | ChannelCatchupMessage);
    });

    // Load lifecycle
    const load = async () => {
      // Skip subscribe/loadSession for pending sessions — the subscription
      // is already set up by createSession on the host side.
      if (sessionId.startsWith('pending:')) {
        this.setLoading(sessionId, false);
        return;
      }

      // Pending→real transition: the previous session was a pending placeholder
      // that has now resolved to its real ID. The event stream is already active
      // (the host re-keys the channel), so entries and optimistic messages are
      // already in state. Skip the destructive load cycle to preserve them.
      if (prevSessionId?.startsWith('pending:')) {
        this.setLoading(sessionId, false);
        return;
      }

      this.setLoading(sessionId, true);
      this.setError(sessionId, null);

      try {
        // Subscribe first so we don't miss events between load and subscribe
        await transport.subscribe(sessionId);
        if (unmounted) return;

        // Load full history — overwrites any early events from subscription backfill.
        // Preserve optimistic entries that haven't been echoed yet.
        const history = await transport.loadSession(sessionId);
        if (unmounted) return;

        const store = this.getOrCreate(sessionId);
        const optimistic = store.state.entries.filter(
          (e) => e.uuid?.startsWith('optimistic-') && e.sessionId === sessionId,
        );
        const entries = optimistic.length === 0 ? history : [...history, ...optimistic];
        store.state = { ...store.state, entries };
        for (const listener of store.listeners) {
          listener();
        }
      } catch (err) {
        if (unmounted) return;
        this.setError(sessionId, err instanceof Error ? err.message : String(err));
      } finally {
        if (!unmounted) {
          this.setLoading(sessionId, false);
        }
      }
    };

    load();

    return () => {
      unmounted = true;
      off();
      // Skip unsubscribe for pending sessions — they weren't subscribed via transport
      if (!sessionId.startsWith('pending:')) {
        transport.unsubscribe(sessionId).catch(() => {
          // Best-effort unsubscribe
        });
      }
    };
  }
}

// Global singleton
const storeManager = new ChannelStoreManager();

// ============================================================================
// React Hooks
// ============================================================================

/**
 * Read-only hook that reads from the ChannelStoreManager external store.
 *
 * Does NOT subscribe to transport events — that's `useSessionData`'s job
 * via `connectSession()`. Every component tree that renders entries MUST
 * have exactly one `useSessionData` call for the session. All other
 * components (StopButton, ThinkingIndicator, ControlPanel, etc.) use
 * the selector hooks below which delegate to this hook.
 *
 * Previously this hook also set up a `transport.onEvent` listener, which
 * caused N×dispatch when N components called it for the same session —
 * the root cause of the 7× entry duplication bug.
 */
export function useChannelStore(sessionId: string | null): ChannelStore {
  // Use useSyncExternalStore for React 18 concurrent mode compatibility
  return useSyncExternalStore(
    useCallback((listener) => storeManager.subscribe(sessionId, listener), [sessionId]),
    useCallback(() => storeManager.getSnapshot(sessionId), [sessionId]),
  );
}

/**
 * useSessionData — full lifecycle hook that replaces useTranscript.
 *
 * Manages: subscribe → loadSession → entries + isLoading + error,
 * with pending→real session transition detection.
 *
 * Returns the full ChannelStore plus imperative helpers for optimistic
 * entries and fork history.
 */
export interface UseSessionDataResult {
  entries: TranscriptEntry[];
  isLoading: boolean;
  error: string | null;
  /** Inject a synthetic user entry for immediate rendering before backend echo. */
  addOptimisticEntry: (entry: TranscriptEntry) => void;
  /** Bulk-set entries for fork history preload. Replaces all entries including optimistic. */
  setForkHistory: (entries: TranscriptEntry[]) => void;
}

export function useSessionData(sessionId: string | null): UseSessionDataResult {
  const transport = useTransport();

  // Track previous sessionId to detect pending→real transitions
  const prevSessionIdRef = useRef<string | null>(null);

  // Connect the session: event listener + subscribe/load lifecycle
  useEffect(() => {
    const prevSessionId = prevSessionIdRef.current;
    prevSessionIdRef.current = sessionId;

    if (!sessionId) {
      storeManager.reset(sessionId);
      return;
    }

    return storeManager.connectSession(sessionId, prevSessionId, transport);
  }, [sessionId, transport]);

  // Read from the external store
  const store = useSyncExternalStore(
    useCallback((listener) => storeManager.subscribe(sessionId, listener), [sessionId]),
    useCallback(() => storeManager.getSnapshot(sessionId), [sessionId]),
  );

  // Stable imperative callbacks bound to the current sessionId
  const addOptimistic = useCallback(
    (entry: TranscriptEntry) => storeManager.addOptimisticEntry(sessionId, entry),
    [sessionId],
  );

  const setFork = useCallback(
    (entries: TranscriptEntry[]) => storeManager.setForkHistory(sessionId, entries),
    [sessionId],
  );

  return {
    entries: store.entries,
    isLoading: store.isLoading,
    error: store.error,
    addOptimisticEntry: addOptimistic,
    setForkHistory: setFork,
  };
}

// ============================================================================
// Selector Hooks — prevent re-render cascades
// ============================================================================

/** Get transcript entries for a session */
export function useEntries(sessionId: string | null): TranscriptEntry[] {
  const store = useChannelStore(sessionId);
  return store.entries;
}

/** Return value for useChannelState — matches the old useSessionStatus API */
export interface ChannelStateValue {
  channelState: ChannelState | null;
  /** Optimistically override the channel state (e.g. set 'streaming' on send). */
  setOptimistic: (state: ChannelState) => void;
}

/**
 * Get channel state for a session, with setOptimistic for ControlPanel.
 * Drop-in replacement for the old useSessionStatus.useChannelState.
 */
export function useChannelState(sessionId: string | null): ChannelStateValue {
  const store = useChannelStore(sessionId);

  const setOptimistic = useCallback(
    (state: ChannelState) => storeManager.setOptimisticState(sessionId, state),
    [sessionId],
  );

  return {
    channelState: sessionId ? store.channelState : null,
    setOptimistic,
  };
}

/** Get current approval request for a session */
export function useApproval(sessionId: string | null): ApprovalRequest | null {
  const store = useChannelStore(sessionId);
  return store.approvalRequest;
}

/** Get context usage for a session */
export function useContextUsage(sessionId: string | null): ContextUsage | null {
  const store = useChannelStore(sessionId);
  return store.contextUsage;
}

/** Get adapter settings for a session */
export function useSettings(sessionId: string | null): AdapterSettings | null {
  const store = useChannelStore(sessionId);
  return store.settings;
}

/** Get last error for a session */
export function useLastError(sessionId: string | null): string | null {
  const store = useChannelStore(sessionId);
  return store.lastError;
}

// ============================================================================
// Imperative API — for ControlPanel and other components that need to
// modify state without going through transport
// ============================================================================

/** Add an optimistic entry (for immediate user message display) */
export function addOptimisticEntry(sessionId: string | null, entry: TranscriptEntry): void {
  storeManager.addOptimisticEntry(sessionId, entry);
}

/** Set fork history entries */
export function setForkHistory(sessionId: string | null, entries: TranscriptEntry[]): void {
  storeManager.setForkHistory(sessionId, entries);
}

/** Reset store for a session */
export function resetStore(sessionId: string | null): void {
  storeManager.reset(sessionId);
}

/** Clear approval request optimistically */
export function clearApproval(sessionId: string | null): void {
  storeManager.clearApproval(sessionId);
}

/** Set optimistic channel state (e.g., 'streaming' on send) */
export function setOptimisticChannelState(sessionId: string | null, state: ChannelState): void {
  storeManager.setOptimisticState(sessionId, state);
}
