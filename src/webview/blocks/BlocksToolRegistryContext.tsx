/**
 * Blocks Tool Registry Context — React integration for BlocksToolRegistry
 *
 * Follows the ToolRegistryContext pattern: named context → Provider function →
 * useXxx hook with null guard + throw.
 *
 * The provider owns a BlocksToolRegistry singleton (via useRef) and processes
 * transcript entries **synchronously during render** — not in a useEffect.
 * This is critical: child components read from the registry via
 * useSyncExternalStore's getSnapshot(), which runs during render. If we
 * populated the registry in a post-render effect, the first paint would
 * show text blocks but null tool cards.
 *
 * Processing during render is safe because:
 * - The registry is a mutable ref (useRef), not React state
 * - We guard with processedCountRef to avoid reprocessing
 * - Notifications are suppressed (silent mode) during render to avoid
 *   triggering useSyncExternalStore re-render cascades mid-render
 *
 * Post-render flush: silent mode collects dirty tool IDs during render.
 * A useEffect calls registry.flushDirty() after commit so already-mounted
 * components get notified and re-render.
 *
 * Child entries map: As entries are processed, we build a parentToolUseID →
 * TranscriptEntry[] map so Task cards can render their children inside the
 * card body using the same blocks pipeline recursively.
 *
 * @module webview/blocks/BlocksToolRegistryContext
 */

import {
  createContext,
  useContext,
  useRef,
  useEffect,
  useState,
} from 'react';
import type { TranscriptEntry, ContentBlock, ToolResultBlock } from '../../core/transcript.js';
import type { RichBlock } from './types.js';
import { BlocksToolRegistry } from './blocks-tool-registry.js';

// Side-effect import: registers all tool views with the definition registry.
// Without this, all tools fall through to FallbackToolView (crispy-blocks-tool--unknown).
import './register-views.js';

// ============================================================================
// Context
// ============================================================================

const BlocksToolRegistryCtx = createContext<BlocksToolRegistry | null>(null);
const ChildEntriesCtx = createContext<Map<string, TranscriptEntry[]>>(new Map());

const EMPTY_ARRAY: TranscriptEntry[] = [];

// ============================================================================
// Provider
// ============================================================================

interface BlocksToolRegistryProviderProps {
  entries: TranscriptEntry[];
  sessionId: string | null;
  children: React.ReactNode;
}

export function BlocksToolRegistryProvider({
  entries,
  sessionId,
  children,
}: BlocksToolRegistryProviderProps): React.JSX.Element {
  const registryRef = useRef<BlocksToolRegistry | null>(null);
  if (registryRef.current === null) {
    registryRef.current = new BlocksToolRegistry();
  }
  const registry = registryRef.current;

  // Child entries map: parentToolUseID → TranscriptEntry[].
  // Groups nested entries by their parent Task tool_use_id so Task cards
  // can render their children inside the card body.
  //
  // Two-layer design:
  //   1. workingMap (useRef) — mutable map, populated during render. Cheap to
  //      push into, no React overhead.
  //   2. childEntriesMap (useState) — immutable snapshot exposed via context.
  //      New reference = React re-renders all context consumers.
  //
  // After the processing block mutates the working map, we compare a generation
  // counter to decide whether a fresh snapshot is needed. This is MORE reliable
  // than useMemo (whose caching semantics are advisory, not guaranteed) and
  // avoids useEffect timing gaps (which run post-render, too late for panel
  // components mounting via IntersectionObserver).
  //
  // IMPORTANT — DO NOT replace this with useMemo. useMemo's cache can be
  // discarded or retained unpredictably across React re-renders, causing
  // intermittent failures where Task children disappear. See session
  // bcb318b8 for the full debugging history.
  const workingMapRef = useRef<Map<string, TranscriptEntry[]>>(new Map());
  const workingMap = workingMapRef.current;
  const [childEntriesMap, setChildEntriesMap] = useState<Map<string, TranscriptEntry[]>>(() => new Map());
  // Generation counter: bumped every time processing adds to the working map.
  // Compared against the snapshot's generation to know when to re-snapshot.
  const generationRef = useRef(0);
  const snapshotGenRef = useRef(0);

  const processedCountRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Synchronous render-phase processing
  // ---------------------------------------------------------------------------

  const sessionChanged = sessionId !== sessionIdRef.current;
  if (sessionChanged) {
    sessionIdRef.current = sessionId;
    registry.reset();
    workingMap.clear();
    processedCountRef.current = 0;
    generationRef.current++;
  }

  const len = entries.length;
  const processed = processedCountRef.current;

  if (len === 0) {
    if (processed > 0) {
      registry.reset();
      workingMap.clear();
      processedCountRef.current = 0;
      generationRef.current++;
    }
  } else if (len > processed) {
    registry.silent(() => {
      for (let i = processed; i < len; i++) {
        processEntryForBlocksRegistry(entries[i], registry, workingMap);
      }
    });
    processedCountRef.current = len;
    generationRef.current++;
  } else if (len < processed) {
    // Playback rewind / fork — full reset + reprocess
    registry.reset();
    workingMap.clear();
    registry.silent(() => {
      for (const entry of entries) {
        processEntryForBlocksRegistry(entry, registry, workingMap);
      }
    });
    processedCountRef.current = len;
    generationRef.current++;
  }

  // Snapshot: when generation has advanced, create a new Map reference so
  // React context consumers re-render. We call setChildEntriesMap during
  // render (not in an effect) so the new value is available to children in
  // the SAME render pass — no timing gap.
  if (generationRef.current !== snapshotGenRef.current) {
    snapshotGenRef.current = generationRef.current;
    // setState during render is legal in React when it's conditional and
    // won't loop. The generation guard ensures it fires exactly once per
    // data change. React will schedule a re-render with the new value.
    setChildEntriesMap(new Map(workingMap));
  }

  // ---------------------------------------------------------------------------
  // Post-render flush
  // ---------------------------------------------------------------------------
  useEffect(() => {
    registry.flushDirty();
  });

  return (
    <BlocksToolRegistryCtx.Provider value={registry}>
      <ChildEntriesCtx.Provider value={childEntriesMap}>
        {children}
      </ChildEntriesCtx.Provider>
    </BlocksToolRegistryCtx.Provider>
  );
}

// ============================================================================
// Entry Processing
// ============================================================================

/**
 * Process an entry: register tool_use blocks, resolve tool_result blocks,
 * and group nested entries by parentToolUseID.
 */
function processEntryForBlocksRegistry(
  entry: TranscriptEntry,
  registry: BlocksToolRegistry,
  childEntriesMap: Map<string, TranscriptEntry[]>,
): void {
  // Group nested entries by their parent Task tool_use_id
  const parentId = entry.parentToolUseID;
  if (parentId) {
    const siblings = childEntriesMap.get(parentId);
    if (siblings) {
      siblings.push(entry);
    } else {
      childEntriesMap.set(parentId, [entry]);
    }
  }

  const content = entry.message?.content;
  if (!Array.isArray(content)) return;

  for (const block of content) {
    if (block.type === 'tool_use') {
      // Build RichBlock with structural context for panel expanded views
      const richBlock: RichBlock = {
        ...block,
        context: {
          entryUuid: entry.uuid ?? '',
          role: entry.message?.role ?? entry.type,
          parentToolUseId: entry.parentToolUseID,
          agentId: entry.agentId,
          depth: 0,
          isSidechain: entry.isSidechain,
        },
      };
      registry.register(block.id, block.name, richBlock);
    } else if (block.type === 'tool_result') {
      registry.resolve(block.tool_use_id, block);
      // Recurse into nested content (Task results contain sub-agent blocks)
      if (Array.isArray(block.content)) {
        walkNestedForRegistry(block.content, registry);
      }
    }
  }
}

/**
 * Recursively process nested content blocks (e.g., inside Task results).
 */
function walkNestedForRegistry(
  content: (string | ContentBlock)[],
  registry: BlocksToolRegistry,
): void {
  for (const item of content) {
    if (typeof item === 'string') continue;
    if (item.type === 'tool_use') {
      registry.register(item.id, item.name);
    } else if (item.type === 'tool_result') {
      registry.resolve(item.tool_use_id, item as ToolResultBlock);
      if (Array.isArray((item as ToolResultBlock).content)) {
        walkNestedForRegistry((item as ToolResultBlock).content as (string | ContentBlock)[], registry);
      }
    }
  }
}

// ============================================================================
// Hooks
// ============================================================================

/**
 * Access the BlocksToolRegistry instance.
 * Throws if used outside BlocksToolRegistryProvider.
 */
export function useBlocksToolRegistry(): BlocksToolRegistry {
  const ctx = useContext(BlocksToolRegistryCtx);
  if (!ctx) {
    throw new Error('useBlocksToolRegistry must be used within a BlocksToolRegistryProvider');
  }
  return ctx;
}

/**
 * Get child transcript entries for a parent Task tool_use_id.
 *
 * Returns the entries whose parentToolUseID matches the given ID,
 * in stream order. Returns a stable empty array for non-Task tools.
 */
export function useBlocksChildEntries(parentToolUseId: string): TranscriptEntry[] {
  const map = useContext(ChildEntriesCtx);
  return map.get(parentToolUseId) ?? EMPTY_ARRAY;
}
