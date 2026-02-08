/**
 * Claude Agent Adapter
 *
 * Implements AgentAdapter by composing ClaudeCodeChannel (live session)
 * with the free history/discovery functions. Thin delegation — no stream
 * reprocessing, no duplicate approval handling.
 *
 * Claude-specific controls (metadata, interrupt, setModel, etc.) are
 * exposed as additional properties for callers that know they're talking
 * to Claude, but are not part of the AgentAdapter/Channel contract.
 *
 * @module claude-agent-adapter
 */

import type { AgentAdapter, SessionInfo } from '../../agent-adapter.js';
import type { ChannelMessage, MessageContent } from '../../channel.js';
import type { ChannelStatus } from '../../channel-events.js';
import type { TranscriptEntry, ContextUsage } from '../../transcript.js';

import {
  ClaudeCodeChannel,
  findSession as claudeFindSession,
  listSessions as claudeListSessions,
  loadHistory as claudeLoadHistory,
} from './claude-code-adapter.js';
import type {
  ClaudeSessionOptions,
  ClaudeSessionMetadata,
  McpServerConfig,
  McpSetServersResult,
  ModelInfo,
  SlashCommand,
  McpServerStatus,
  AccountInfo,
  SDKControlInitializeResponse,
  RewindFilesResult,
} from './claude-code-adapter.js';
import type { PermissionMode } from '@anthropic-ai/claude-agent-sdk';

// Re-export for convenience — callers creating a ClaudeAgentAdapter need these
export type { ClaudeSessionOptions, ClaudeSessionMetadata };

export class ClaudeAgentAdapter implements AgentAdapter {
  private readonly channel: ClaudeCodeChannel;

  constructor(options: ClaudeSessionOptions) {
    this.channel = new ClaudeCodeChannel(options);
  }

  // --------------------------------------------------------------------------
  // Channel delegation (all 7 Channel members forwarded)
  // --------------------------------------------------------------------------

  get vendor(): 'claude' { return this.channel.vendor; }
  get sessionId() { return this.channel.sessionId; }
  get status(): ChannelStatus { return this.channel.status; }

  messages(): AsyncIterable<ChannelMessage> { return this.channel.messages(); }
  send(content: MessageContent): void { this.channel.send(content); }

  respondToApproval(toolUseId: string, optionId: string): void {
    this.channel.respondToApproval(toolUseId, optionId);
  }

  close(): void { this.channel.close(); }

  // --------------------------------------------------------------------------
  // History / Discovery (delegate to free functions)
  // --------------------------------------------------------------------------

  /**
   * Load transcript history for a session by ID.
   *
   * Resolves the session ID to a file path first, since the underlying
   * `loadHistory()` free function takes a file path, not a session ID.
   */
  async loadHistory(sessionId: string): Promise<TranscriptEntry[]> {
    const info = claudeFindSession(sessionId);
    if (!info) return [];
    return claudeLoadHistory(info.path);
  }

  /**
   * Find a session by ID across all Claude projects.
   *
   * Returns the Claude-specific SessionInfo (with `vendor: 'claude'`),
   * which satisfies the widened SessionInfo type (`vendor: Vendor`).
   */
  findSession(sessionId: string): SessionInfo | undefined {
    return claudeFindSession(sessionId);
  }

  /** List all Claude sessions, most recently modified first. */
  listSessions(): SessionInfo[] {
    return claudeListSessions();
  }

  // --------------------------------------------------------------------------
  // Claude-specific access (not on AgentAdapter / Channel)
  // --------------------------------------------------------------------------

  /** Session metadata captured from the SDK init message. */
  get metadata(): ClaudeSessionMetadata | null { return this.channel.metadata; }

  /** Cumulative context usage (updated after each assistant/result message). */
  get contextUsage(): ContextUsage | null { return this.channel.contextUsage; }

  // --------------------------------------------------------------------------
  // Live controls — forward to inner channel
  // --------------------------------------------------------------------------

  async interrupt(): Promise<void> { return this.channel.interrupt(); }
  async setModel(model?: string): Promise<void> { return this.channel.setModel(model); }
  async setPermissionMode(mode: PermissionMode): Promise<void> { return this.channel.setPermissionMode(mode); }
  async setMaxThinkingTokens(tokens: number | null): Promise<void> { return this.channel.setMaxThinkingTokens(tokens); }
  async initializationResult(): Promise<SDKControlInitializeResponse> { return this.channel.initializationResult(); }
  async supportedModels(): Promise<ModelInfo[]> { return this.channel.supportedModels(); }
  async supportedCommands(): Promise<SlashCommand[]> { return this.channel.supportedCommands(); }
  async mcpServerStatus(): Promise<McpServerStatus[]> { return this.channel.mcpServerStatus(); }
  async accountInfo(): Promise<AccountInfo> { return this.channel.accountInfo(); }
  async rewindFiles(userMessageId: string, opts?: { dryRun?: boolean }): Promise<RewindFilesResult> { return this.channel.rewindFiles(userMessageId, opts); }
  async reconnectMcpServer(serverName: string): Promise<void> { return this.channel.reconnectMcpServer(serverName); }
  async toggleMcpServer(serverName: string, enabled: boolean): Promise<void> { return this.channel.toggleMcpServer(serverName, enabled); }
  async setMcpServers(servers: Record<string, McpServerConfig>): Promise<McpSetServersResult> { return this.channel.setMcpServers(servers); }
}
