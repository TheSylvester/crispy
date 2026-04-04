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
 * - Approval requests (previously useApprovalRequest)
 * - Streaming content (previously useStreamingContent)
 * - Context usage (previously useContextUsage, live portion)
 *
 * Each store subscribes to transport events once. React components read via
 * useSyncExternalStore for tear-free rendering.
 *
 * @module useChannelStore
 */

import { useSyncExternalStore, useEffect, useCallback } from 'react';
import type { TranscriptEntry, ContentBlock, ContextUsage } from '../../core/transcript.js';
import type { SessionChannelState } from '../../core/session-channel.js';
import type { ChannelCatchupMessage } from '../../core/channel-events.js';
import type { EntryMessage, EventMessage } from '../../core/agent-adapter.js';
import type { HostEvent } from '../../host/client-connection.js';
import type { ApprovalRequest } from '../components/approval/types.js';
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
  approvalRequest: ApprovalRequest | null;
  streamingContent: ContentBlock[] | null;
}

const EMPTY_SNAPSHOT: ChannelStoreSnapshot = {
  entries: [],
  channelState: null,
  lastError: null,
  contextUsage: null,
  approvalRequest: null,
  streamingContent: null,
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

      // Sync approval state from catchup
      if (catchup.pendingApprovals.length > 0) {
        const a = catchup.pendingApprovals[0];
        store.snapshot.approvalRequest = {
          toolUseId: a.toolUseId,
          toolName: a.toolName,
          input: a.input,
          reason: a.reason,
          options: a.options,
        };
      } else {
        store.snapshot.approvalRequest = null;
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
            // Turn ended — clear approval and streaming ghost
            store.snapshot.approvalRequest = null;
            store.snapshot.streamingContent = null;
            break;
          case 'awaiting_approval': {
            store.snapshot.channelState = 'awaiting_approval';
            // Extract approval details from the event
            const evt = inner as { toolUseId: string; toolName: string; input: unknown; reason?: string; options: Array<{ id: string; label: string; description?: string }> };
            store.snapshot.approvalRequest = {
              toolUseId: evt.toolUseId,
              toolName: evt.toolName,
              input: evt.input,
              reason: evt.reason,
              options: evt.options,
            };
            break;
          }
          case 'background':
            store.snapshot.channelState = 'background';
            store.snapshot.streamingContent = null;
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
          store.snapshot.approvalRequest = null;
          store.snapshot.streamingContent = null;
          emit(store);
          return;
        }
        if ((inner as { kind: string }).kind === 'streaming_content') {
          store.snapshot.streamingContent = (inner as unknown as { content: ContentBlock[] | null }).content;
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
  approvalRequest: ApprovalRequest | null;
  streamingContent: ContentBlock[] | null;
  /** Optimistically override the channel state (e.g. set 'streaming' on send). */
  setOptimistic: (state: SessionChannelState) => void;
  /** Clear the last error. */
  clearError: () => void;
  /** Clear the approval request (optimistic, e.g. after resolving). */
  clearApproval: () => void;
  /** Restore an approval request (e.g. on resolve failure). */
  setApproval: (req: ApprovalRequest | null) => void;
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

  const clearApproval = useCallback(() => {
    if (!sessionId) return;
    const store = manager.getStore(sessionId);
    if (store) {
      store.snapshot.approvalRequest = null;
      emit(store);
    }
  }, [sessionId, manager]);

  const setApproval = useCallback((req: ApprovalRequest | null) => {
    if (!sessionId) return;
    const store = manager.getStore(sessionId);
    if (store) {
      store.snapshot.approvalRequest = req;
      emit(store);
    }
  }, [sessionId, manager]);

  return {
    entries: snapshot.entries,
    channelState: snapshot.channelState,
    lastError: snapshot.lastError,
    contextUsage: snapshot.contextUsage,
    approvalRequest: snapshot.approvalRequest,
    streamingContent: snapshot.streamingContent,
    setOptimistic,
    clearError,
    clearApproval,
    setApproval,
  };
}
