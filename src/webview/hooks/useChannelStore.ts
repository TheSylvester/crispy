/**
 * useChannelStore — client-side stream interpreter for channel messages
 *
 * Reduces ChannelMessage | HistoryMessage | ChannelCatchupMessage into a
 * single ChannelStore state object. Uses useSyncExternalStore for efficient
 * re-renders — only affected components re-render when their slice changes.
 *
 * Pattern: Modeled after ToolRegistry's external store approach.
 *
 * @module useChannelStore
 */

import { useEffect, useSyncExternalStore, useCallback } from 'react';
import type { TranscriptEntry, ContextUsage } from '../../core/transcript.js';
import type { AdapterSettings, ChannelMessage } from '../../core/agent-adapter.js';
import type { ChannelCatchupMessage, HistoryMessage, PendingApprovalInfo } from '../../core/channel-events.js';
import { useTransport } from '../context/TransportContext.js';
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
}

const INITIAL_STATE: ChannelStore = {
  entries: [],
  channelState: 'unattached',
  approvalRequest: null,
  settings: null,
  contextUsage: null,
  sessionId: undefined,
  lastError: null,
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
}

// Global singleton
const storeManager = new ChannelStoreManager();

// ============================================================================
// React Hooks
// ============================================================================

/**
 * Core hook that subscribes to transport events and syncs with the store.
 * Components should prefer the selector hooks below for better performance.
 */
export function useChannelStore(sessionId: string | null): ChannelStore {
  const transport = useTransport();

  // Subscribe to transport events and dispatch to store
  useEffect(() => {
    if (sessionId === null) {
      // No session — reset to initial state
      storeManager.reset(sessionId);
      return;
    }

    const unsubscribe = transport.onEvent((sid, msg) => {
      if (sid === sessionId) {
        storeManager.dispatch(sessionId, msg as ChannelMessage | HistoryMessage | ChannelCatchupMessage);
      }
    });

    return unsubscribe;
  }, [sessionId, transport]);

  // Use useSyncExternalStore for React 18 concurrent mode compatibility
  return useSyncExternalStore(
    useCallback((listener) => storeManager.subscribe(sessionId, listener), [sessionId]),
    useCallback(() => storeManager.getSnapshot(sessionId), [sessionId]),
  );
}

// ============================================================================
// Selector Hooks — prevent re-render cascades
// ============================================================================

/** Get transcript entries for a session */
export function useEntries(sessionId: string | null): TranscriptEntry[] {
  const store = useChannelStore(sessionId);
  return store.entries;
}

/** Get channel state for a session */
export function useChannelState(sessionId: string | null): ChannelState {
  const store = useChannelStore(sessionId);
  return store.channelState;
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
