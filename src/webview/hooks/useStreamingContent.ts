/**
 * useStreamingContent — tracks incremental streaming content from the adapter
 *
 * Listens for 'streaming_content' notification events and exposes the
 * current partial content blocks for ghost-entry rendering.
 *
 * Returns null when not streaming. Returns ContentBlock[] during active
 * streaming. Clears when the complete assistant entry arrives (adapter
 * sends content: null).
 *
 * @module useStreamingContent
 */

import { useState, useEffect } from 'react';
import type { ContentBlock } from '../../core/transcript.js';
import { useTransport } from '../context/TransportContext.js';
import { useSession } from '../context/SessionContext.js';

export function useStreamingContent(): ContentBlock[] | null {
  const transport = useTransport();
  const { selectedSessionId } = useSession();
  const [content, setContent] = useState<ContentBlock[] | null>(null);

  useEffect(() => {
    setContent(null);
    if (!selectedSessionId) return;

    const off = transport.onEvent((sid, event) => {
      if (sid !== selectedSessionId) return;

      // Listen for streaming_content notifications
      if (
        event.type === 'event' &&
        event.event.type === 'notification' &&
        (event.event as { kind: string }).kind === 'streaming_content'
      ) {
        const payload = (event.event as unknown as { content: ContentBlock[] | null }).content;
        setContent(payload);
      }

      // Backstop: clear ghost when session goes idle/background (covers error
      // paths where the adapter's clearStreamingBuffer might not fire)
      if (
        event.type === 'event' &&
        event.event.type === 'status' &&
        (event.event.status === 'idle' || event.event.status === 'background')
      ) {
        setContent(null);
      }
    });

    return off;
  }, [selectedSessionId, transport]);

  return content;
}
