/**
 * useStreamingContent — streaming ghost content from the channel store
 *
 * Thin wrapper around useChannelStore. Returns null when not streaming,
 * ContentBlock[] during active streaming.
 *
 * @module useStreamingContent
 */

import type { ContentBlock } from '../../core/transcript.js';
import { useChannelStore } from './useChannelStore.js';
import { useSession } from '../context/SessionContext.js';

export function useStreamingContent(): ContentBlock[] | null {
  const { selectedSessionId } = useSession();
  const { streamingContent } = useChannelStore(selectedSessionId);
  return streamingContent;
}
