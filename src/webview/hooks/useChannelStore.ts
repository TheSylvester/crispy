/**
 * useChannelStore — per-session external store via useSyncExternalStore
 *
 * ChannelStoreManager is a singleton: one store per session ID, shared across
 * all consumers. Transport subscriptions and entries are shared; mutable UI
 * state (channelState, approvalRequest, streamingContent, lastError) is
 * per-consumer so that two tabs showing the same session don't interfere.
 *
 * @module useChannelStore
 */

import { useSyncExternalStore, useEffect, useCallback, useMemo, useState, useRef } from 'react';
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

/** Shared read-only data (same reference across all consumers of a session). */
interface SharedSnapshot {
  entries: TranscriptEntry[];
  contextUsage: ContextUsage | null;
}

/** Per-consumer mutable UI state (independent per useChannelStore call). */
interface MutableState {
  channelState: SessionChannelState | null;
  lastError: string | null;
  approvalRequest: ApprovalRequest | null;
  streamingContent: ContentBlock[] | null;
}

export interface ChannelStoreSnapshot {
  entries: TranscriptEntry[];
  channelState: SessionChannelState | null;
  lastError: string | null;
  contextUsage: ContextUsage | null;
  approvalRequest: ApprovalRequest | null;
  streamingContent: ContentBlock[] | null;
}

const EMPTY_SHARED: SharedSnapshot = { entries: [], contextUsage: null };

const EMPTY_MUTABLE: MutableState = {
  channelState: null,
  lastError: null,
  approvalRequest: null,
  streamingContent: null,
};

// ============================================================================
// Per-Session Store
// ============================================================================

type Listener = () => void;

interface SessionStore {
  /** Shared read-only snapshot (entries + contextUsage). */
  snapshot: SharedSnapshot;
  /** Listeners for snapshot changes (useSyncExternalStore). */
  snapshotListeners: Set<Listener>;

  /** Latest transport-derived mutable state. Consumers copy to local state. */
  channelState: SessionChannelState | null;
  lastError: string | null;
  approvalRequest: ApprovalRequest | null;
  streamingContent: ContentBlock[] | null;
  /** Listeners for mutable state changes (per-consumer useState sync). */
  stateListeners: Set<Listener>;

  refCount: number;
  subscribed: boolean;
}

function emitSnapshot(store: SessionStore): void {
  store.snapshot = { ...store.snapshot };
  for (const fn of store.snapshotListeners) fn();
}

function emitState(store: SessionStore): void {
  for (const fn of store.stateListeners) fn();
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

  acquire(sessionId: string): SessionStore {
    let store = this.stores.get(sessionId);
    if (!store) {
      store = {
        snapshot: { ...EMPTY_SHARED },
        snapshotListeners: new Set(),
        channelState: null,
        lastError: null,
        approvalRequest: null,
        streamingContent: null,
        stateListeners: new Set(),
        refCount: 0,
        subscribed: false,
      };
      this.stores.set(sessionId, store);
    }
    store.refCount++;

    this.activeStoreCount++;
    if (this.activeStoreCount === 1) {
      this.attachGlobalListener();
    }

    if (!store.subscribed && !sessionId.startsWith('pending:')) {
      store.subscribed = true;
      this.transport.subscribe(sessionId).catch(() => {});
    }

    return store;
  }

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
      let snapshotChanged = false;

      if (catchup.entries.length > 0) {
        store.snapshot.entries = catchup.entries;
        snapshotChanged = true;
      }

      if (catchup.contextUsage) {
        store.snapshot.contextUsage = catchup.contextUsage;
        snapshotChanged = true;
      }

      // Update transport-derived mutable state
      store.channelState = mapCatchupState(catchup.state);

      if (catchup.pendingApprovals.length > 0) {
        const a = catchup.pendingApprovals[0];
        store.approvalRequest = {
          toolUseId: a.toolUseId,
          toolName: a.toolName,
          input: a.input,
          reason: a.reason,
          options: a.options,
        };
      } else {
        store.approvalRequest = null;
      }

      if (snapshotChanged) emitSnapshot(store);
      emitState(store);
      return;
    }

    if (event.type === 'entry') {
      store.snapshot.entries = [...store.snapshot.entries, (event as EntryMessage).entry];
      emitSnapshot(store);
      return;
    }

    if (event.type === 'event') {
      const inner = (event as EventMessage).event;

      if (inner.type === 'status') {
        switch (inner.status) {
          case 'active':
            store.channelState = 'streaming';
            break;
          case 'idle':
            store.channelState = 'idle';
            store.approvalRequest = null;
            store.streamingContent = null;
            break;
          case 'awaiting_approval': {
            store.channelState = 'awaiting_approval';
            const evt = inner as { toolUseId: string; toolName: string; input: unknown; reason?: string; options: Array<{ id: string; label: string; description?: string }> };
            store.approvalRequest = {
              toolUseId: evt.toolUseId,
              toolName: evt.toolName,
              input: evt.input,
              reason: evt.reason,
              options: evt.options,
            };
            break;
          }
          case 'background':
            store.channelState = 'background';
            store.streamingContent = null;
            break;
        }
        emitState(store);
        return;
      }

      if (inner.type === 'notification') {
        if (inner.kind === 'error') {
          const errVal = inner.error;
          store.lastError = typeof errVal === 'string' ? errVal : errVal instanceof Error ? errVal.message : 'An unknown error occurred';
          emitState(store);
          return;
        }
        if (inner.kind === 'session_rotated') {
          store.snapshot.entries = [];
          store.approvalRequest = null;
          store.streamingContent = null;
          emitSnapshot(store);
          emitState(store);
          return;
        }
        if ((inner as { kind: string }).kind === 'streaming_content') {
          store.streamingContent = (inner as unknown as { content: ContentBlock[] | null }).content;
          emitState(store);
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
 * channel state, and error state. Entries and contextUsage are shared
 * across all consumers of the same session ID; mutable UI state
 * (channelState, approvalRequest, streamingContent, lastError) is
 * per-consumer so tabs don't interfere with each other.
 */
export function useChannelStore(sessionId: string | null): UseChannelStoreResult {
  const transport = useTransport();
  const manager = useMemo(() => ChannelStoreManager.for(transport), [transport]);

  // Acquire/release store on mount/unmount or sessionId change
  useEffect(() => {
    if (!sessionId) return;
    manager.acquire(sessionId);
    return () => manager.release(sessionId);
  }, [sessionId, manager]);

  // --- Shared entries/contextUsage via useSyncExternalStore ---

  const snapshotSubscribe = useCallback(
    (onStoreChange: () => void): (() => void) => {
      if (!sessionId) return () => {};
      const store = manager.getStore(sessionId);
      if (!store) return () => {};
      store.snapshotListeners.add(onStoreChange);
      return () => store.snapshotListeners.delete(onStoreChange);
    },
    [sessionId, manager],
  );

  const getSnapshot = useCallback((): SharedSnapshot => {
    if (!sessionId) return EMPTY_SHARED;
    return manager.getStore(sessionId)?.snapshot ?? EMPTY_SHARED;
  }, [sessionId, manager]);

  const shared = useSyncExternalStore(snapshotSubscribe, getSnapshot, getSnapshot);

  // --- Per-consumer mutable UI state ---

  const [localState, setLocalState] = useState<MutableState>(EMPTY_MUTABLE);
  const optimisticRef = useRef<SessionChannelState | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setLocalState(EMPTY_MUTABLE);
      optimisticRef.current = null;
      return;
    }
    const store = manager.getStore(sessionId);
    if (!store) return;

    const sync = () => {
      setLocalState(prev => {
        // Guard: don't let transport downgrade an optimistic 'streaming'
        const transportChannel = store.channelState;
        let channelState: SessionChannelState | null;
        if (
          optimisticRef.current === 'streaming' &&
          (transportChannel === 'idle' || transportChannel === 'background')
        ) {
          channelState = prev.channelState; // keep optimistic
        } else {
          optimisticRef.current = null;
          channelState = transportChannel;
        }
        const next = {
          channelState,
          lastError: store.lastError,
          approvalRequest: store.approvalRequest,
          streamingContent: store.streamingContent,
        };
        return prev.channelState === next.channelState
          && prev.lastError === next.lastError
          && prev.approvalRequest === next.approvalRequest
          && prev.streamingContent === next.streamingContent
          ? prev
          : next;
      });
    };

    // Initial sync from current store state
    sync();

    store.stateListeners.add(sync);
    return () => { store.stateListeners.delete(sync); };
  }, [sessionId, manager]);

  // --- Per-consumer mutators (local state only) ---

  const setOptimistic = useCallback(
    (state: SessionChannelState) => {
      optimisticRef.current = state;
      setLocalState(prev => (prev.channelState === state ? prev : { ...prev, channelState: state }));
    },
    [],
  );

  const clearError = useCallback(() => {
    setLocalState(prev => (prev.lastError === null ? prev : { ...prev, lastError: null }));
  }, []);

  const clearApproval = useCallback(() => {
    setLocalState(prev => (prev.approvalRequest === null ? prev : { ...prev, approvalRequest: null }));
  }, []);

  const setApproval = useCallback((req: ApprovalRequest | null) => {
    setLocalState(prev => (prev.approvalRequest === req ? prev : { ...prev, approvalRequest: req }));
  }, []);

  return {
    entries: shared.entries,
    channelState: localState.channelState,
    lastError: localState.lastError,
    contextUsage: shared.contextUsage,
    approvalRequest: localState.approvalRequest,
    streamingContent: localState.streamingContent,
    setOptimistic,
    clearError,
    clearApproval,
    setApproval,
  };
}
