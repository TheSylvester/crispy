/**
 * Message Provider — platform-agnostic provider interface
 *
 * Defines the contract that platform-specific providers (Discord, Telegram, etc.)
 * implement. The shared layer delivers snapshots; providers render natively.
 *
 * @module message-view/provider
 */

import type { SessionSnapshot } from '../session-snapshot.js';

// ---------------------------------------------------------------------------
// Provider interface
// ---------------------------------------------------------------------------

export interface ViewOpts {
  vendor?: string;
  auto?: boolean;
}

export interface MessageProvider {
  id: string;
  /** Snapshot changed for a watched session — provider should re-render */
  onSnapshotChanged(sessionId: string, snapshot: SessionSnapshot): void;
  /** Create a session view on this platform */
  createSessionView(sessionId: string, prompt: string, opts: ViewOpts): Promise<void>;
  /** Tear down all platform resources */
  dispose(): void;
}
