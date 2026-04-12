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
import { useTabSession } from '../context/TabSessionContext.js';

export function useStreamingContent(): ContentBlock[] | null {
  const { effectiveSessionId } = useTabSession();
  const { streamingContent } = useChannelStore(effectiveSessionId);
  return streamingContent;
}
