#!/usr/bin/env node
/**
 * Codex app-server APPROVAL FLOW spike
 *
 * Triggers tool use (file creation + command execution) with approval policy
 * set to "on-request", captures the full approval request/response cycle,
 * then drives a second turn on the same thread for multi-turn testing.
 *
 * Usage:  node spike/app-server-approval-spike.mjs
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACE_PATH = resolve(__dirname, 'trace-approval.jsonl');
const CWD = resolve(__dirname, '..');

// ── Helpers ─────────────────────────────────────────────────────────────────

const traceStream = createWriteStream(TRACE_PATH, { flags: 'w' });

function ts() {
  return new Date().toISOString();
}

function trace(direction, raw, parsed) {
  const entry = {
    t: ts(),
    dir: direction,   // 'C→S' or 'S→C'
    raw: raw.trim(),
    parsed,
  };
  const line = JSON.stringify(entry);
  traceStream.write(line + '\n');
  // Pretty-print to stdout
  const arrow = direction === 'C→S' ? '\x1b[36m>>>\x1b[0m' : '\x1b[33m<<<\x1b[0m';
  console.log(`\n${arrow}  [${entry.t}]  ${direction}`);
  console.log(JSON.stringify(parsed, null, 2));
}

let nextId = 1;

function makeRequest(method, params) {
  return {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params,
  };
}

function makeNotification(method, params) {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

function makeResponse(id, result) {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

// ── Framing (NDJSON — confirmed by spike 1) ─────────────────────────────────

class MessageReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.onMessage = null;
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this._parseNdjson();
  }

  _parseNdjson() {
    const str = this.buffer.toString('utf8');
    const lines = str.split('\n');
    const remainder = lines.pop();
    this.buffer = Buffer.from(remainder, 'utf8');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (this.onMessage) this.onMessage(trimmed, parsed);
      } catch {
        console.error(`[SPIKE] Failed to parse line: ${trimmed.slice(0, 200)}`);
      }
    }
  }
}

class MessageWriter {
  constructor(stream) {
    this.stream = stream;
  }

  send(msg) {
    const json = JSON.stringify(msg);
    trace('C→S', json, msg);
    this.stream.write(json + '\n');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\x1b[1m[SPIKE] Codex app-server APPROVAL FLOW spike\x1b[0m`);
  console.log(`[SPIKE] CWD: ${CWD}`);
  console.log(`[SPIKE] Trace file: ${TRACE_PATH}`);
  console.log(`[SPIKE] Starting codex app-server...\n`);

  const child = spawn('codex', ['app-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: CWD,
  });

  // Capture stderr
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    stderrBuf += text;
    console.error(`\x1b[31m[STDERR]\x1b[0m ${text.trimEnd()}`);
  });

  child.on('error', (err) => {
    console.error(`[SPIKE] Failed to spawn codex app-server: ${err.message}`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    console.log(`\n[SPIKE] codex app-server exited: code=${code} signal=${signal}`);
    traceStream.end();
    process.exit(code ?? 1);
  });

  // Ensure cleanup on exit
  process.on('SIGINT', () => {
    console.log('\n[SPIKE] Caught SIGINT, killing child...');
    child.kill('SIGTERM');
  });
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
  process.on('exit', () => {
    try { child.kill('SIGTERM'); } catch {}
  });

  const reader = new MessageReader();
  const writer = new MessageWriter(child.stdin);

  // Pending client requests: id -> { resolve, reject, method }
  const pending = new Map();

  function sendRequest(method, params) {
    return new Promise((resolve, reject) => {
      const msg = makeRequest(method, params);
      pending.set(msg.id, { resolve, reject, method });
      writer.send(msg);
    });
  }

  function sendNotification(method, params) {
    const msg = makeNotification(method, params);
    writer.send(msg);
  }

  // Track all received messages by category
  const notifications = [];
  const serverRequests = [];     // Server requests requiring our response
  const approvalRequests = [];   // Subset: approval requests with full params
  const itemEvents = [];         // All item/* events for analysis
  let approvalCount = 0;

  reader.onMessage = (raw, parsed) => {
    trace('S→C', raw, parsed);

    // Response to our request?
    if ('id' in parsed && ('result' in parsed || 'error' in parsed) && !('method' in parsed)) {
      const p = pending.get(parsed.id);
      if (p) {
        pending.delete(parsed.id);
        if ('error' in parsed) {
          p.reject(new Error(`JSON-RPC error for ${p.method}: ${JSON.stringify(parsed.error)}`));
        } else {
          p.resolve(parsed.result);
        }
      }
      return;
    }

    // Server REQUEST (has BOTH id AND method — server asking us something)
    if ('method' in parsed && 'id' in parsed) {
      serverRequests.push({ t: ts(), id: parsed.id, method: parsed.method, params: parsed.params });

      // Handle approval requests
      if (parsed.method.includes('requestApproval')) {
        approvalCount++;
        approvalRequests.push({
          t: ts(),
          id: parsed.id,
          method: parsed.method,
          params: parsed.params,
        });

        console.log(`\x1b[35m[SPIKE] *** APPROVAL REQUEST #${approvalCount}: ${parsed.method} (id=${parsed.id}) ***\x1b[0m`);
        console.log(`\x1b[35m[SPIKE] Full params: ${JSON.stringify(parsed.params, null, 2)}\x1b[0m`);

        // Auto-approve
        const response = makeResponse(parsed.id, { decision: 'accept' });
        console.log(`\x1b[32m[SPIKE] Sending approval response: ${JSON.stringify(response)}\x1b[0m`);
        writer.send(response);
        return;
      }

      // Handle user input requests (e.g., item/tool/requestUserInput)
      if (parsed.method.includes('requestUserInput') || parsed.method.includes('UserInput')) {
        console.log(`\x1b[35m[SPIKE] *** USER INPUT REQUEST: ${parsed.method} (id=${parsed.id}) ***\x1b[0m`);
        const response = makeResponse(parsed.id, { answers: {} });
        writer.send(response);
        return;
      }

      // Unknown server request — respond with empty result to avoid blocking
      console.log(`\x1b[33m[SPIKE] Unknown server request: ${parsed.method} (id=${parsed.id}) — sending empty result\x1b[0m`);
      const response = makeResponse(parsed.id, {});
      writer.send(response);
      return;
    }

    // Server notification (method, no id)
    if ('method' in parsed && !('id' in parsed)) {
      notifications.push({ t: ts(), method: parsed.method, params: parsed.params });

      // Track item events specifically
      if (parsed.method.startsWith('item/')) {
        itemEvents.push({ t: ts(), method: parsed.method, params: parsed.params });
      }
      return;
    }
  };

  child.stdout.on('data', (chunk) => {
    reader.feed(chunk);
  });

  // Give the server a moment to start up
  await sleep(500);

  // ── Step 1: Initialize ────────────────────────────────────────────────

  console.log('\n\x1b[1m=== Step 1: Initialize ===\x1b[0m\n');
  let initResult;
  try {
    initResult = await withTimeout(
      sendRequest('initialize', {
        clientInfo: {
          name: 'crispy-approval-spike',
          version: '0.0.1',
        },
        capabilities: {
          experimentalApi: true,
        },
      }),
      10_000,
      'initialize',
    );
    console.log(`\x1b[32m[SPIKE] Initialize succeeded!\x1b[0m`);
    console.log(`Initialize result: ${JSON.stringify(initResult, null, 2)}`);
  } catch (err) {
    console.error(`\x1b[31m[SPIKE] Initialize failed: ${err.message}\x1b[0m`);
    child.kill('SIGTERM');
    return;
  }

  // ── Step 2: thread/start with approvalPolicy ──────────────────────────

  console.log('\n\x1b[1m=== Step 2: thread/start (approvalPolicy: on-request, sandbox: read-only) ===\x1b[0m\n');
  let threadStartResult;
  try {
    threadStartResult = await withTimeout(
      sendRequest('thread/start', {
        cwd: CWD,
        ephemeral: true,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      }),
      15_000,
      'thread/start',
    );
    console.log(`\x1b[32m[SPIKE] thread/start succeeded!\x1b[0m`);
    console.log(`thread/start result: ${JSON.stringify(threadStartResult, null, 2)}`);
  } catch (err) {
    console.error(`\x1b[31m[SPIKE] thread/start failed: ${err.message}\x1b[0m`);
    child.kill('SIGTERM');
    return;
  }

  const threadId = threadStartResult?.thread?.id;
  if (!threadId) {
    console.error('[SPIKE] No thread ID in response!');
    child.kill('SIGTERM');
    return;
  }
  console.log(`\x1b[32m[SPIKE] Thread ID: ${threadId}\x1b[0m`);
  console.log(`\x1b[32m[SPIKE] Approval Policy: ${threadStartResult?.approvalPolicy}\x1b[0m`);
  console.log(`\x1b[32m[SPIKE] Sandbox: ${JSON.stringify(threadStartResult?.sandbox)}\x1b[0m`);

  // Wait for thread/started notification
  await sleep(1000);

  // ── Step 3: turn/start (tool-triggering prompt) ───────────────────────

  console.log('\n\x1b[1m=== Step 3: turn/start (Turn 1 — trigger tool use) ===\x1b[0m\n');

  const TURN1_PROMPT = [
    "Create a file called /tmp/crispy-spike-test.txt with the text 'hello from spike'.",
    "Then run: ls -la /tmp/crispy-spike-test.txt",
    "Report what you did.",
  ].join(' ');

  let turnStartResult;
  try {
    turnStartResult = await withTimeout(
      sendRequest('turn/start', {
        threadId,
        input: [
          { type: 'text', text: TURN1_PROMPT },
        ],
      }),
      15_000,
      'turn/start (turn 1)',
    );
    console.log(`\x1b[32m[SPIKE] turn/start succeeded!\x1b[0m`);
    console.log(`turn/start result: ${JSON.stringify(turnStartResult, null, 2)}`);
  } catch (err) {
    console.error(`\x1b[31m[SPIKE] turn/start failed: ${err.message}\x1b[0m`);
    child.kill('SIGTERM');
    return;
  }

  const turn1Id = turnStartResult?.turn?.id;
  console.log(`\x1b[32m[SPIKE] Turn 1 ID: ${turn1Id}\x1b[0m`);

  // ── Step 4: Wait for turn 1 to complete ───────────────────────────────

  console.log('\n\x1b[1m=== Step 4: Waiting for turn 1 completion (up to 120s) ===\x1b[0m\n');

  const turn1Completed = await waitForNotification(
    notifications,
    (n) => n.method === 'turn/completed' && n.params?.turnId === turn1Id,
    120_000,
  );

  if (turn1Completed) {
    console.log(`\x1b[32m[SPIKE] Turn 1 completed!\x1b[0m`);
    console.log(`Turn 1 completion: ${JSON.stringify(turn1Completed, null, 2)}`);
  } else {
    // Also check for turn/completed without turnId filter (in case the shape differs)
    const anyTurnCompleted = notifications.find(n => n.method === 'turn/completed');
    if (anyTurnCompleted) {
      console.log(`\x1b[33m[SPIKE] Turn completed found (but turnId didn't match filter):\x1b[0m`);
      console.log(JSON.stringify(anyTurnCompleted, null, 2));
    } else {
      console.log(`\x1b[31m[SPIKE] Timed out waiting for turn 1 completion\x1b[0m`);
    }
  }

  // ── Interim report ────────────────────────────────────────────────────

  console.log('\n\x1b[1m=== Interim Report (after Turn 1) ===\x1b[0m\n');
  printSummary(notifications, serverRequests, approvalRequests, itemEvents);

  // ── Step 5: turn/start (second turn — multi-turn test) ────────────────

  console.log('\n\x1b[1m=== Step 5: turn/start (Turn 2 — multi-turn test) ===\x1b[0m\n');

  // Wait a beat before second turn
  await sleep(1000);

  // Reset notification tracking for turn 2
  const turn2NotifStart = notifications.length;

  let turn2StartResult;
  try {
    turn2StartResult = await withTimeout(
      sendRequest('turn/start', {
        threadId,
        input: [
          { type: 'text', text: 'What files did you just create? Does /tmp/crispy-spike-test.txt exist? Do NOT use any tools, just answer from memory.' },
        ],
      }),
      15_000,
      'turn/start (turn 2)',
    );
    console.log(`\x1b[32m[SPIKE] Turn 2 start succeeded!\x1b[0m`);
    console.log(`turn/start result: ${JSON.stringify(turn2StartResult, null, 2)}`);
  } catch (err) {
    console.error(`\x1b[31m[SPIKE] Turn 2 start failed: ${err.message}\x1b[0m`);
    child.kill('SIGTERM');
    return;
  }

  const turn2Id = turn2StartResult?.turn?.id;
  console.log(`\x1b[32m[SPIKE] Turn 2 ID: ${turn2Id}\x1b[0m`);

  // ── Step 6: Wait for turn 2 to complete ───────────────────────────────

  console.log('\n\x1b[1m=== Step 6: Waiting for turn 2 completion (up to 60s) ===\x1b[0m\n');

  const turn2Completed = await waitForNotification(
    notifications,
    (n) => n.method === 'turn/completed' && notifications.indexOf(n) >= turn2NotifStart,
    60_000,
  );

  if (turn2Completed) {
    console.log(`\x1b[32m[SPIKE] Turn 2 completed!\x1b[0m`);
    console.log(`Turn 2 completion: ${JSON.stringify(turn2Completed, null, 2)}`);
  } else {
    console.log(`\x1b[31m[SPIKE] Timed out waiting for turn 2 completion\x1b[0m`);
  }

  // ── Final Summary ─────────────────────────────────────────────────────

  console.log('\n\x1b[1m╔══════════════════════════════════════════════════════════╗\x1b[0m');
  console.log('\x1b[1m║              FINAL SUMMARY                               ║\x1b[0m');
  console.log('\x1b[1m╚══════════════════════════════════════════════════════════╝\x1b[0m\n');

  printSummary(notifications, serverRequests, approvalRequests, itemEvents);

  // Print agent messages from both turns
  const agentDeltas = notifications.filter(n => n.method === 'item/agentMessage/delta');
  if (agentDeltas.length > 0) {
    const fullText = agentDeltas.map(d => d.params?.delta ?? '').join('');
    console.log(`\nAgent message text (all turns, ${agentDeltas.length} deltas):\n"${fullText}"`);
  }

  // Print command output deltas
  const cmdOutputDeltas = notifications.filter(n => n.method === 'item/commandExecution/outputDelta');
  if (cmdOutputDeltas.length > 0) {
    const cmdOutput = cmdOutputDeltas.map(d => d.params?.delta ?? '').join('');
    console.log(`\nCommand output (${cmdOutputDeltas.length} deltas):\n"${cmdOutput}"`);
  }

  // Print file change deltas
  const fileChangeDeltas = notifications.filter(n => n.method === 'item/fileChange/outputDelta');
  if (fileChangeDeltas.length > 0) {
    console.log(`\nFile change output deltas: ${fileChangeDeltas.length}`);
    for (const d of fileChangeDeltas) {
      console.log(`  ${JSON.stringify(d.params)}`);
    }
  }

  // Print all item/started events with their types
  const itemStarted = notifications.filter(n => n.method === 'item/started');
  if (itemStarted.length > 0) {
    console.log(`\n--- All item/started events (${itemStarted.length}) ---`);
    for (const ev of itemStarted) {
      const item = ev.params?.item;
      console.log(`  type=${item?.type} id=${item?.id}`);
      if (item?.type === 'commandExecution' || item?.type === 'fileChange') {
        console.log(`    Full item: ${JSON.stringify(item, null, 2)}`);
      }
    }
  }

  // Print all item/completed events with their types
  const itemCompleted = notifications.filter(n => n.method === 'item/completed');
  if (itemCompleted.length > 0) {
    console.log(`\n--- All item/completed events (${itemCompleted.length}) ---`);
    for (const ev of itemCompleted) {
      const item = ev.params?.item;
      console.log(`  type=${item?.type} id=${item?.id}`);
      if (item?.type === 'commandExecution' || item?.type === 'fileChange') {
        console.log(`    Full item: ${JSON.stringify(item, null, 2)}`);
      }
    }
  }

  // Detail on approval requests
  if (approvalRequests.length > 0) {
    console.log(`\n--- Approval Request Details (${approvalRequests.length}) ---`);
    for (const ar of approvalRequests) {
      console.log(`\n  Method: ${ar.method}`);
      console.log(`  ID: ${ar.id}`);
      console.log(`  Params: ${JSON.stringify(ar.params, null, 4)}`);
    }
  } else {
    console.log('\n*** NO APPROVAL REQUESTS RECEIVED ***');
    console.log('This might mean the sandbox allowed the operations without approval,');
    console.log('or the approval policy was not set to "on-request".');
  }

  // Multi-turn analysis
  console.log(`\n--- Multi-turn Analysis ---`);
  console.log(`Turn 1 ID: ${turn1Id}`);
  console.log(`Turn 2 ID: ${turn2Id}`);
  console.log(`Turn IDs are ${turn1Id !== turn2Id ? 'DIFFERENT' : 'SAME'} (expected: different)`);

  console.log(`\nTrace written to: ${TRACE_PATH}`);
  console.log(`Total trace entries: ${notifications.length + serverRequests.length} server messages`);

  // Clean exit
  await sleep(500);
  child.kill('SIGTERM');
  await sleep(1000);
  traceStream.end();
  process.exit(0);
}

// ── Summary printer ─────────────────────────────────────────────────────────

function printSummary(notifications, serverRequests, approvalRequests, itemEvents) {
  console.log(`Total notifications: ${notifications.length}`);
  console.log(`Total server requests: ${serverRequests.length}`);
  console.log(`Total approval requests: ${approvalRequests.length}`);

  // Count v2 notification methods (ignore codex/event/* legacy)
  const v2Methods = {};
  for (const n of notifications) {
    if (!n.method.startsWith('codex/event/')) {
      v2Methods[n.method] = (v2Methods[n.method] || 0) + 1;
    }
  }
  console.log(`\nV2 notification methods:`);
  for (const [method, count] of Object.entries(v2Methods).sort()) {
    console.log(`  ${method}: ${count}`);
  }

  // Count legacy codex/event/* methods
  const legacyMethods = {};
  for (const n of notifications) {
    if (n.method.startsWith('codex/event/')) {
      legacyMethods[n.method] = (legacyMethods[n.method] || 0) + 1;
    }
  }
  if (Object.keys(legacyMethods).length > 0) {
    console.log(`\nLegacy codex/event/* methods:`);
    for (const [method, count] of Object.entries(legacyMethods).sort()) {
      console.log(`  ${method}: ${count}`);
    }
  }

  // Server request methods
  if (serverRequests.length > 0) {
    console.log(`\nServer request methods:`);
    for (const r of serverRequests) {
      console.log(`  ${r.method} (id=${r.id})`);
    }
  }
}

// ── Utilities ───────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms waiting for ${label}`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function waitForNotification(notifications, predicate, timeoutMs) {
  return new Promise((resolve) => {
    // Check if already received
    const existing = notifications.find(predicate);
    if (existing) { resolve(existing); return; }

    const interval = setInterval(() => {
      for (let i = 0; i < notifications.length; i++) {
        if (predicate(notifications[i])) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve(notifications[i]);
          return;
        }
      }
    }, 100);

    const timer = setTimeout(() => {
      clearInterval(interval);
      resolve(null);
    }, timeoutMs);
  });
}

main().catch((err) => {
  console.error(`[SPIKE] Fatal: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
