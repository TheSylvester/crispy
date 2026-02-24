/**
 * Tab Session Context — unified per-tab provider wrapper
 *
 * Consolidates all per-tab providers into a single `TabSessionProvider`
 * component. Each FlexLayout transcript tab wraps its content with one
 * `<TabSessionProvider>` instead of six+ nested providers.
 *
 * Internal composition (not merged — each provider retains its own context):
 * - BlocksToolRegistryProvider (entries, sessionId)
 * - PanelStateProvider
 * - BlocksVisibilityProvider (scrollRef)
 * - RenderLocationProvider (location="transcript")
 * - ForkProvider (fork targets, handlers, streaming state)
 * - ActiveTabBlocksBridge (conditional on isActiveTab)
 *
 * The `useTabSession()` hook composes existing per-provider hooks into a
 * single return value. Selector hooks provide granular access without
 * subscribing to the full context.
 *
 * @module webview/context/TabSessionContext
 */

import type { ReactNode, RefObject } from 'react';
import { BlocksToolRegistryProvider } from '../blocks/BlocksToolRegistryContext.js';
import { PanelStateProvider } from '../blocks/PanelStateContext.js';
import { BlocksVisibilityProvider } from '../blocks/BlocksVisibilityContext.js';
import { RenderLocationProvider } from './RenderLocationContext.js';
import { ForkProvider } from './ForkContext.js';
import { ActiveTabBlocksBridge } from '../blocks/ActiveTabBlocksBridge.js';
import type { TranscriptEntry } from '../../core/transcript.js';

// ============================================================================
// Provider Props
// ============================================================================

export interface TabSessionProviderProps {
  children: ReactNode;

  /** Visible entries for the tool registry */
  entries: TranscriptEntry[];

  /** Per-tab session ID (null = no session / welcome) */
  sessionId: string | null;

  /** Whether this tab is the currently active FlexLayout tab */
  isActiveTab: boolean;

  /** Ref to the .crispy-transcript scroll container */
  scrollRef: RefObject<HTMLDivElement | null>;

  // --- Fork props (optional — omit for welcome/error states) ---
  onFork?: (atMessageId: string) => void;
  onRewind?: (atMessageId: string) => void;
  onForkPreviewHover?: (targetMessageId: string, hovering: boolean) => void;
  isStreaming?: boolean;
  forkTargets?: Map<string, string>;
}

// ============================================================================
// Provider
// ============================================================================

const NOOP = () => {};
const NOOP_HOVER = (_id: string, _h: boolean) => {};
const EMPTY_MAP = new Map<string, string>();

/**
 * Unified per-tab provider. Composes existing providers internally —
 * each retains its own context, so all existing hooks continue to work.
 */
export function TabSessionProvider({
  children,
  entries,
  sessionId,
  isActiveTab,
  scrollRef,
  onFork,
  onRewind,
  onForkPreviewHover,
  isStreaming = false,
  forkTargets,
}: TabSessionProviderProps): React.JSX.Element {
  const hasFork = onFork !== undefined;

  return (
    <BlocksToolRegistryProvider entries={entries} sessionId={sessionId}>
      <PanelStateProvider>
        <BlocksVisibilityProvider scrollRef={scrollRef}>
          {isActiveTab && (
            <ActiveTabBlocksBridge
              isActiveTab={isActiveTab}
              scrollRef={scrollRef}
              sessionId={sessionId}
            />
          )}
          {hasFork ? (
            <RenderLocationProvider location="transcript">
              <ForkProvider
                onFork={onFork!}
                onRewind={onRewind ?? NOOP}
                onForkPreviewHover={onForkPreviewHover ?? NOOP_HOVER}
                isStreaming={isStreaming}
                forkTargets={forkTargets ?? EMPTY_MAP}
              >
                {children}
              </ForkProvider>
            </RenderLocationProvider>
          ) : (
            children
          )}
        </BlocksVisibilityProvider>
      </PanelStateProvider>
    </BlocksToolRegistryProvider>
  );
}
