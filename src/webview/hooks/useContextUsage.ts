/**
 * useContextUsage — track a session's context window utilization
 *
 * Two data sources, in priority order:
 * 1. Live `state_changed` events from the transport (adapter → channel → snapshot)
 * 2. Historical fallback: walk `entries` backwards for the last assistant turn's
 *    `message.usage` and compute ContextUsage with 200k default window.
 *
 * Returns null when no usage data is available yet.
 *
 * @module useContextUsage
 */

import { useState, useEffect, useMemo } from 'react';
import type { ContextUsage, TranscriptEntry } from '../../core/transcript.js';
import { useTransport } from '../context/TransportContext.js';

const DEFAULT_CONTEXT_WINDOW = 200_000;

/**
 * Compute ContextUsage from historical transcript entries.
 *
 * Walks entries backwards to find the last assistant message with `message.usage`,
 * then converts SDK Usage fields into our ContextUsage shape.
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
      const contextWindow = DEFAULT_CONTEXT_WINDOW;
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
  const [liveUsage, setLiveUsage] = useState<ContextUsage | null>(null);

  // Reset when session changes
  useEffect(() => {
    setLiveUsage(null);
  }, [sessionId]);

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

  // Prefer entries-based (updates per assistant message) over catchup snapshot
  return entriesUsage ?? liveUsage;
}
