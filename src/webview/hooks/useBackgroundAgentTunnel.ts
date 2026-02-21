/**
 * useBackgroundAgentTunnel — lazy-load polling for background Task sub-agents
 *
 * Guards:
 * - Generation counter: bumped on cleanup, checked after each await.
 *   Prevents stale in-flight polls from injecting into a switched session.
 * - Recursive setTimeout: prevents overlapping polls when I/O is slow.
 *
 * @module useBackgroundAgentTunnel
 */

import { useEffect, useRef } from 'react';
import type { TranscriptEntry } from '../../core/transcript.js';
import { useTransport } from '../context/TransportContext.js';

const POLL_INTERVAL_MS = 500;

export function useBackgroundAgentTunnel(
  toolUseId: string,
  agentId: string | undefined,
  sessionId: string | null,
  isExpanded: boolean,
  onEntries: (entries: TranscriptEntry[]) => void,
): void {
  const transport = useTransport();
  const cursorRef = useRef('');
  const doneRef = useRef(false);
  const generationRef = useRef(0);

  const onEntriesRef = useRef(onEntries);
  onEntriesRef.current = onEntries;

  useEffect(() => {
    if (!agentId || !sessionId || !isExpanded || doneRef.current) return;

    const generation = ++generationRef.current;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const result = await transport.readSubagentEntries(
          sessionId, agentId, toolUseId, cursorRef.current,
        );
        if (generationRef.current !== generation) return; // stale

        if (result.entries.length > 0) {
          cursorRef.current = result.cursor;
          onEntriesRef.current(result.entries);
        }
        if (result.done) {
          doneRef.current = true;
          return;
        }
      } catch {
        if (generationRef.current !== generation) return;
      }
      timerId = setTimeout(poll, POLL_INTERVAL_MS);
    };

    poll();

    return () => {
      generationRef.current++;
      if (timerId !== null) clearTimeout(timerId);
    };
  }, [agentId, sessionId, isExpanded, toolUseId, transport]);

  // Reset cursor/done when session or agent changes
  useEffect(() => {
    cursorRef.current = '';
    doneRef.current = false;
  }, [sessionId, agentId]);
}
