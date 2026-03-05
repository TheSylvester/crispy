/**
 * codex-discovery.ts
 *
 * VendorDiscovery implementation for Codex using app-server RPC protocol,
 * with JSONL-first session loading for complete tool call data.
 *
 * Responsibilities:
 * - Session listing via thread/list RPC (paginated)
 * - Session loading: JSONL from disk first (complete), RPC fallback (lossy)
 * - Cache management with TTL for efficient repeated lookups
 *
 * Does NOT:
 * - Manage live sessions (that's the adapter's job)
 * - Implement readSubagentEntries (Codex doesn't need it)
 */

import type { VendorDiscovery, SessionInfo } from '../../agent-adapter.js';
import type { TranscriptEntry } from '../../transcript.js';
import type { Thread } from './protocol/v2/Thread.js';
import type { ThreadListResponse } from './protocol/v2/ThreadListResponse.js';
import type { ThreadReadResponse } from './protocol/v2/ThreadReadResponse.js';
import { adaptCodexItem } from './codex-entry-adapter.js';
import { findCodexSessionFile, parseCodexJsonlFile, scanCodexUserMessages } from './codex-jsonl-reader.js';
import { adaptCodexJsonlRecords } from './codex-jsonl-adapter.js';
import { CodexRpcClient, type CodexRpcClientOptions } from './codex-rpc-client.js';
import { getLatestRosieMeta } from '../../activity-index.js';

// ============================================================================
// CodexDiscovery
// ============================================================================

export class CodexDiscovery implements VendorDiscovery {
  readonly vendor = 'codex' as const;

  private client: CodexRpcClient | null = null;
  private ownedClient = false;
  private _command: string | undefined;
  private sessionCache: SessionInfo[] = [];
  private cacheTimestamp = 0;
  private readonly cacheTtlMs = 30_000;
  private refreshing = false;
  private refreshPromise: Promise<void> | null = null;

  /**
   * Set the resolved codex binary path.
   * When set, standalone discovery clients will use this command instead of
   * the default 'codex'.
   */
  setCommand(command: string | undefined): void {
    this._command = command;
  }

  /**
   * Attach a shared RPC client (from the live adapter).
   * When attached, discovery uses this client instead of spawning its own.
   */
  attachClient(client: CodexRpcClient): void {
    // If we own a temporary client, kill it first
    if (this.ownedClient && this.client) {
      this.client.kill();
    }
    this.client = client;
    this.ownedClient = false;
  }

  /**
   * Detach the shared client.
   * If we own a temporary client, kill it.
   */
  detachClient(): void {
    if (this.ownedClient && this.client) {
      this.client.kill();
    }
    this.client = null;
    this.ownedClient = false;
  }

  /**
   * Find a session by ID in the cached list.
   */
  findSession(sessionId: string): SessionInfo | undefined {
    // Trigger refresh if cache is stale (fire-and-forget)
    this.maybeRefresh();
    return this.sessionCache.find((s) => s.sessionId === sessionId);
  }

  /**
   * List all known sessions.
   * Returns cached list synchronously; triggers async refresh if stale.
   */
  listSessions(): SessionInfo[] {
    this.maybeRefresh();
    return this.sessionCache;
  }

  /**
   * Scan user activity (prompts) in a session file incrementally.
   */
  scanUserActivity(sessionPath: string, fromOffset = 0) {
    return scanCodexUserMessages(sessionPath, fromOffset);
  }

  /**
   * Load full history for a session.
   *
   * Tries JSONL from disk first (complete data including tool calls),
   * then falls back to thread/read RPC (lossy — strips tool execution items).
   */
  async loadHistory(sessionId: string): Promise<TranscriptEntry[]> {
    // Try JSONL first (complete data including tool calls)
    const jsonlPath = findCodexSessionFile(sessionId);
    if (jsonlPath) {
      const records = parseCodexJsonlFile(jsonlPath);
      if (records.length > 0) {
        return adaptCodexJsonlRecords(records, sessionId);
      }
    }

    // Fallback: RPC (lossy — no tool calls, but better than nothing)
    const client = await this.ensureClient();

    const response = await client.request<ThreadReadResponse>('thread/read', {
      threadId: sessionId,
      includeTurns: true,
    });

    const entries: TranscriptEntry[] = [];
    for (const turn of response.thread.turns) {
      for (const item of turn.items) {
        const adapted = adaptCodexItem(item, sessionId, turn.id);
        entries.push(...adapted);
      }
    }

    return entries;
  }

  /**
   * Force a cache refresh. Returns when refresh is complete.
   * Useful for testing or when immediate consistency is needed.
   */
  async refresh(): Promise<void> {
    if (this.refreshing && this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshing = true;
    this.refreshPromise = this.doRefresh();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshing = false;
      this.refreshPromise = null;
    }
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private maybeRefresh(): void {
    const stale = Date.now() - this.cacheTimestamp > this.cacheTtlMs;
    if ((stale || this.sessionCache.length === 0) && !this.refreshing) {
      // Fire-and-forget refresh
      this.refresh().catch((err) => {
        console.error('[codex-discovery] Refresh failed:', err);
      });
    }
  }

  private async doRefresh(): Promise<void> {
    const client = await this.ensureClient();
    const sessions: SessionInfo[] = [];
    let cursor: string | null = null;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const response: ThreadListResponse = await client.request<ThreadListResponse>(
        'thread/list',
        { limit: 100, cursor },
      );

      for (const thread of response.data) {
        sessions.push(this.threadToSessionInfo(thread));
      }

      cursor = response.nextCursor;
      if (!cursor) break;
    }

    this.sessionCache = sessions;
    this.cacheTimestamp = Date.now();
  }

  private async ensureClient(): Promise<CodexRpcClient> {
    if (this.client && this.client.alive) {
      return this.client;
    }

    // Spawn a temporary client for standalone discovery
    const options: CodexRpcClientOptions = {
      ...(this._command && { command: this._command }),
      onNotification: () => {},
      onRequest: () => {},
      onError: (err) => {
        console.error('[codex-discovery] RPC client error:', err);
      },
      onExit: () => {
        if (this.ownedClient) {
          this.client = null;
          this.ownedClient = false;
        }
      },
    };

    this.client = new CodexRpcClient(options);
    this.ownedClient = true;

    // Must initialize the protocol before any RPC calls
    await this.client.request('initialize', {
      clientInfo: { name: 'crispy-discovery', version: '0.1.4-dev.25' },
      capabilities: { experimentalApi: true },
    });

    return this.client;
  }

  private threadToSessionInfo(thread: Thread): SessionInfo {
    const rosie = getLatestRosieMeta(thread.path ?? '');
    return {
      sessionId: thread.id,
      path: thread.path ?? '',
      projectSlug: this.deriveProjectSlug(thread.cwd),
      projectPath: thread.cwd,
      modifiedAt: new Date(thread.updatedAt * 1000),
      size: 0, // RPC doesn't provide file size
      label: thread.preview?.slice(0, 80),
      lastMessage: thread.preview,
      vendor: 'codex',
      ...(rosie && { quest: rosie.quest, botSummary: rosie.summary, title: rosie.title, status: rosie.status, entities: rosie.entities }),
    };
  }

  private deriveProjectSlug(cwd: string): string {
    // Match Claude's slug format: replace / or \ with - (keep leading dash)
    return cwd.replace(/[\\/]/g, '-');
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const codexDiscovery = new CodexDiscovery();
