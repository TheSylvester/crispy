/**
 * Concierge — Natural-language Discord bot powered by a Claude session
 *
 * The concierge is a system-kind Claude session that manages the workspace.
 * Users interact via DM or @mention; the concierge creates sessions, loads
 * past work via recall, lists activity, and refuses coding work.
 *
 * Tool mechanism: text-based command parsing. The system prompt instructs
 * Claude to emit <command> JSON tags. The subscriber parses them, executes
 * the action via session-manager, and sends results back as follow-up turns.
 *
 * The session resets after 5 minutes of inactivity.
 *
 * @module message-view/concierge
 */

import { execSync } from 'node:child_process';
import { log } from '../log.js';
import {
  sendTurn,
  listAllSessions,
  resolveSessionPrefix,
  interruptSession,
  getRegisteredVendors,
} from '../session-manager.js';
import { getActiveChannels } from '../session-channel.js';
import type { Subscriber, SubscriberMessage } from '../session-channel.js';
import type { Vendor, ContentBlock } from '../transcript.js';
import type { TurnIntent } from '../agent-adapter.js';
import { sendMessage } from './discord-transport.js';

const SOURCE = 'concierge';
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const CONCIERGE_SYSTEM_PROMPT = `You are CrispyBot, a workspace concierge for Crispy.
Your job is session management ONLY. You create, load, list, and manage coding sessions.
You NEVER write code, make architectural decisions, or do work that belongs in a session.

When a user asks you to do coding work, politely decline and offer to create a session for it instead.

You have these tools, invoked by emitting a <command> JSON block:

1. create_session — Create a new coding session
   <command>{"action": "create_session", "prompt": "fix the auth tests", "vendor": "claude"}</command>
   vendor is optional (defaults to "claude").

2. load_session — Load an existing session by ID prefix
   <command>{"action": "load_session", "session_id_prefix": "a1b2c3d4"}</command>

3. list_sessions — List recent sessions
   <command>{"action": "list_sessions"}</command>

4. stop_session — Interrupt a running session
   <command>{"action": "stop_session", "session_id_prefix": "a1b2c3d4"}</command>

5. recall — Search past session transcripts
   <command>{"action": "recall", "query": "parser refactoring"}</command>

6. bot_status — Show bot uptime and stats
   <command>{"action": "bot_status"}</command>

RULES:
- Always use exactly ONE <command> tag per response when you need to perform an action.
- After a command executes, you'll receive the result as a follow-up message. Use it to compose your reply to the user.
- When you create or load a session, include the forum post link from the result in your reply.
- Keep responses concise and helpful.
- If someone asks you to write code, explain a concept, review architecture, etc., politely refuse and offer to create a session instead.`;

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let conciergeSessionId: string | null = null;
/** All session IDs associated with the concierge (pending + real) — used to block auto-watch. */
const conciergeSessionIds = new Set<string>();
let conciergeLastActivity = 0;
let conciergeReady: Promise<void> | null = null;
let conciergeReadyResolve: (() => void) | null = null;
let startTime = 0;
let conciergeModel = 'haiku';
let guildId = '';

/** Callback to create a session and return {sessionId, forumPostLink}. */
type CreateSessionFn = (vendor: Vendor, prompt: string) => Promise<{ sessionId: string; link: string }>;
/** Callback to watch/open an existing session and return its link. */
type OpenSessionFn = (sessionIdPrefix: string) => Promise<string>;

let createSessionFn: CreateSessionFn | null = null;
let openSessionFn: OpenSessionFn | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface ConciergeConfig {
  model: string;
  guildId: string;
  startTime: number;
  createSession: CreateSessionFn;
  openSession: OpenSessionFn;
}

export function initConcierge(config: ConciergeConfig): void {
  conciergeModel = config.model;
  guildId = config.guildId;
  startTime = config.startTime;
  createSessionFn = config.createSession;
  openSessionFn = config.openSession;
  log({ source: SOURCE, level: 'info', summary: `concierge initialized (model: ${conciergeModel})` });
}

/** Check if a session ID belongs to the concierge (pending or real). */
export function isConciergeSession(sessionId: string): boolean {
  return conciergeSessionIds.has(sessionId);
}

export function shutdownConcierge(): void {
  conciergeSessionId = null;
  conciergeLastActivity = 0;
  conciergeReady = null;
  conciergeReadyResolve = null;
  createSessionFn = null;
  openSessionFn = null;
}

/** Call on heartbeat to check inactivity timeout. */
export function checkConciergeTimeout(): void {
  if (conciergeSessionId && Date.now() - conciergeLastActivity > INACTIVITY_TIMEOUT_MS) {
    log({ source: SOURCE, level: 'info', summary: 'concierge session timed out — will create fresh on next DM' });
    conciergeSessionId = null;
    conciergeReady = null;
    conciergeReadyResolve = null;
  }
}

/**
 * Route a DM or @mention message to the concierge.
 * Creates the concierge session on first use (or after timeout).
 */
export async function routeToConcierge(dmChannelId: string, text: string): Promise<void> {
  conciergeLastActivity = Date.now();

  // If session is being created, wait for it
  if (conciergeReady && !conciergeSessionId) {
    await conciergeReady;
  }

  // Create session if needed
  if (!conciergeSessionId) {
    await createConciergeSession(dmChannelId, text);
    return;
  }

  // Send as follow-up turn
  await sendConciergeTurn(dmChannelId, text);
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

async function createConciergeSession(dmChannelId: string, firstMessage: string): Promise<void> {
  // Gate concurrent callers
  conciergeReady = new Promise<void>((resolve) => { conciergeReadyResolve = resolve; });

  const subscriber = buildConciergeSubscriber(dmChannelId);

  const intent: TurnIntent = {
    target: {
      kind: 'new',
      vendor: 'claude' as Vendor,
      cwd: process.cwd(),
      sessionKind: 'system',
      systemPrompt: CONCIERGE_SYSTEM_PROMPT,
    },
    content: [{ type: 'text', text: firstMessage }],
    clientMessageId: crypto.randomUUID(),
    settings: { model: conciergeModel },
  };

  try {
    const result = await sendTurn(intent, subscriber);
    // Block auto-watch immediately — add pending ID, then real ID after rekey
    conciergeSessionIds.add(result.sessionId);
    conciergeSessionId = result.sessionId;
    const realId = result.rekeyPromise ? await result.rekeyPromise : result.sessionId;
    conciergeSessionIds.add(realId);
    conciergeSessionId = realId;
    log({ source: SOURCE, level: 'info', summary: `concierge session created: ${realId.slice(0, 12)}` });
  } catch (err) {
    log({ source: SOURCE, level: 'error', summary: 'failed to create concierge session', data: err });
    await sendMessage(dmChannelId, 'Sorry, I failed to start up. Please try again.').catch(() => {});
    conciergeSessionId = null;
  } finally {
    conciergeReadyResolve?.();
    conciergeReady = null;
    conciergeReadyResolve = null;
  }
}

async function sendConciergeTurn(dmChannelId: string, text: string): Promise<void> {
  if (!conciergeSessionId) return;

  const subscriber = buildConciergeSubscriber(dmChannelId);
  const intent: TurnIntent = {
    target: { kind: 'existing', sessionId: conciergeSessionId },
    content: [{ type: 'text', text }],
    clientMessageId: crypto.randomUUID(),
    settings: {},
  };

  try {
    await sendTurn(intent, subscriber);
  } catch (err) {
    log({ source: SOURCE, level: 'error', summary: 'concierge follow-up turn failed', data: err });
    // Session may be dead — reset so next DM creates fresh
    conciergeSessionId = null;
    await sendMessage(dmChannelId, 'Something went wrong. Please try again.').catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Subscriber — parses assistant text for <command> tags, executes, replies
// ---------------------------------------------------------------------------

function buildConciergeSubscriber(dmChannelId: string): Subscriber {
  let pendingText = '';

  return {
    id: `concierge-${dmChannelId}`,
    send(event: SubscriberMessage): void {
      if (event.type === 'entry') {
        const entry = event.entry;
        if (entry.type !== 'assistant') return;

        const content = entry.message?.content;
        if (!content) return;

        const textParts: string[] = [];
        if (typeof content === 'string') {
          textParts.push(content);
        } else if (Array.isArray(content)) {
          for (const block of content as ContentBlock[]) {
            if (block.type === 'text' && block.text) {
              textParts.push(block.text);
            }
          }
        }

        const fullText = textParts.join('\n');
        if (!fullText) return;

        // Check for <command> tags
        const commandMatch = fullText.match(/<command>([\s\S]*?)<\/command>/);
        if (commandMatch) {
          const jsonStr = commandMatch[1].trim();
          // Strip the command from the display text
          const displayText = fullText.replace(/<command>[\s\S]*?<\/command>/g, '').trim();
          if (displayText) {
            pendingText = displayText;
          }

          // Execute command asynchronously
          void executeCommand(dmChannelId, jsonStr, pendingText).catch((err) => {
            log({ source: SOURCE, level: 'error', summary: 'command execution failed', data: err });
          });
          pendingText = '';
        } else {
          // Plain text response — send to DM
          const trimmed = fullText.trim();
          if (trimmed) {
            void sendMessage(dmChannelId, trimmed.slice(0, 4000)).catch(() => {});
          }
        }
      }

      if (event.type === 'event') {
        const evt = event.event;
        if (evt.type === 'status' && evt.status === 'idle') {
          // Turn complete — flush any pending text
          if (pendingText) {
            void sendMessage(dmChannelId, pendingText.slice(0, 4000)).catch(() => {});
            pendingText = '';
          }
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

interface ConciergeCommand {
  action: string;
  prompt?: string;
  vendor?: string;
  session_id_prefix?: string;
  query?: string;
}

async function executeCommand(dmChannelId: string, jsonStr: string, prefixText: string): Promise<void> {
  let cmd: ConciergeCommand;
  try {
    cmd = JSON.parse(jsonStr) as ConciergeCommand;
  } catch {
    await sendResultToSession(dmChannelId, 'Error: invalid command JSON');
    return;
  }

  let result: string;
  try {
    switch (cmd.action) {
      case 'create_session':
        result = await execCreateSession(cmd);
        break;
      case 'load_session':
        result = await execLoadSession(cmd);
        break;
      case 'list_sessions':
        result = execListSessions();
        break;
      case 'stop_session':
        result = await execStopSession(cmd);
        break;
      case 'recall':
        result = execRecall(cmd);
        break;
      case 'bot_status':
        result = execBotStatus();
        break;
      default:
        result = `Unknown action: ${cmd.action}`;
    }
  } catch (err) {
    result = `Error: ${err instanceof Error ? err.message : String(err)}`;
  }

  // Send prefix text + result directly to the DM so the user gets immediate feedback
  const dmText = prefixText ? `${prefixText}\n\n${result}` : result;
  await sendMessage(dmChannelId, dmText.slice(0, 4000)).catch(() => {});

  // Also feed result back to the concierge session for context continuity
  void sendResultToSession(dmChannelId, result).catch((err) => {
    log({ source: SOURCE, level: 'debug', summary: 'concierge context update failed', data: err });
  });
}

async function sendResultToSession(dmChannelId: string, result: string): Promise<void> {
  if (!conciergeSessionId) return;

  const subscriber = buildConciergeSubscriber(dmChannelId);
  const intent: TurnIntent = {
    target: { kind: 'existing', sessionId: conciergeSessionId },
    content: [{ type: 'text', text: `[Command Result]\n${result}` }],
    clientMessageId: crypto.randomUUID(),
    settings: {},
  };

  try {
    await sendTurn(intent, subscriber);
  } catch (err) {
    log({ source: SOURCE, level: 'error', summary: 'failed to send command result to concierge', data: err });
    // Fall back: send raw result directly to DM
    await sendMessage(dmChannelId, result.slice(0, 4000)).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function execCreateSession(cmd: ConciergeCommand): Promise<string> {
  if (!createSessionFn) return 'Error: session creation not available';
  if (!cmd.prompt) return 'Error: prompt is required';

  const vendor = (cmd.vendor ?? 'claude') as Vendor;
  const registeredVendors = getRegisteredVendors();
  if (!registeredVendors.has(vendor)) {
    return `Error: vendor "${vendor}" not available. Registered: ${[...registeredVendors].join(', ')}`;
  }

  const { sessionId, link } = await createSessionFn(vendor, cmd.prompt);
  return `Session created: ${sessionId.slice(0, 8)}\nLink: ${link}`;
}

async function execLoadSession(cmd: ConciergeCommand): Promise<string> {
  if (!openSessionFn) return 'Error: session loading not available';
  if (!cmd.session_id_prefix) return 'Error: session_id_prefix is required';

  try {
    const link = await openSessionFn(cmd.session_id_prefix);
    return `Session loaded.\nLink: ${link}`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function execListSessions(): string {
  const allSessions = listAllSessions();
  const recent = allSessions
    .filter(s => s.sessionKind !== 'system')
    .slice(0, 10);

  if (recent.length === 0) return 'No sessions found.';

  const lines: string[] = [];
  for (const s of recent) {
    const prefix = s.sessionId.slice(0, 8);
    const title = (s.title ?? s.label ?? '(untitled)').slice(0, 60);
    const ago = formatRelativeTime(s.modifiedAt);
    const active = getActiveChannels().some(ch => ch.channelId === s.sessionId) ? ' [active]' : '';
    lines.push(`${prefix} | ${s.vendor} | ${title} (${ago})${active}`);
  }
  return `Recent sessions (${lines.length}):\n${lines.join('\n')}`;
}

async function execStopSession(cmd: ConciergeCommand): Promise<string> {
  if (!cmd.session_id_prefix) return 'Error: session_id_prefix is required';

  try {
    const resolvedId = resolveSessionPrefix(cmd.session_id_prefix);
    await interruptSession(resolvedId);
    return `Session ${resolvedId.slice(0, 8)} interrupted.`;
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function execRecall(cmd: ConciergeCommand): string {
  if (!cmd.query) return 'Error: query is required';

  const recallCli = process.env['RECALL_CLI'];
  if (!recallCli) return 'Error: recall is not available (RECALL_CLI not set)';

  try {
    const output = execSync(`${recallCli} ${JSON.stringify(cmd.query)}`, {
      encoding: 'utf-8',
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    });
    return output.trim().slice(0, 3000) || 'No results found.';
  } catch (err) {
    return `Recall error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function execBotStatus(): string {
  const uptimeMs = Date.now() - startTime;
  const uptimeMin = Math.floor(uptimeMs / 60000);
  const activeCount = getActiveChannels().length;
  const allSessions = listAllSessions().filter(s => s.sessionKind !== 'system');
  return `Uptime: ${uptimeMin}m\nActive channels: ${activeCount}\nTotal sessions: ${allSessions.length}\nConcierge model: ${conciergeModel}`;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}
