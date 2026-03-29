/**
 * opencode-agent-adapter.ts
 *
 * Main AgentAdapter implementation for OpenCode using HTTP API + SSE streaming.
 *
 * Responsibilities:
 * - Own the `opencode serve` process lifecycle
 * - Stream ChannelMessages to consumers via AsyncIterableQueue
 * - Handle SSE events (part deltas, permissions, session status)
 * - Map permissions and questions to Crispy approval events
 *
 * Does NOT:
 * - Parse DB data (discovery handles that)
 * - Manage multiple sessions (one adapter per session)
 * - Perform session discovery (opencode-discovery handles that)
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type {
  AgentAdapter,
  ChannelMessage,
  SessionOpenSpec,
  AdapterSettings,
  TurnSettings,
} from '../../agent-adapter.js';
import { log } from '../../log.js';
import type { ChannelEvent, ChannelStatus } from '../../channel-events.js';
import type {
  ContentBlock,
  ContextUsage,
  MessageContent,
  Vendor,
} from '../../transcript.js';
import type {
  Part,
  Permission,
  Event as OpenCodeEvent,
  Session as OpenCodeSession,
  TextPartInput,
} from '@opencode-ai/sdk/client';
import { AsyncIterableQueue } from '../../async-iterable-queue.js';
import {
  adaptOpenCodePart,
  extractContextUsage,
  extractRetryError,
} from './opencode-entry-adapter.js';
import {
  permissionToApprovalEvent,
  crispyResponseToPermissionReply,
} from './opencode-approval-mapping.js';

// ============================================================================
// Types
// ============================================================================

interface PendingApproval {
  permissionId: string;
  sessionId: string;
  type: 'permission';
}

interface AdapterConfig {
  cwd: string;
  command?: string;
  port?: number;
  /** Pre-existing server URL — skips spawning `opencode serve`. For testing. */
  baseUrl?: string;
}

// ============================================================================
// OpenCodeAgentAdapter
// ============================================================================

export class OpenCodeAgentAdapter implements AgentAdapter {
  readonly vendor: Vendor = 'opencode';

  // --- State ---
  private _sessionId: string | undefined;
  private _status: ChannelStatus = 'idle';
  private _contextUsage: ContextUsage | null = null;
  private _settings: AdapterSettings;
  private _closed = false;

  // --- Infrastructure ---
  private outputQueue = new AsyncIterableQueue<ChannelMessage>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private childSessionMap = new Map<string, string>(); // childSessionId → parentToolUseID
  private serverProcess: ChildProcess | null = null;
  private sseAbort: AbortController | null = null;
  private baseUrl = '';
  private readonly config: AdapterConfig;
  private readonly spec: SessionOpenSpec;

  // --- Streaming ---
  private streamingText = '';
  private streamingThinking = '';
  private streamingEmitTimer: ReturnType<typeof setTimeout> | null = null;
  private static readonly STREAMING_EMIT_INTERVAL = 16;

  constructor(
    spec: SessionOpenSpec,
    config: AdapterConfig,
  ) {
    this.spec = spec;
    this.config = config;
    this._settings = {
      vendor: 'opencode',
      model: 'model' in spec ? spec.model : undefined,
      permissionMode: undefined,
      allowDangerouslySkipPermissions: false,
      extraArgs: undefined,
    };

    if (spec.mode === 'resume') {
      this._sessionId = spec.sessionId;
    } else if (spec.mode === 'fork') {
      this._sessionId = spec.fromSessionId;
    }
  }

  // --- Getters ---
  get sessionId(): string | undefined { return this._sessionId; }
  get status(): ChannelStatus { return this._status; }
  get contextUsage(): ContextUsage | null { return this._contextUsage; }
  get settings(): AdapterSettings { return this._settings; }

  // --- Core Methods ---

  messages(): AsyncIterable<ChannelMessage> {
    return this.outputQueue;
  }

  sendTurn(content: MessageContent, settings: TurnSettings): void {
    if (this._closed) throw new Error('Adapter is closed');
    if (this._status === 'awaiting_approval') throw new Error('Cannot send while awaiting approval');

    this.applySettings(settings);
    this.doSendTurn(content).catch((err) => this.emitError(err));
  }

  respondToApproval(
    toolUseId: string,
    optionId: string,
    extra?: { message?: string; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] },
  ): void {
    if (this._closed) throw new Error('Adapter is closed');

    const pending = this.pendingApprovals.get(toolUseId);
    if (!pending) throw new Error(`No pending approval for: ${toolUseId}`);

    // Send reply — SSE events will handle cleanup via permission.replied
    const body = crispyResponseToPermissionReply(optionId, extra);
    this.postJson(
      `/session/${encodeURIComponent(pending.sessionId)}/permissions/${encodeURIComponent(pending.permissionId)}`,
      body,
    ).catch((err) => log({ level: 'error', source: 'opencode-adapter', summary: `Permission reply failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } }));

    // Don't remove from pendingApprovals here — wait for permission.replied SSE event.
    // Fan-out: reject may auto-resolve other pending permissions.
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;

    // Reject all pending permissions
    for (const [, pending] of this.pendingApprovals) {
      this.postJson(
        `/session/${encodeURIComponent(pending.sessionId)}/permissions/${encodeURIComponent(pending.permissionId)}`,
        { response: 'reject' },
      ).catch(() => { /* cleanup — ignore errors */ });
    }
    this.pendingApprovals.clear();

    // Close SSE
    this.sseAbort?.abort();
    this.sseAbort = null;

    // Clear streaming buffer
    this.clearStreamingBuffer();

    // Kill server process
    if (this.serverProcess) {
      this.serverProcess.kill('SIGTERM');
      this.serverProcess = null;
    }

    this._status = 'idle';
    this.outputQueue.enqueue({
      type: 'event',
      event: { type: 'status', status: 'idle' },
    });
    this.outputQueue.done();
  }

  async interrupt(): Promise<void> {
    if (!this._sessionId) return;
    try {
      await this.postJson(`/session/${encodeURIComponent(this._sessionId)}/abort`, undefined);
    } catch (err) {
      log({ level: 'error', source: 'opencode-adapter', summary: `Interrupt failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
    }
  }

  async setModel(model?: string): Promise<void> {
    this._settings = { ...this._settings, model };
    this.emitSettingsChanged();
  }

  async setPermissionMode(mode: string): Promise<void> {
    this._settings = { ...this._settings, permissionMode: mode };
    this.emitSettingsChanged();
  }

  // --- Private: Server Lifecycle ---

  private async startServer(): Promise<void> {
    const port = this.config.port ?? await this.findFreePort();
    this.baseUrl = `http://127.0.0.1:${port}`;

    const command = this.config.command ?? 'opencode';
    this.serverProcess = spawn(command, ['serve', '--port', String(port)], {
      cwd: this.config.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.serverProcess.stderr?.on('data', (data: Buffer) => {
      const msg = data.toString().trim();
      if (msg) log({ level: 'debug', source: 'opencode-server', summary: msg });
    });

    this.serverProcess.on('exit', (code, signal) => {
      if (!this._closed) {
        log({ level: 'debug', source: 'opencode-adapter', summary: `Server exited: code=${code}, signal=${signal}` });
        if (code !== 0 && code !== null) {
          this.emitError(`Server exited unexpectedly: code=${code}, signal=${signal}`);
        }
        this.serverProcess = null;
        this.emitStatus('idle');
      }
    });

    // Poll for health
    await this.waitForHealth(port);
  }

  private async waitForHealth(port: number, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`${this.baseUrl}/global/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (resp.ok) return;
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`OpenCode server failed to start on port ${port} within ${timeoutMs}ms`);
  }

  private async findFreePort(): Promise<number> {
    const { createServer } = await import('node:net');
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          const port = addr.port;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error('Failed to get port')));
        }
      });
      server.on('error', reject);
    });
  }

  // --- Private: Send Turn ---

  private async doSendTurn(content: MessageContent): Promise<void> {
    // Start server if not running and not pre-connected
    if (!this.baseUrl) {
      if (this.config.baseUrl) {
        // Pre-existing server (testing or external)
        this.baseUrl = this.config.baseUrl;
        this.connectSSE();
      } else if (!this.serverProcess) {
        await this.startServer();
        this.connectSSE();
      }
    }

    // Create session if we don't have one
    if (!this._sessionId) {
      const cwd = this.spec.mode === 'fresh' ? this.spec.cwd : this.config.cwd;
      const session = await this.postJson<OpenCodeSession>(`/session?directory=${encodeURIComponent(cwd)}`, {});
      if (session) {
        const prevId = this._sessionId;
        this._sessionId = session.id;
        this.outputQueue.enqueue({
          type: 'event',
          event: {
            type: 'notification',
            kind: 'session_changed',
            sessionId: session.id,
            ...(prevId ? { previousSessionId: prevId } : {}),
          },
        });
      }
    }

    // Build prompt parts
    const parts: TextPartInput[] = [];
    if (typeof content === 'string') {
      parts.push({ type: 'text', text: content });
    } else if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          parts.push({ type: 'text', text: block.text });
        }
      }
    }

    this.emitStatus('active');

    // Fire-and-forget prompt
    await this.postJson(
      `/session/${encodeURIComponent(this._sessionId!)}/prompt_async?directory=${encodeURIComponent(this.config.cwd)}`,
      { parts },
    );
  }

  // --- Private: SSE Connection ---

  private connectSSE(): void {
    if (this.sseAbort) {
      this.sseAbort.abort();
    }

    this.sseAbort = new AbortController();
    const url = `${this.baseUrl}/event?directory=${encodeURIComponent(this.config.cwd)}`;

    this.consumeSSE(url, this.sseAbort.signal).catch((err) => {
      if (!this._closed) {
        log({ level: 'error', source: 'opencode-adapter', summary: `SSE connection failed: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
      }
    });
  }

  private async consumeSSE(url: string, signal: AbortSignal): Promise<void> {
    const response = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? ''; // Keep incomplete line in buffer

        let eventType = '';
        let eventData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            eventData += (eventData ? '\n' : '') + line.slice(6);
          } else if (line === '' && eventData) {
            // End of event
            this.handleSSEEvent(eventType, eventData);
            eventType = '';
            eventData = '';
          }
        }
      }
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }

  // --- Private: SSE Event Handling ---

  private handleSSEEvent(_eventType: string, data: string): void {
    if (this._closed) return;

    try {
      const parsed = JSON.parse(data) as OpenCodeEvent;
      this.processEvent(parsed);
    } catch (err) {
      log({ level: 'warn', source: 'opencode-adapter', summary: `Failed to parse SSE event: ${err instanceof Error ? err.message : String(err)}`, data: { error: String(err) } });
    }
  }

  private processEvent(event: OpenCodeEvent): void {
    switch (event.type) {
      case 'message.part.updated':
        this.handlePartUpdated(event.properties.part, event.properties.delta);
        break;

      case 'message.part.removed':
        // No-op — part removal not tracked
        break;

      case 'message.updated':
        this.handleMessageUpdated(event.properties.info);
        break;

      case 'message.removed':
        // No-op for now — entry removal not supported
        break;

      case 'permission.updated':
        this.handlePermissionUpdated(event.properties);
        break;

      case 'permission.replied':
        this.handlePermissionReplied(event.properties);
        break;

      case 'session.status':
        this.handleSessionStatus(event.properties);
        break;

      case 'session.idle':
        this.handleSessionIdle(event.properties.sessionID);
        break;

      case 'session.compacted':
        this.outputQueue.enqueue({
          type: 'event',
          event: { type: 'notification', kind: 'compacting' },
        });
        break;

      case 'session.error':
        if (event.properties.error) {
          const errData = event.properties.error as { data?: { message?: string }; name?: string };
          this.emitError(errData.data?.message ?? errData.name ?? 'Unknown session error');
        }
        break;

      case 'session.created':
      case 'session.updated':
        // Track session ID updates
        if (event.properties.info.id && event.properties.info.id !== this._sessionId) {
          const prevId = this._sessionId;
          this._sessionId = event.properties.info.id;
          this.outputQueue.enqueue({
            type: 'event',
            event: {
              type: 'notification',
              kind: 'session_changed',
              sessionId: event.properties.info.id,
              ...(prevId ? { previousSessionId: prevId } : {}),
            },
          });
        }
        break;

      // Ignored events
      case 'session.deleted':
      case 'session.diff':
      case 'file.edited':
      case 'file.watcher.updated':
      case 'todo.updated':
      case 'command.executed':
      case 'vcs.branch.updated':
      case 'server.connected':
      case 'server.instance.disposed':
      case 'installation.updated':
      case 'installation.update-available':
      case 'lsp.client.diagnostics':
      case 'lsp.updated':
      case 'tui.prompt.append':
      case 'tui.command.execute':
      case 'tui.toast.show':
      case 'pty.created':
      case 'pty.updated':
      case 'pty.exited':
      case 'pty.deleted':
        break;
    }
  }

  private handlePartUpdated(part: Part, delta?: string): void {
    // Determine if this is a child session event
    const parentToolUseId = this.childSessionMap.get(part.sessionID);
    const sessionId = parentToolUseId ? this._sessionId ?? part.sessionID : part.sessionID;

    // Only process events for our session or tracked child sessions
    if (sessionId !== this._sessionId && !parentToolUseId) return;

    // Handle streaming deltas for text/reasoning parts
    if (delta && (part.type === 'text' || part.type === 'reasoning')) {
      if (part.type === 'text') {
        this.streamingText += delta;
      } else {
        this.streamingThinking += delta;
      }
      this.scheduleStreamingEmit();
      return; // Don't emit full entry for delta-only updates
    }

    // Handle step-finish → update context usage
    if (part.type === 'step-finish') {
      this._contextUsage = extractContextUsage(part, this._settings.model);
      return;
    }

    // Handle retry → emit error event
    if (part.type === 'retry') {
      this.emitError(extractRetryError(part));
      return;
    }

    // Handle compaction → emit compacting event
    if (part.type === 'compaction') {
      this.outputQueue.enqueue({
        type: 'event',
        event: { type: 'notification', kind: 'compacting' },
      });
      return;
    }

    // Track child sessions for subtask parts
    if (part.type === 'tool' && part.tool === 'task' && part.state.status === 'running') {
      const childId = part.state.metadata?.sessionId as string | undefined;
      if (childId) {
        this.childSessionMap.set(childId, part.callID);
      }
    }

    // Clear streaming buffer when a complete text part arrives
    if (part.type === 'text' && !delta) {
      this.clearStreamingBuffer();
    }

    // Adapt part to entries
    const entries = adaptOpenCodePart(part, sessionId);
    for (const entry of entries) {
      if (parentToolUseId) {
        entry.parentToolUseID = parentToolUseId;
      }
      this.outputQueue.enqueue({ type: 'entry', entry });
    }
  }

  private handleMessageUpdated(msg: { id: string; sessionID: string; role: string; [key: string]: unknown }): void {
    // Only process for our session
    if (msg.sessionID !== this._sessionId) return;

    if (msg.role === 'assistant') {
      // Assistant message created — update session status
      this.emitStatus('active');
    }
  }

  private handlePermissionUpdated(permission: Permission): void {
    // Only handle permissions for our session
    if (permission.sessionID !== this._sessionId) return;

    const mapped = permissionToApprovalEvent(permission);

    this.pendingApprovals.set(mapped.toolUseId, {
      permissionId: permission.id,
      sessionId: permission.sessionID,
      type: 'permission',
    });

    this._status = 'awaiting_approval';
    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'status',
        status: 'awaiting_approval',
        toolUseId: mapped.toolUseId,
        toolName: mapped.toolName,
        input: mapped.input,
        reason: mapped.reason,
        options: mapped.options,
      },
    });
  }

  private handlePermissionReplied(props: { sessionID: string; permissionID: string; response: string }): void {
    if (props.sessionID !== this._sessionId) return;

    // Find and remove the pending approval by permissionID
    for (const [toolUseId, pending] of this.pendingApprovals) {
      if (pending.permissionId === props.permissionID) {
        this.pendingApprovals.delete(toolUseId);
        break;
      }
    }

    // If all pending approvals resolved, transition status
    if (this.pendingApprovals.size === 0) {
      this.emitStatus('active');
    }
  }

  private handleSessionStatus(props: { sessionID: string; status: { type: string } }): void {
    if (props.sessionID !== this._sessionId) return;

    switch (props.status.type) {
      case 'busy':
        if (this.pendingApprovals.size === 0) {
          this.emitStatus('active');
        }
        break;
      case 'idle':
        this.clearStreamingBuffer();
        if (this.pendingApprovals.size === 0) {
          this.emitStatus('idle');
        }
        break;
    }
  }

  private handleSessionIdle(sessionId: string): void {
    if (sessionId !== this._sessionId) return;
    this.clearStreamingBuffer();
    if (this.pendingApprovals.size === 0) {
      this.emitStatus('idle');
    }
  }

  // --- Private: Apply Settings ---

  private applySettings(settings: TurnSettings): void {
    if (settings.model !== undefined) {
      this._settings = { ...this._settings, model: settings.model };
    }
    if (settings.permissionMode !== undefined) {
      this._settings = { ...this._settings, permissionMode: settings.permissionMode };
    }
  }

  // --- Private: HTTP Helpers ---

  private async postJson<T>(path: string, body: unknown): Promise<T | undefined> {
    const url = `${this.baseUrl}${path}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });

    if (resp.status === 204) return undefined;

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`POST ${path} failed: ${resp.status} ${text}`);
    }

    const contentType = resp.headers.get('content-type') ?? '';
    if (contentType.includes('json')) {
      return (await resp.json()) as T;
    }
    return undefined;
  }

  // --- Private: Streaming Emission ---

  private scheduleStreamingEmit(): void {
    if (this.streamingEmitTimer !== null) return;
    this.streamingEmitTimer = setTimeout(() => {
      this.streamingEmitTimer = null;
      this.flushStreamingEmit();
    }, OpenCodeAgentAdapter.STREAMING_EMIT_INTERVAL);
  }

  private flushStreamingEmit(): void {
    if (this.streamingEmitTimer !== null) {
      clearTimeout(this.streamingEmitTimer);
      this.streamingEmitTimer = null;
    }

    const content: ContentBlock[] = [];
    if (this.streamingThinking) {
      content.push({ type: 'thinking', thinking: this.streamingThinking });
    }
    if (this.streamingText) {
      content.push({ type: 'text', text: this.streamingText });
    }
    if (content.length === 0) return;

    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'streaming_content',
        content,
      } as unknown as ChannelEvent,
    });
  }

  private clearStreamingBuffer(): void {
    if (this.streamingEmitTimer !== null) {
      clearTimeout(this.streamingEmitTimer);
      this.streamingEmitTimer = null;
    }

    const wasStreaming = this.streamingText.length > 0 || this.streamingThinking.length > 0;
    this.streamingText = '';
    this.streamingThinking = '';

    if (!wasStreaming) return;

    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'streaming_content',
        content: null,
      } as unknown as ChannelEvent,
    });
  }

  // --- Private: Event Emitters ---

  private emitStatus(status: 'idle' | 'active'): void {
    if (this._closed) return;
    this._status = status;
    this.outputQueue.enqueue({
      type: 'event',
      event: { type: 'status', status },
    });
  }

  private emitError(error: Error | string): void {
    if (this._closed) return;
    log({
      source: 'session',
      level: 'error',
      summary: `Adapter: error (${this._sessionId?.slice(0, 12) ?? 'unknown'}…)`,
      data: { sessionId: this._sessionId, error: typeof error === 'string' ? error : error.message },
    });
    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'error',
        error: typeof error === 'string' ? error : error.message,
      },
    });
  }

  private emitSettingsChanged(): void {
    if (this._closed) return;
    this.outputQueue.enqueue({
      type: 'event',
      event: {
        type: 'notification',
        kind: 'settings_changed',
        settings: this._settings,
      },
    });
  }
}
