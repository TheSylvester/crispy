/**
 * useContextUsage — track a session's context window utilization
 *
 * Two data sources, in priority order:
 * 1. Live `state_changed` events from the transport (adapter → channel → snapshot)
 * 2. Historical fallback: walk `entries` backwards for the last assistant turn's
 *    `message.usage` and compute ContextUsage using the model's actual context
 *    window from result entries (falls back to 200k default).
 *
 * Returns null when no usage data is available yet.
 *
 * @module useContextUsage
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import type { ContextUsage, TranscriptEntry, Vendor } from '../../core/transcript.js';
import { getContextWindowTokens } from '../../core/model-utils.js';
import { useTransport } from '../context/TransportContext.js';

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * useState variant that resets to initialValue synchronously when key changes,
 * preventing a stale-render frame between the key change and the useEffect cleanup.
 */
function useKeyedState<T>(key: string | null, initialValue: T): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [state, setState] = useState<T>(initialValue);
  const prevKeyRef = useRef(key);
  if (key !== prevKeyRef.current) {
    prevKeyRef.current = key;
    setState(initialValue);
  }
  return [state, setState];
}

/**
 * Extract the model's context window size from transcript entries.
 *
 * Priority:
 * 1. Authoritative `modelUsage.contextWindow` from SDK result entries
 * 2. Model name from last assistant message → CONTEXT_WINDOWS lookup
 * 3. DEFAULT_CONTEXT_WINDOW (200k)
 *
 * The model-name fallback is critical for forked sessions: before the first
 * turn the adapter hasn't received a result yet, so modelUsage is absent,
 * but assistant entries carry the model string from the parent session.
 */
function extractContextWindow(entries: TranscriptEntry[]): number {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'result' && entry.metadata) {
      const modelUsage = entry.metadata.modelUsage as Record<string, Record<string, number>> | undefined;
      if (modelUsage) {
        for (const mu of Object.values(modelUsage)) {
          if (mu.contextWindow && mu.contextWindow > 0) return mu.contextWindow;
        }
      }
    }
  }

  // Fallback: extract model from last assistant message and look up known window
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'assistant' && entry.message?.model !== undefined) {
      const vendor = (entry.vendor ?? 'claude') as Vendor;
      return getContextWindowTokens(vendor, entry.message.model);
    }
  }

  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Compute ContextUsage from historical transcript entries.
 *
 * Walks entries backwards to find the last assistant message with `message.usage`,
 * then converts SDK Usage fields into our ContextUsage shape. Uses the model's
 * actual context window from result entries when available, falling back to
 * DEFAULT_CONTEXT_WINDOW.
 */
export function computeContextFromEntries(entries: TranscriptEntry[]): ContextUsage | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type === 'assistant' && entry.message?.usage) {
      const u = entry.message.usage;
      const input = u.input_tokens ?? 0;
      const output = u.output_tokens ?? 0;
      const cacheCreation = u.cache_creation_input_tokens ?? 0;
      const cacheRead = u.cache_read_input_tokens ?? 0;
      const totalTokens = input + output + cacheCreation + cacheRead;
      const contextWindow = extractContextWindow(entries);
      const percent = Math.min(Math.round((totalTokens / contextWindow) * 100), 100);

      return {
        tokens: { input, output, cacheCreation, cacheRead },
        totalTokens,
        contextWindow,
        percent,
      };
    }
  }
  return null;
}

/**
 * Hook that returns the latest ContextUsage for a session.
 *
 * - For live sessions: listens to `state_changed` events and extracts `snapshot.contextUsage`.
 * - For historical sessions: falls back to `computeContextFromEntries()`.
 *
 * Only updates state when contextUsage is non-null to avoid clearing on initial
 * idle before any assistant messages.
 */
export function useContextUsage(
  sessionId: string | null,
  entries?: TranscriptEntry[],
): ContextUsage | null {
  const transport = useTransport();
  // Keyed by sessionId — resets synchronously on session switch to prevent
  // a stale render frame showing the previous session's context data.
  const [liveUsage, setLiveUsage] = useKeyedState<ContextUsage | null>(sessionId, null);

  // Subscribe to live catchup events
  useEffect(() => {
    if (!sessionId) return;

    const off = transport.onEvent((sid, event) => {
      if (sid !== sessionId) return;
      if (event.type === 'catchup' && event.contextUsage) {
        setLiveUsage(event.contextUsage);
      }
    });

    return off;
  }, [sessionId, transport]);

  // Always compute from entries when available — not gated by liveUsage.
  // Entries usage updates every time a new assistant message with message.usage
  // arrives. Catchup (liveUsage) only fires once on subscribe. For Codex,
  // catchup contextUsage may be null at subscribe time (adapter hasn't received
  // tokenUsage yet). Entries-first ensures the gauge updates as soon as the
  // first assistant message completes.
  const entriesUsage = useMemo(() => {
    if (!entries || entries.length === 0) return null;
    return computeContextFromEntries(entries);
  }, [entries]);

  // Prefer live usage (adapter has authoritative contextWindow from SDK) over
  // entries-based (which can't extract contextWindow from entry metadata).
  return liveUsage ?? entriesUsage;
}
