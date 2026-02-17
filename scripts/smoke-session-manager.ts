/**
 * Smoke Test — Session Manager Pipeline
 *
 * Part 1: Exercises the full session-manager pipeline against real Claude
 * session data on disk: session-manager -> session-channel -> claude-code-adapter -> JSONL.
 * No mocks, no SDK connection — disk history only. Always runs.
 *
 * Part 2: Live session lifecycle — creates a real session via the SDK, sends
 * messages, observes streaming, disconnects, reloads from disk, and resumes.
 * Only runs when --live flag is passed (costs real API tokens).
 *
 * Usage:
 *   npx tsx scripts/smoke-session-manager.ts          # Part 1 only
 *   npx tsx scripts/smoke-session-manager.ts --live    # Part 1 + Part 2
 */

import {
  registerAdapter,
  unregisterAdapter,
  listAllSessions,
  loadSession,
  subscribeSession,
  sendToSession,
  closeSession,
  _resetRegistry,
} from '../src/core/session-manager.js';

import { ClaudeAgentAdapter, claudeDiscovery } from '../src/core/adapters/claude/claude-code-adapter.js';
import type { SessionOpenSpec } from '../src/core/agent-adapter.js';

import type { Subscriber, SessionChannel } from '../src/core/session-channel.js';
import type { ChannelMessage } from '../src/core/agent-adapter.js';
import type { HistoryMessage, ChannelCatchupMessage } from '../src/core/channel-events.js';

/** Union of all messages a subscriber can receive. */
type SubscriberMessage = ChannelMessage | HistoryMessage | ChannelCatchupMessage;
import {
  createChannel,
  setAdapter,
  subscribe,
  sendMessage,
  destroyChannel,
} from '../src/core/session-channel.js';

/** Whether --live was passed on the command line. */
const LIVE_MODE = process.argv.includes('--live');

// ============================================================================
// Formatting helpers
// ============================================================================

const PASS = '\x1b[32mPASS\x1b[0m';
const FAIL = '\x1b[31mFAIL\x1b[0m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function header(title: string): void {
  console.log(`\n${BOLD}--- ${title} ---${RESET}`);
}

function indent(text: string, level = 1): string {
  return text.split('\n').map(line => '  '.repeat(level) + line).join('\n');
}

function formatDate(d: Date): string {
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

// ============================================================================
// Step tracker
// ============================================================================

interface StepResult {
  name: string;
  passed: boolean;
  detail?: string;
}

const results: StepResult[] = [];

function recordStep(name: string, passed: boolean, detail?: string): void {
  results.push({ name, passed, detail });
  const icon = passed ? PASS : FAIL;
  console.log(`  ${icon}  ${name}`);
  if (detail) console.log(indent(detail, 2));
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log(`${BOLD}Session Manager Smoke Test${RESET}`);
  console.log(`${DIM}Pipeline: session-manager -> session-channel -> claude-code-adapter -> JSONL${RESET}`);

  // --------------------------------------------------------------------------
  // Step 1: Create adapter factory
  // --------------------------------------------------------------------------
  header('Step 1: Create adapter factory');

  const cwd = process.cwd();
  const createClaudeAdapter = (spec: SessionOpenSpec): ClaudeAgentAdapter => {
    switch (spec.mode) {
      case 'resume':
        return new ClaudeAgentAdapter({ cwd, resume: spec.sessionId });
      case 'fresh':
        return new ClaudeAgentAdapter({
          cwd: spec.cwd,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
        });
      case 'fork':
        return new ClaudeAgentAdapter({
          cwd, resume: spec.fromSessionId, forkSession: true,
          ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
        });
      case 'continue':
        return new ClaudeAgentAdapter({ cwd, resume: spec.sessionId, continue: true });
    }
  };
  recordStep('Adapter factory created', true, `vendor: ${claudeDiscovery.vendor}`);

  // --------------------------------------------------------------------------
  // Step 2: Register adapter with session manager
  // --------------------------------------------------------------------------
  header('Step 2: Register adapter');

  try {
    registerAdapter(claudeDiscovery, createClaudeAdapter);
    recordStep('registerAdapter() succeeded', true);
  } catch (err) {
    recordStep('registerAdapter() succeeded', false, String(err));
    _resetRegistry();
    printSummary();
    process.exit(1);
  }

  // --------------------------------------------------------------------------
  // Step 3: List all sessions
  // --------------------------------------------------------------------------
  header('Step 3: List all sessions');

  let sessions: ReturnType<typeof listAllSessions>;
  try {
    sessions = listAllSessions();

    if (sessions.length === 0) {
      console.log('\n  No Claude sessions found on disk.');
      console.log('  This is not an error — there are simply no transcripts under ~/.claude/projects/.');
      console.log('  Run a Claude Code session first, then re-run this smoke test.\n');
      _resetRegistry();
      process.exit(0);
    }

    recordStep(`listAllSessions() returned ${sessions.length} session(s)`, true);

    // Print the 3 most recent
    const top3 = sessions.slice(0, 3);
    console.log(`\n  ${DIM}3 most recent sessions:${RESET}`);
    for (const s of top3) {
      const label = s.label
        ? (s.label.length > 60 ? s.label.slice(0, 57) + '...' : s.label)
        : '(none)';
      console.log(indent(
        `${s.sessionId.slice(0, 8)}..  ${DIM}|${RESET}  ` +
        `vendor: ${s.vendor}  ${DIM}|${RESET}  ` +
        `modified: ${formatDate(s.modifiedAt)}  ${DIM}|${RESET}  ` +
        `label: ${label}`,
      ));
    }
  } catch (err) {
    recordStep('listAllSessions() succeeded', false, String(err));
    _resetRegistry();
    printSummary();
    process.exit(1);
  }

  // --------------------------------------------------------------------------
  // Step 4: Pick the most recent session
  // --------------------------------------------------------------------------
  header('Step 4: Pick most recent session');

  const target = sessions[0];
  const targetLabel = target.label
    ? (target.label.length > 80 ? target.label.slice(0, 77) + '...' : target.label)
    : '(none)';
  console.log(indent(
    `sessionId: ${target.sessionId}\n` +
    `vendor:    ${target.vendor}\n` +
    `label:     ${targetLabel}\n` +
    `modified:  ${formatDate(target.modifiedAt)}`,
  ));
  recordStep('Most recent session selected', true);

  // --------------------------------------------------------------------------
  // Step 5: Load session (read-only path)
  // --------------------------------------------------------------------------
  header('Step 5: Load session (read-only)');

  try {
    const entries = await loadSession(target.sessionId);

    if (entries.length === 0) {
      recordStep('loadSession() returned entries', false, 'Got 0 entries — file may be empty or unparseable');
    } else {
      // Type breakdown
      const typeCounts = new Map<string, number>();
      for (const entry of entries) {
        typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
      }

      recordStep(`loadSession() returned ${entries.length} entries`, true);

      console.log(`\n  ${DIM}Type breakdown:${RESET}`);
      const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [type, count] of sorted) {
        console.log(indent(`${type}: ${count}`));
      }
    }
  } catch (err) {
    recordStep('loadSession() succeeded', false, String(err));
  }

  // --------------------------------------------------------------------------
  // Step 6: Subscribe to session with a logging subscriber
  // --------------------------------------------------------------------------
  header('Step 6: Subscribe to session');

  const collected: SubscriberMessage[] = [];
  const subscriber: Subscriber = {
    id: 'smoke-test-subscriber',
    send(event: SubscriberMessage): void {
      collected.push(event);
    },
  };

  let channel: Awaited<ReturnType<typeof subscribeSession>> | null = null;
  try {
    channel = await subscribeSession(target.sessionId, subscriber);
    recordStep(
      'subscribeSession() succeeded',
      true,
      `channel state: ${channel.state}, subscribers: ${channel.subscribers.size}`,
    );
  } catch (err) {
    recordStep('subscribeSession() succeeded', false, String(err));
  }

  // --------------------------------------------------------------------------
  // Step 7: Verify channel state and history backfill
  // --------------------------------------------------------------------------
  header('Step 7: Verify channel state and history backfill');

  if (channel) {
    // subscribeSession() calls loadHistory() -> broadcast() BEFORE adding
    // the subscriber, so the subscriber won't see the history event directly.
    // This is by design — the subscriber gets future live events only.
    // We verify the pipeline worked by inspecting channel state.

    const checks = {
      channelState: channel.state === 'idle',
      adapterAttached: channel.adapter !== null,
      adapterVendor: channel.adapter?.vendor === 'claude',
      subscriberRegistered: channel.subscribers.has('smoke-test-subscriber'),
      historyBackfilled: channel.entryIndex > 0,
    };

    recordStep(
      `Channel state is "idle"`,
      checks.channelState,
      `actual: "${channel.state}"`,
    );
    recordStep(
      'Adapter attached with correct vendor',
      checks.adapterAttached && checks.adapterVendor,
      `vendor: ${channel.adapter?.vendor ?? 'none'}`,
    );
    recordStep(
      'Subscriber registered on channel',
      checks.subscriberRegistered,
    );
    recordStep(
      `History backfilled (entryIndex > 0)`,
      checks.historyBackfilled,
      `entryIndex: ${channel.entryIndex} (entries loaded before subscriber was added)`,
    );

    // If the subscriber did receive any events (e.g. state_changed from
    // the consumption loop), report them too
    if (collected.length > 0) {
      const eventCounts = new Map<string, number>();
      for (const evt of collected) {
        eventCounts.set(evt.type, (eventCounts.get(evt.type) ?? 0) + 1);
      }
      console.log(`\n  ${DIM}Subscriber also received ${collected.length} live event(s):${RESET}`);
      for (const [type, count] of [...eventCounts.entries()].sort()) {
        console.log(indent(`${type}: ${count}`));
      }
    } else {
      console.log(`\n  ${DIM}Subscriber received 0 events (expected — no live session, history was delivered before subscribe)${RESET}`);
    }
  } else {
    recordStep('Channel inspection', false, 'No channel available (subscribeSession failed)');
  }

  // --------------------------------------------------------------------------
  // Step 8: Close session and confirm cleanup
  // --------------------------------------------------------------------------
  header('Step 8: Close session');

  try {
    closeSession(target.sessionId);
    recordStep('closeSession() succeeded', true);
  } catch (err) {
    recordStep('closeSession() succeeded', false, String(err));
  }

  // --------------------------------------------------------------------------
  // Step 9: Reset registry
  // --------------------------------------------------------------------------
  header('Step 9: Reset registry');

  try {
    _resetRegistry();
    recordStep('_resetRegistry() succeeded', true);
  } catch (err) {
    recordStep('_resetRegistry() succeeded', false, String(err));
  }

  // --------------------------------------------------------------------------
  // Part 1 Summary
  // --------------------------------------------------------------------------
  printSummary('Part 1 Summary');

  const part1Failed = results.some(r => !r.passed);

  // --------------------------------------------------------------------------
  // Part 2: Live Session Lifecycle (only with --live)
  // --------------------------------------------------------------------------
  if (LIVE_MODE) {
    if (part1Failed) {
      console.log(`\n${BOLD}Skipping Part 2 — Part 1 had failures${RESET}\n`);
    } else {
      await runPart2LiveSession();
      printSummary('Final Summary');
    }
  } else {
    console.log(`\n${DIM}Part 2 (live session lifecycle) skipped — pass --live to enable${RESET}`);
  }

  // --------------------------------------------------------------------------
  // Exit
  // --------------------------------------------------------------------------
  const anyFailed = results.some(r => !r.passed);
  process.exit(anyFailed ? 1 : 0);
}

function printSummary(title = 'Summary'): void {
  header(title);

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;
  const total = results.length;

  for (const r of results) {
    const icon = r.passed ? PASS : FAIL;
    console.log(`  ${icon}  ${r.name}`);
  }

  console.log('');
  if (failed === 0) {
    console.log(`  ${BOLD}${passed}/${total} steps passed${RESET} -- all clear\n`);
  } else {
    console.log(`  ${BOLD}${passed}/${total} steps passed, ${failed} failed${RESET}\n`);
  }
}

// ============================================================================
// Part 2: Live Session Lifecycle
// ============================================================================

/** Default timeout for waiting on streaming responses (ms). */
const STREAM_TIMEOUT_MS = 60_000;

/**
 * Helper: create a subscriber that collects events and resolves a promise
 * when the response turn is complete.
 *
 * "Turn complete" is detected by either:
 * 1. A state_changed event with state='idle' after seeing state='streaming'
 *    (the adapter's query iterator ended — e.g. maxTurns reached)
 * 2. A 'result' entry arriving (the SDK signals turn completion with a result
 *    message, but the query iterator may stay open for follow-up input)
 *
 * The second trigger is essential because the SDK's query() keeps the async
 * iterator alive after a turn completes (waiting for the next input from
 * the input queue). The adapter only emits 'idle' when the iterator itself
 * ends, which may not happen until close() is called.
 */
function createCollectingSubscriber(id: string): {
  subscriber: Subscriber;
  collected: SubscriberMessage[];
  waitForTurnComplete: () => Promise<void>;
} {
  const collected: SubscriberMessage[] = [];
  let sawStreaming = false;
  let turnResolve: (() => void) | null = null;
  let turnReject: ((err: Error) => void) | null = null;
  let resolved = false;

  const turnPromise = new Promise<void>((resolve, reject) => {
    turnResolve = resolve;
    turnReject = reject;
  });

  function markComplete(): void {
    if (resolved) return;
    resolved = true;
    turnResolve?.();
  }

  const subscriber: Subscriber = {
    id,
    send(event: SubscriberMessage): void {
      collected.push(event);

      // Handle catchup (initial state sync for late subscribers)
      if (event.type === 'catchup') {
        console.log(`    ${DIM}[${id}] catchup state -> ${event.state}${RESET}`);
        if (event.state === 'active' || event.state === 'streaming') sawStreaming = true;
        return;
      }

      // Handle status events (active/idle/awaiting_approval)
      if (event.type === 'event' && event.event.type === 'status') {
        const status = event.event.status;
        console.log(`    ${DIM}[${id}] status -> ${status}${RESET}`);
        if (status === 'active') sawStreaming = true;
        // Idle after streaming = turn complete (query iterator ended)
        if (status === 'idle' && sawStreaming) {
          markComplete();
        }
        return;
      }

      // Handle error notifications
      if (event.type === 'event' && event.event.type === 'notification' && event.event.kind === 'error') {
        const errorMsg = typeof event.event.error === 'string' ? event.event.error : event.event.error.message;
        console.log(`    ${DIM}[${id}] error: ${errorMsg}${RESET}`);
        if (!resolved) {
          resolved = true;
          turnReject?.(new Error(`Channel error: ${errorMsg}`));
        }
        return;
      }

      // Handle entry messages
      if (event.type === 'entry') {
        // Result entry = turn complete (SDK finished this turn's response)
        if (event.entry.type === 'result') {
          console.log(`    ${DIM}[${id}] result entry received (turn complete)${RESET}`);
          markComplete();
        }
      }
    },
  };

  function waitForTurnComplete(): Promise<void> {
    // If already resolved synchronously (events arrived before we started waiting)
    if (resolved) return Promise.resolve();

    // Check if a result entry or idle-after-streaming already arrived
    const hasResult = collected.some(e => e.type === 'entry' && e.entry.type === 'result');
    const hasIdleAfterStreaming = sawStreaming && collected.some(
      e => e.type === 'event' && e.event.type === 'status' && e.event.status === 'idle'
    );
    if (hasResult || hasIdleAfterStreaming) return Promise.resolve();

    return Promise.race([
      turnPromise,
      new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error(
          `Timed out after ${STREAM_TIMEOUT_MS / 1000}s waiting for turn to complete`
        )), STREAM_TIMEOUT_MS)
      ),
    ]);
  }

  return { subscriber, collected, waitForTurnComplete };
}

/** Summarize collected subscriber events for logging. */
function summarizeEvents(collected: SubscriberMessage[]): string {
  const counts = new Map<string, number>();
  for (const evt of collected) {
    let key: string;
    if (evt.type === 'catchup') {
      key = `catchup(${evt.state})`;
    } else if (evt.type === 'event' && evt.event.type === 'status') {
      key = `status(${evt.event.status})`;
    } else if (evt.type === 'event' && evt.event.type === 'notification') {
      key = `notification(${evt.event.kind})`;
    } else {
      key = evt.type;
    }
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}: ${count}`)
    .join(', ');
}

/**
 * Part 2: Live Session Lifecycle
 *
 * Creates a real Claude session via the SDK, sends messages, observes
 * streaming responses, disconnects, reloads from disk, and resumes.
 *
 * API design note: session-manager's subscribeSession() requires the session
 * to already exist on disk (it calls findSession()). For a brand-new session,
 * we must use the session-channel primitives directly (createChannel, setAdapter,
 * subscribe, sendMessage) to bootstrap the session. Once the adapter has
 * produced a sessionId and the SDK has written the JSONL to disk, we can use
 * session-manager's higher-level APIs for subsequent operations.
 */
async function runPart2LiveSession(): Promise<void> {
  console.log(`\n${BOLD}${'='.repeat(72)}${RESET}`);
  console.log(`${BOLD}Part 2: Live Session Lifecycle${RESET}`);
  console.log(`${DIM}Pipeline: session-manager -> session-channel -> claude-code-adapter -> SDK${RESET}`);
  console.log(`${BOLD}${'='.repeat(72)}${RESET}`);

  // Wrap everything in a try/catch so SDK failures don't crash Part 1 results
  try {
    await runPhaseA();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`\n  ${FAIL}  Part 2 aborted: ${msg}`);
    recordStep('Part 2: Live session lifecycle', false, msg);
    // Best-effort cleanup
    try { _resetRegistry(); } catch { /* ignore */ }
    return;
  }
}

/** Captured sessionId from Phase A, used by Phase B and C. */
let capturedSessionId: string | undefined;

async function runPhaseA(): Promise<void> {
  // ==========================================================================
  // Phase A: Create a new live session
  // ==========================================================================
  header('Phase A: Create a new live session');

  // A.1: Create a fresh adapter
  header('A.1: Create fresh ClaudeAgentAdapter');
  const liveAdapter = new ClaudeAgentAdapter({
    cwd: process.cwd(),
    maxTurns: 1,
    // No settingSources — avoid loading project settings that might interfere
    settingSources: [],
    // Capture stderr from the SDK subprocess for debugging
    stderr: (data: string) => {
      const trimmed = data.trim();
      if (trimmed) console.log(`    ${DIM}[sdk stderr] ${trimmed}${RESET}`);
    },
  });
  recordStep('Fresh ClaudeAgentAdapter created', true, `vendor: ${liveAdapter.vendor}`);

  // A.3: Create channel manually via session-channel primitives
  // (subscribeSession requires findSession which needs the session on disk)
  header('A.3: Create channel and subscribe');
  const channelId = `smoke-live-${Date.now()}`;
  const liveChannel = createChannel(channelId);
  setAdapter(liveChannel, liveAdapter);

  const { subscriber: liveSubscriber, collected: liveCollected, waitForTurnComplete } =
    createCollectingSubscriber('smoke-live-subscriber');
  subscribe(liveChannel, liveSubscriber);

  recordStep(
    'Channel created with adapter and subscriber',
    true,
    `channelId: ${channelId}, state: ${liveChannel.state}`,
  );

  // A.4: Send a trivial prompt to start the session
  header('A.4: Send prompt');
  const prompt = 'Respond with exactly: SMOKE_TEST_OK';
  console.log(`  ${DIM}Sending: "${prompt}"${RESET}`);

  try {
    sendMessage(liveChannel, prompt);
    recordStep('sendMessage() succeeded (query started)', true);
  } catch (err) {
    recordStep('sendMessage() succeeded', false, String(err));
    destroyChannel(channelId);
    unregisterAdapter('claude');
    throw err;
  }

  // A.5: Wait for streaming -> idle
  header('A.5: Wait for response');
  console.log(`  ${DIM}Waiting for turn to complete (timeout: ${STREAM_TIMEOUT_MS / 1000}s)...${RESET}`);

  try {
    await waitForTurnComplete();
    recordStep('Response turn completed', true);
  } catch (err) {
    // Dump collected events for debugging
    if (liveCollected.length > 0) {
      console.log(`\n  ${DIM}Events received before timeout (${liveCollected.length}):${RESET}`);
      console.log(`  ${DIM}${summarizeEvents(liveCollected)}${RESET}`);
    } else {
      console.log(`\n  ${DIM}No events received at all — SDK may have failed to start${RESET}`);
    }
    console.log(`  ${DIM}Channel state: ${liveChannel.state}${RESET}`);
    console.log(`  ${DIM}Adapter sessionId: ${liveAdapter.sessionId ?? '(none)'}${RESET}`);
    console.log(`  ${DIM}Adapter status: ${liveAdapter.status}${RESET}`);

    recordStep('Response turn completed', false, String(err));
    destroyChannel(channelId);
    unregisterAdapter('claude');
    throw err;
  }

  // A.6: Verify results
  header('A.6: Verify live session results');

  // Check we got at least one entry event
  const entryEvents = liveCollected.filter(e => e.type === 'entry');
  const assistantEntries = entryEvents.filter(
    e => e.type === 'entry' && e.entry.type === 'assistant'
  );
  const statusEvents = liveCollected.filter(
    e => e.type === 'event' && e.event.type === 'status'
  );

  recordStep(
    `Subscriber received ${liveCollected.length} event(s)`,
    liveCollected.length > 0,
    summarizeEvents(liveCollected),
  );
  recordStep(
    `Got ${entryEvents.length} entry event(s)`,
    entryEvents.length > 0,
  );
  recordStep(
    `Got ${assistantEntries.length} assistant entry/entries`,
    assistantEntries.length > 0,
  );
  // Note: We expect at least 1 status transition (active). The adapter's
  // query iterator stays open after a turn completes (waiting for follow-up
  // input), so the idle transition only comes when close() is called.
  recordStep(
    `Status transitions observed: ${statusEvents.length}`,
    statusEvents.length >= 1,
    statusEvents
      .filter((e): e is ChannelMessage & { event: { type: 'status' } } =>
        e.type === 'event' && e.event.type === 'status')
      .map(e => e.event.status)
      .join(' -> '),
  );

  // A.7: Capture sessionId
  capturedSessionId = liveAdapter.sessionId;
  recordStep(
    'Session ID captured from adapter',
    capturedSessionId !== undefined && capturedSessionId.length > 0,
    `sessionId: ${capturedSessionId ?? '(none)'}`,
  );

  if (!capturedSessionId) {
    destroyChannel(channelId);
    unregisterAdapter('claude');
    throw new Error('No sessionId captured — cannot proceed to Phase B/C');
  }

  // A.8: Tear down Phase A
  header('A.8: Tear down Phase A');
  destroyChannel(channelId);
  unregisterAdapter('claude');
  recordStep('Phase A cleanup complete', true, 'channel destroyed, adapter unregistered');

  // Brief delay to allow the SDK subprocess to flush the session file to disk.
  // The adapter.close() aborts the subprocess, but the OS may still be writing.
  await new Promise(resolve => setTimeout(resolve, 1_000));

  // Proceed to Phase B
  await runPhaseB();
}

async function runPhaseB(): Promise<void> {
  // ==========================================================================
  // Phase B: Disconnect and reload from disk
  // ==========================================================================
  header('Phase B: Disconnect and reload from disk');

  const sessionId = capturedSessionId!;

  // B.1: Register discovery + factory (simulates restart)
  header('B.1: Register discovery + factory (simulates restart)');
  const cwd = process.cwd();
  const createAdapter = (spec: SessionOpenSpec): ClaudeAgentAdapter => {
    switch (spec.mode) {
      case 'resume':
        return new ClaudeAgentAdapter({ cwd, resume: spec.sessionId });
      case 'fresh':
        return new ClaudeAgentAdapter({
          cwd: spec.cwd,
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
        });
      case 'fork':
        return new ClaudeAgentAdapter({
          cwd, resume: spec.fromSessionId, forkSession: true,
          ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
        });
      case 'continue':
        return new ClaudeAgentAdapter({ cwd, resume: spec.sessionId, continue: true });
    }
  };
  registerAdapter(claudeDiscovery, createAdapter);
  recordStep('Discovery + factory registered', true);

  // B.2: Load session from disk (read-only)
  header('B.2: Load session from disk');
  let diskEntries;
  try {
    diskEntries = await loadSession(sessionId);
    recordStep(
      `loadSession() returned ${diskEntries.length} entries`,
      diskEntries.length > 0,
    );
  } catch (err) {
    recordStep('loadSession() succeeded', false, String(err));
    unregisterAdapter('claude');
    throw err;
  }

  // B.3: Verify transcript content
  header('B.3: Verify transcript content');

  // Type breakdown
  const typeCounts = new Map<string, number>();
  for (const entry of diskEntries) {
    typeCounts.set(entry.type, (typeCounts.get(entry.type) ?? 0) + 1);
  }

  console.log(`\n  ${DIM}Type breakdown:${RESET}`);
  const sorted = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [type, count] of sorted) {
    console.log(indent(`${type}: ${count}`));
  }

  const hasUserEntry = diskEntries.some(e => e.type === 'user');
  const hasAssistantEntry = diskEntries.some(e => e.type === 'assistant');

  recordStep('Transcript contains user entry', hasUserEntry);
  recordStep('Transcript contains assistant entry', hasAssistantEntry);

  // B.4: Clean up before Phase C
  unregisterAdapter('claude');
  recordStep('Phase B cleanup complete', true, 'adapter unregistered');

  // Proceed to Phase C
  await runPhaseC();
}

async function runPhaseC(): Promise<void> {
  // ==========================================================================
  // Phase C: Resume the session
  // ==========================================================================
  header('Phase C: Resume the session');

  const sessionId = capturedSessionId!;

  // C.1: Register discovery + factory and subscribe to the session
  header('C.1: Subscribe to existing session');
  const cwd = process.cwd();
  const createResumeAdapter = (spec: SessionOpenSpec): ClaudeAgentAdapter => {
    switch (spec.mode) {
      case 'resume':
        return new ClaudeAgentAdapter({
          cwd, resume: spec.sessionId, maxTurns: 1, settingSources: [],
        });
      case 'fresh':
        return new ClaudeAgentAdapter({
          cwd: spec.cwd, maxTurns: 1, settingSources: [],
          ...(spec.model && { model: spec.model }),
          ...(spec.permissionMode && { permissionMode: spec.permissionMode }),
          ...(spec.extraArgs && { extraArgs: spec.extraArgs }),
        });
      case 'fork':
        return new ClaudeAgentAdapter({
          cwd, resume: spec.fromSessionId, forkSession: true, maxTurns: 1, settingSources: [],
          ...(spec.atMessageId && { resumeSessionAt: spec.atMessageId }),
        });
      case 'continue':
        return new ClaudeAgentAdapter({
          cwd, resume: spec.sessionId, continue: true, maxTurns: 1, settingSources: [],
        });
    }
  };
  registerAdapter(claudeDiscovery, createResumeAdapter);

  const { subscriber: resumeSubscriber, collected: resumeCollected, waitForTurnComplete: waitForResumeIdle } =
    createCollectingSubscriber('smoke-resume-subscriber');

  let resumeChannel: SessionChannel;
  try {
    resumeChannel = await subscribeSession(sessionId, resumeSubscriber);
    recordStep(
      'subscribeSession() succeeded',
      true,
      `channel state: ${resumeChannel.state}, entryIndex: ${resumeChannel.entryIndex}`,
    );
  } catch (err) {
    recordStep('subscribeSession() succeeded', false, String(err));
    unregisterAdapter('claude');
    _resetRegistry();
    throw err;
  }

  // C.2: Verify channel state and history backfill
  header('C.2: Verify channel state and history backfill');
  recordStep(
    `Channel state is "idle"`,
    resumeChannel.state === 'idle',
    `actual: "${resumeChannel.state}"`,
  );
  recordStep(
    `History backfilled (entryIndex > 0)`,
    resumeChannel.entryIndex > 0,
    `entryIndex: ${resumeChannel.entryIndex}`,
  );

  // C.3: Send a follow-up message
  header('C.3: Send follow-up message');
  const followUp = 'What was the first thing I said to you in this session?';
  console.log(`  ${DIM}Sending: "${followUp}"${RESET}`);

  try {
    sendToSession(sessionId, followUp);
    recordStep('sendToSession() succeeded', true);
  } catch (err) {
    recordStep('sendToSession() succeeded', false, String(err));
    closeSession(sessionId);
    _resetRegistry();
    throw err;
  }

  // C.4: Wait for response
  header('C.4: Wait for follow-up response');
  console.log(`  ${DIM}Waiting for turn to complete (timeout: ${STREAM_TIMEOUT_MS / 1000}s)...${RESET}`);

  try {
    await waitForResumeIdle();
    recordStep('Follow-up turn completed', true);
  } catch (err) {
    recordStep('Follow-up turn completed', false, String(err));
    closeSession(sessionId);
    _resetRegistry();
    throw err;
  }

  // C.5: Verify results
  header('C.5: Verify follow-up results');

  const resumeEntries = resumeCollected.filter(e => e.type === 'entry');
  const resumeAssistant = resumeEntries.filter(
    e => e.type === 'entry' && e.entry.type === 'assistant'
  );
  const resumeStatusEvents = resumeCollected.filter(
    e => e.type === 'event' && e.event.type === 'status'
  );

  recordStep(
    `Resume subscriber received ${resumeCollected.length} event(s)`,
    resumeCollected.length > 0,
    summarizeEvents(resumeCollected),
  );
  recordStep(
    `Got ${resumeEntries.length} entry event(s) from follow-up`,
    resumeEntries.length > 0,
  );
  recordStep(
    `Got ${resumeAssistant.length} assistant entry/entries from follow-up`,
    resumeAssistant.length > 0,
  );
  // Same as Phase A: expect at least 1 status transition (active).
  recordStep(
    `Status transitions: ${resumeStatusEvents.length}`,
    resumeStatusEvents.length >= 1,
    resumeStatusEvents
      .filter((e): e is ChannelMessage & { event: { type: 'status'; status: string } } =>
        e.type === 'event' && e.event.type === 'status')
      .map(e => e.event.status)
      .join(' -> '),
  );

  // C.6: Clean up
  header('C.6: Tear down');
  closeSession(sessionId);
  _resetRegistry();
  recordStep('Part 2 cleanup complete', true, 'session closed, registry reset');

  console.log(`\n  ${BOLD}Part 2: Live Session Lifecycle complete${RESET}`);
}

// ============================================================================
// Run
// ============================================================================

main().catch((err) => {
  console.error('\nUnhandled error:', err);
  _resetRegistry();
  process.exit(1);
});
