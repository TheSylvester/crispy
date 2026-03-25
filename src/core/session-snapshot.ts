/**
 * Session Snapshot — canonical subscriber-event interpretation
 *
 * Pure helpers that apply session-channel subscriber messages to a derived
 * snapshot used by consumers that need transcript history, status, approvals,
 * settings, and context usage with consistent semantics.
 *
 * @module session-snapshot
 */

import type { AdapterSettings, ChannelMessage } from './agent-adapter.js';
import type {
  ChannelCatchupMessage,
  PendingApprovalInfo,
} from './channel-events.js';
import type { WatchStatus } from './message-view/render.js';
import type { SubscriberMessage } from './session-channel.js';
import type { ContextUsage, ToolResultBlock, TranscriptEntry } from './transcript.js';

export interface SessionSnapshot {
  entries: TranscriptEntry[];
  toolResults: Map<string, boolean>;
  status: WatchStatus;
  pendingApprovals: PendingApprovalInfo[];
  settings: AdapterSettings | null;
  contextUsage: ContextUsage | null;
}

export function createSessionSnapshot(): SessionSnapshot {
  return {
    entries: [],
    toolResults: new Map(),
    status: 'connecting',
    pendingApprovals: [],
    settings: null,
    contextUsage: null,
  };
}

export function applySubscriberMessage(
  snapshot: SessionSnapshot,
  msg: SubscriberMessage,
): SessionSnapshot {
  return msg.type === 'catchup' ? applyCatchup(snapshot, msg) : applyChannelMessage(snapshot, msg);
}

export function applyCatchup(
  _snapshot: SessionSnapshot,
  msg: ChannelCatchupMessage,
): SessionSnapshot {
  return {
    entries: [...msg.entries],
    toolResults: buildToolResults(msg.entries),
    status: mapCatchupState(msg.state),
    pendingApprovals: [...msg.pendingApprovals],
    settings: msg.settings,
    contextUsage: msg.contextUsage,
  };
}

export function applyChannelMessage(
  snapshot: SessionSnapshot,
  msg: ChannelMessage,
): SessionSnapshot {
  if (msg.type === 'entry') {
    return {
      ...snapshot,
      entries: [...snapshot.entries, msg.entry],
      toolResults: applyEntryToolResults(snapshot.toolResults, msg.entry),
    };
  }

  const event = msg.event;
  if (event.type === 'status') {
    switch (event.status) {
      case 'active':
        return {
          ...snapshot,
          status: 'working',
        };
      case 'idle':
        return {
          ...snapshot,
          status: 'idle',
          pendingApprovals: [],
        };
      case 'background':
        return {
          ...snapshot,
          status: 'background',
          pendingApprovals: [],
        };
      case 'awaiting_approval':
        return {
          ...snapshot,
          status: 'approval',
          pendingApprovals: upsertApproval(snapshot.pendingApprovals, {
            toolUseId: event.toolUseId,
            toolName: event.toolName,
            input: event.input,
            reason: event.reason,
            options: event.options,
          }),
        };
    }
  }

  if (event.type === 'notification' && event.kind === 'settings_changed') {
    return {
      ...snapshot,
      settings: event.settings,
    };
  }

  return snapshot;
}

function mapCatchupState(
  state: ChannelCatchupMessage['state'],
): WatchStatus {
  switch (state) {
    case 'streaming':
    case 'active':
      return 'working';
    case 'idle':
      return 'idle';
    case 'background':
      return 'background';
    case 'awaiting_approval':
      return 'approval';
    case 'unattached':
    default:
      return 'connecting';
  }
}

function buildToolResults(entries: TranscriptEntry[]): Map<string, boolean> {
  const toolResults = new Map<string, boolean>();
  for (const entry of entries) {
    if (entry.type !== 'user' && entry.type !== 'result') continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block.type === 'tool_result') {
        toolResults.set((block as ToolResultBlock).tool_use_id, !!(block as ToolResultBlock).is_error);
      }
    }
  }
  return toolResults;
}

function applyEntryToolResults(
  toolResults: Map<string, boolean>,
  entry: TranscriptEntry,
): Map<string, boolean> {
  const blocks = extractToolResultBlocks(entry);
  if (blocks.length === 0) return toolResults;

  const next = new Map(toolResults);
  for (const block of blocks) {
    next.set(block.tool_use_id, !!block.is_error);
  }
  return next;
}

function extractToolResultBlocks(entry: TranscriptEntry): ToolResultBlock[] {
  if (entry.type !== 'user' && entry.type !== 'result') return [];

  const content = entry.message?.content;
  if (!Array.isArray(content)) return [];

  return content.filter((block): block is ToolResultBlock => block.type === 'tool_result');
}

function upsertApproval(
  approvals: PendingApprovalInfo[],
  nextApproval: PendingApprovalInfo,
): PendingApprovalInfo[] {
  const next = approvals.filter((approval) => approval.toolUseId !== nextApproval.toolUseId);
  next.push(nextApproval);
  return next;
}
