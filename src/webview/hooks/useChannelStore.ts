/**
 * useChannelStore — per-session external store via useSyncExternalStore
 *
 * ChannelStoreManager is a singleton: one store per session ID, shared across
 * all consumers. This eliminates the N-times subscription bug where multiple
 * React hooks each set up their own transport listener for the same session.
 *
 * Consolidates:
 * - Transcript entries (previously useTranscript)
 * - Channel state / session status (previously SessionStatusProvider)
 *
 * Each store subscribes to transport events once. React components read via
 * useSyncExternalStore for tear-free rendering.
 *
 * @module useChannelStore
 */

import { useSyncExternalStore, useEffect, useCallback } from 'react';
import type { TranscriptEntry, ContextUsage } from '../../core/transcript.js';
import type { SessionChannelState } from '../../core/session-channel.js';
import type { ChannelCatchupMessage } from '../../core/channel-events.js';
import type { EntryMessage, EventMessage } from '../../core/agent-adapter.js';
import type { HostEvent } from '../../host/client-connection.js';
import type { SessionService } from '../transport.js';
import { useTransport } from '../context/TransportContext.js';

// ============================================================================
// Store Shape
// ============================================================================

export interface ChannelStoreSnapshot {
  entries: TranscriptEntry[];
  channelState: SessionChannelState | null;
  lastError: string | null;
  contextUsage: ContextUsage | null;
}

const EMPTY_SNAPSHOT: ChannelStoreSnapshot = {
  entries: [],
  channelState: null,
  lastError: null,
  contextUsage: null,
};

// ============================================================================
// Per-Session Store
// ============================================================================

type Listener = () => void;

interface SessionStore {
  snapshot: ChannelStoreSnapshot;
  listeners: Set<Listener>;
  refCount: number;
  unsubscribeTransport: (() => void) | null;
  subscribed: boolean;
}

function emit(store: SessionStore): void {
  // Create new snapshot reference so useSyncExternalStore detects the change
  store.snapshot = { ...store.snapshot };
  for (const fn of store.listeners) fn();
}

/** Map catchup state string to SessionChannelState. */
function mapCatchupState(state: string): SessionChannelState {
  switch (state) {
    case 'idle':
    case 'streaming':
    case 'awaiting_approval':
    case 'unattached':
    case 'background':
      return state;
    case 'active':
      return 'streaming';
    default:
      return 'idle';
  }
}

// ============================================================================
// ChannelStoreManager — singleton per transport instance
// ============================================================================

const managers = new WeakMap<SessionService, ChannelStoreManager>();

class ChannelStoreManager {
  private stores = new Map<string, SessionStore>();
  private transport: SessionService;
  private globalUnsub: (() => void) | null = null;
  private activeStoreCount = 0;

  constructor(transport: SessionService) {
    this.transport = transport;
  }

  static for(transport: SessionService): ChannelStoreManager {
    let mgr = managers.get(transport);
    if (!mgr) {
      mgr = new ChannelStoreManager(transport);
      managers.set(transport, mgr);
    }
    return mgr;
  }

  /**
   * Get or create a store for a session. Increments refCount.
   * Caller must call release() when done.
   */
  acquire(sessionId: string): SessionStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = {
        snapshot: { ...EMPTY_SNAPSHOT },
        listeners: new Set(),
        refCount: 0,
        unsubscribeTransport: null,
        subscribed: false,
      };
      this.stores.set(sessionId, store);
    }
    store.refCount++;

    // First active store — attach global event listener
    this.activeStoreCount++;
    if (this.activeStoreCount === 1) {
      this.attachGlobalListener();
    }

    // Subscribe to transport for this session (once)
    if (!store.subscribed && !sessionId.startsWith('pending:')) {
      store.subscribed = true;
      this.transport.subscribe(sessionId).catch(() => {});
    }

    return store;
  }

  /**
   * Decrement refCount. When it hits 0, clean up the store.
   */
  release(sessionId: string): void {
    const store = this.stores.get(sessionId);
    if (!store) return;
    store.refCount--;
    this.activeStoreCount--;

    if (store.refCount <= 0) {
      this.stores.delete(sessionId);
      if (store.subscribed && !sessionId.startsWith('pending:')) {
        this.transport.unsubscribe(sessionId).catch(() => {});
      }
    }

    // Last active store — detach global listener
    if (this.activeStoreCount <= 0) {
      this.activeStoreCount = 0;
      this.detachGlobalListener();
    }
  }

  getStore(sessionId: string): SessionStore | undefined {
    return this.stores.get(sessionId);
  }

  private attachGlobalListener(): void {
    if (this.globalUnsub) return;
    this.globalUnsub = this.transport.onEvent((sid, event) => {
      this.handleEvent(sid, event);
    });
  }

  private detachGlobalListener(): void {
    if (this.globalUnsub) {
      this.globalUnsub();
      this.globalUnsub = null;
    }
  }

  private handleEvent(sessionId: string, event: HostEvent): void {
    const store = this.stores.get(sessionId);
    if (!store) return;

    if (event.type === 'catchup') {
      const catchup = event as ChannelCatchupMessage;

      if (catchup.entries.length > 0) {
        store.snapshot.entries = catchup.entries;
      }

      const mapped = mapCatchupState(catchup.state);
      // Don't let catchup downgrade an optimistic 'streaming' state.
      // The host re-subscribes on sendTurn, firing a catchup with 'idle'
      // before the adapter starts.
      if (!(store.snapshot.channelState === 'streaming' && (mapped === 'idle' || mapped === 'background'))) {
        store.snapshot.channelState = mapped;
      }

      if (catchup.contextUsage) {
        store.snapshot.contextUsage = catchup.contextUsage;
      }

      emit(store);
      return;
    }

    if (event.type === 'entry') {
      store.snapshot.entries = [...store.snapshot.entries, (event as EntryMessage).entry];
      emit(store);
      return;
    }

    if (event.type === 'event') {
      const inner = (event as EventMessage).event;

      if (inner.type === 'status') {
        switch (inner.status) {
          case 'active':
            store.snapshot.channelState = 'streaming';
            break;
          case 'idle':
            store.snapshot.channelState = 'idle';
            break;
          case 'awaiting_approval':
            store.snapshot.channelState = 'awaiting_approval';
            break;
          case 'background':
            store.snapshot.channelState = 'background';
            break;
        }
        emit(store);
        return;
      }

      if (inner.type === 'notification') {
        if (inner.kind === 'error') {
          const errVal = inner.error;
          store.snapshot.lastError = typeof errVal === 'string' ? errVal : errVal instanceof Error ? errVal.message : 'An unknown error occurred';
          emit(store);
          return;
        }
        if (inner.kind === 'session_rotated') {
          store.snapshot.entries = [];
          emit(store);
          return;
        }
      }
    }
  }
}

// ============================================================================
// React Hook
// ============================================================================

export interface UseChannelStoreResult {
  entries: TranscriptEntry[];
  channelState: SessionChannelState | null;
  lastError: string | null;
  contextUsage: ContextUsage | null;
  /** Optimistically override the channel state (e.g. set 'streaming' on send). */
  setOptimistic: (state: SessionChannelState) => void;
  /** Clear the last error. */
  clearError: () => void;
}

/**
 * Subscribe to a session's channel store. Returns transcript entries,
 * channel state, and error state — all derived from a single transport
 * listener shared across all consumers of this session ID.
 */
export function useChannelStore(sessionId: string | null): UseChannelStoreResult {
  const transport = useTransport();
  const manager = ChannelStoreManager.for(transport);

  // Acquire/release store on mount/unmount or sessionId change
  useEffect(() => {
    if (!sessionId) return;
    manager.acquire(sessionId);
    return () => manager.release(sessionId);
  }, [sessionId, manager]);

  const subscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (!sessionId) return () => {};
      const store = manager.getStore(sessionId);
      if (!store) return () => {};
      store.listeners.add(onStoreChange);
      return () => store.listeners.delete(onStoreChange);
    },
    [sessionId, manager],
  );

  const getSnapshot = useCallback((): ChannelStoreSnapshot => {
    if (!sessionId) return EMPTY_SNAPSHOT;
    return manager.getStore(sessionId)?.snapshot ?? EMPTY_SNAPSHOT;
  }, [sessionId, manager]);

  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const setOptimistic = useCallback(
    (state: SessionChannelState) => {
      if (!sessionId) return;
      const store = manager.getStore(sessionId);
      if (store) {
        store.snapshot.channelState = state;
        emit(store);
      }
    },
    [sessionId, manager],
  );

  const clearError = useCallback(() => {
    if (!sessionId) return;
    const store = manager.getStore(sessionId);
    if (store) {
      store.snapshot.lastError = null;
      emit(store);
    }
  }, [sessionId, manager]);

  return {
    entries: snapshot.entries,
    channelState: snapshot.channelState,
    lastError: snapshot.lastError,
    contextUsage: snapshot.contextUsage,
    setOptimistic,
    clearError,
  };
}
