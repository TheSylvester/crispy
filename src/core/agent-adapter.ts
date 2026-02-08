/**
 * Agent Adapter Interface
 *
 * Vendor-agnostic interface that extends Channel with session discovery
 * and history loading. Each vendor adapter (Claude, Codex, Gemini)
 * implements this to provide a uniform shape for the Session Channel.
 *
 * The Channel interface already handles the live session contract:
 * send(), messages(), respondToApproval(), close(). The adapter adds
 * only what Channel doesn't have — history and discovery.
 *
 * @module agent-adapter
 */

import type { Channel } from './channel.js';
import type { Vendor, TranscriptEntry } from './transcript.js';

// ============================================================================
// Session Info — vendor-agnostic session metadata
// ============================================================================

/**
 * Metadata about a saved session on disk.
 *
 * Widened from the Claude-specific SessionInfo (which has `vendor: 'claude'`)
 * to accept any Vendor. Claude's literal type is assignable to this.
 */
export interface SessionInfo {
  sessionId: string;
  path: string;
  projectSlug: string;
  modifiedAt: Date;
  size: number;
  label?: string;
  vendor: Vendor;
}

// ============================================================================
// Agent Adapter Interface
// ============================================================================

/**
 * A vendor adapter = Channel (live session) + history/discovery + live controls.
 *
 * The Session Channel owns one AgentAdapter and uses it for both live
 * streaming (via the Channel methods) and loading past sessions from disk.
 *
 * Live controls (setModel, interrupt, etc.) are best-effort. If a vendor
 * doesn't support mid-stream model switching, the call can throw or no-op.
 * Promoting them to the interface means the Session Channel and UI can
 * attempt them uniformly without downcasting to vendor-specific types.
 */
export interface AgentAdapter extends Channel {
  // --- History / Discovery ---

  /** Load transcript entries from a saved session by ID. */
  loadHistory(sessionId: string): Promise<TranscriptEntry[]>;

  /** Find a session by ID across all known projects. */
  findSession(sessionId: string): SessionInfo | undefined;

  /** List all known sessions, most recently modified first. */
  listSessions(): SessionInfo[];

  // --- Live Session Controls ---

  /**
   * Interrupt the active session (pause, not kill).
   * Throws if no session is active.
   */
  interrupt(): Promise<void>;

  /**
   * Change the model mid-conversation.
   * Vendors that don't support this should throw with a descriptive message.
   */
  setModel(model?: string): Promise<void>;
}
