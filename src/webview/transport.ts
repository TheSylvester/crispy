/**
 * SessionService Interface — Client-Side RPC
 *
 * Typed RPC methods for communicating with the host. Both VS Code
 * postMessage and WebSocket transports implement this interface.
 * The transport pipe (postMessage vs WebSocket) is invisible to consumers.
 *
 * @module transport
 */

import type { SessionInfo, TurnIntent, TurnReceipt } from '../core/agent-adapter.js';
import type { TranscriptEntry } from '../core/transcript.js';
import type { HostEvent } from '../host/client-connection.js';
import type { ApprovalExtra } from './components/approval/types.js';
import type { WireProviderConfig, ProviderConfig, WireSettingsSnapshot, SettingsPatch } from '../core/settings/types.js';
import type { VendorModelGroup } from './components/control-panel/types.js';
import type { ActivityIndexEntry } from '../core/activity-index.js';
import type { CatchupStatus } from '../core/recall/catchup-types.js';

/** Client-side session info — modifiedAt is a string after JSON serialization. */
export interface WireSessionInfo extends Omit<SessionInfo, 'modifiedAt'> {
  modifiedAt: string;
}

export interface SessionService {
  listSessions(): Promise<WireSessionInfo[]>;
  findSession(sessionId: string): Promise<WireSessionInfo | null>;
  loadSession(sessionId: string, options?: { until?: string }): Promise<TranscriptEntry[]>;

  /**
   * Send a turn (user message + settings) with unified routing.
   *
   * The session manager handles existing/new/fork targets, broadcasts the
   * user entry, and calls the adapter. Returns a receipt with the session ID.
   */
  sendTurn(intent: TurnIntent): Promise<TurnReceipt>;

  forkToNewPanel?(params: {
    fromSessionId: string;
    atMessageId?: string;
    initialPrompt?: string;
    model?: string;
    agencyMode?: string;
    bypassEnabled?: boolean;
    chromeEnabled?: boolean;
  }): Promise<{ ok: boolean }>;
  subscribe(sessionId: string): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;

  resolveApproval(sessionId: string, toolUseId: string, optionId: string, extra?: ApprovalExtra): Promise<void>;

  interrupt(sessionId: string): Promise<void>;

  close(sessionId: string): Promise<void>;
  subscribeSessionList(): Promise<void>;
  unsubscribeSessionList(): Promise<void>;
  subscribeRosieLog(): Promise<void>;
  unsubscribeRosieLog(): Promise<void>;
  onEvent(handler: (sessionId: string, event: HostEvent) => void): () => void;
  getGitFiles(cwd: string): Promise<string[]>;
  fileExists(path: string): Promise<boolean>;
  readImage(path: string): Promise<{ data: string; mimeType: string; fileName: string }>;
  readFile(path: string): Promise<{ content: string; fileName: string; size: number }>;
  openFile(path: string, line?: number, col?: number): Promise<{ opened: boolean }>;
  pickFile(candidates: string[]): Promise<{ picked: string | null }>;
  readSubagentEntries(
    sessionId: string,
    agentId: string,
    parentToolUseId: string,
    cursor: string,
  ): Promise<{ entries: TranscriptEntry[]; cursor: string; done: boolean }>;

  /** Provider management */
  listProviders(): Promise<Record<string, WireProviderConfig>>;
  saveProvider(slug: string, config: ProviderConfig): Promise<{ saved: boolean }>;
  deleteProvider(slug: string): Promise<{ deleted: boolean }>;
  getModelGroups(): Promise<VendorModelGroup[]>;

  /** Unified settings management */
  getSettings(): Promise<WireSettingsSnapshot>;
  updateSettings(patch: SettingsPatch, opts?: { expectedRevision?: number }): Promise<WireSettingsSnapshot>;

  /** Activity index — user prompt history across all sessions */
  getActivityLog(timeRange?: { from?: string; to?: string }, projectSlug?: string): Promise<ActivityIndexEntry[]>;
  getResponsePreview(file: string, offset: number): Promise<string | null>;
  getLineageGraph(): Promise<Array<{ sessionFile: string; parentFile: string | null }>>;

  /** Voice input — send recorded audio to host for VAD + STT transcription */
  transcribeAudio(pcmFloat32: Float32Array, sampleRate: number): Promise<{ text: string }>;

  /** Host-side voice capture (VS Code only — bypasses webview getUserMedia restriction) */
  startVoiceCapture?(): Promise<void>;
  stopVoiceCapture?(): Promise<{ text: string }>;

  /** Recall catch-up — embedding backfill management */
  subscribeRecallCatchup(): Promise<{ subscribed: boolean }>;
  unsubscribeRecallCatchup(): Promise<{ unsubscribed: boolean }>;
  startEmbeddingBackfill(): Promise<{ ok: boolean }>;
  stopEmbeddingBackfill(): Promise<{ ok: boolean }>;
  getCatchupStatus(): Promise<CatchupStatus>;

  dispose(): void;

  /** Fire-and-forget message to the host. VS Code only; no-op elsewhere. */
  postRaw?(msg: unknown): void;
}

/** @deprecated Use SessionService instead. */
export type Transport = SessionService;
