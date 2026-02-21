#!/usr/bin/env node
/**
 * Codex app-server protocol spike
 *
 * Spawns `codex app-server`, drives a minimal session through JSON-RPC 2.0,
 * and captures every message (both directions) to stdout + trace.jsonl.
 *
 * Usage:  node spike/app-server-spike.mjs
 */

import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TRACE_PATH = resolve(__dirname, 'trace.jsonl');
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
  const msg = {
    jsonrpc: '2.0',
    id: nextId++,
    method,
    params,
  };
  return msg;
}

function makeNotification(method, params) {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

// ── Framing ─────────────────────────────────────────────────────────────────
//
// We need to discover the framing format. Two possibilities:
//   1. Newline-delimited JSON (each message is a single line)
//   2. Content-Length headers (LSP-style: `Content-Length: N\r\n\r\n{...}`)
//
// Strategy: buffer incoming data and attempt both parsings.

class MessageReader {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.mode = null; // 'ndjson' | 'content-length' | null (auto-detect)
    this.onMessage = null;
  }

  feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    if (this.mode === null) {
      // Auto-detect: if the buffer starts with "Content-Length:", use LSP mode
      const head = this.buffer.toString('utf8', 0, Math.min(this.buffer.length, 20));
      if (head.startsWith('Content-Length:')) {
        this.mode = 'content-length';
        console.log('\x1b[32m[SPIKE] Detected Content-Length framing (LSP-style)\x1b[0m');
      } else if (head.includes('{')) {
        this.mode = 'ndjson';
        console.log('\x1b[32m[SPIKE] Detected newline-delimited JSON framing\x1b[0m');
      } else {
        // Not enough data yet
        return;
      }
    }

    if (this.mode === 'ndjson') {
      this._parseNdjson();
    } else {
      this._parseContentLength();
    }
  }

  _parseNdjson() {
    const str = this.buffer.toString('utf8');
    const lines = str.split('\n');
    // Keep the last (possibly incomplete) line in the buffer
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

  _parseContentLength() {
    while (true) {
      const str = this.buffer.toString('utf8');
      const headerEnd = str.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = str.slice(0, headerEnd);
      const match = header.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        console.error(`[SPIKE] Malformed Content-Length header: ${header}`);
        // Skip past this header
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4; // after \r\n\r\n
      const bodyStartBytes = Buffer.byteLength(str.slice(0, bodyStart), 'utf8');
      const totalNeeded = bodyStartBytes + contentLength;

      if (this.buffer.length < totalNeeded) break; // not enough data yet

      const body = this.buffer.subarray(bodyStartBytes, totalNeeded).toString('utf8');
      this.buffer = this.buffer.subarray(totalNeeded);

      try {
        const parsed = JSON.parse(body);
        if (this.onMessage) this.onMessage(body, parsed);
      } catch {
        console.error(`[SPIKE] Failed to parse body: ${body.slice(0, 200)}`);
      }
    }
  }
}

// ── Writer ──────────────────────────────────────────────────────────────────

class MessageWriter {
  constructor(stream) {
    this.stream = stream;
    this.mode = null; // will mirror reader's detected mode
  }

  send(msg) {
    const json = JSON.stringify(msg);
    const raw = this._frame(json);
    trace('C→S', json, msg);
    this.stream.write(raw);
  }

  _frame(json) {
    if (this.mode === 'content-length') {
      const len = Buffer.byteLength(json, 'utf8');
      return `Content-Length: ${len}\r\n\r\n${json}`;
    }
    // Default to ndjson
    return json + '\n';
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\x1b[1m[SPIKE] Codex app-server protocol spike\x1b[0m`);
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

  // Pending requests: id -> { resolve, reject, method }
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

  // Track received notifications
  const notifications = [];
  // Track server requests (approval requests etc.)
  const serverRequests = [];

  reader.onMessage = (raw, parsed) => {
    trace('S→C', raw, parsed);

    // Response to our request?
    if ('id' in parsed && ('result' in parsed || 'error' in parsed)) {
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

    // Server notification (no id)?
    if ('method' in parsed && !('id' in parsed)) {
      notifications.push({ t: ts(), method: parsed.method, params: parsed.params });
      return;
    }

    // Server request (has id, has method — server asking us something)?
    if ('method' in parsed && 'id' in parsed) {
      serverRequests.push({ t: ts(), id: parsed.id, method: parsed.method, params: parsed.params });
      // Auto-approve any approval requests for the spike
      if (parsed.method.includes('requestApproval')) {
        console.log(`\x1b[35m[SPIKE] Auto-approving server request: ${parsed.method}\x1b[0m`);
        // Try to approve — exact response shape depends on approval type
        const response = { jsonrpc: '2.0', id: parsed.id, result: { decision: 'approve' } };
        writer.send(response);
      }
      return;
    }
  };

  child.stdout.on('data', (chunk) => {
    reader.feed(chunk);
    // Mirror mode to writer once detected
    if (reader.mode && !writer.mode) {
      writer.mode = reader.mode;
      console.log(`\x1b[32m[SPIKE] Writer mode set to: ${reader.mode}\x1b[0m`);
    }
  });

  // Give the server a moment to start up
  await sleep(500);

  // If we haven't detected mode yet, assume ndjson and send initialize
  if (!writer.mode) {
    console.log('\x1b[33m[SPIKE] No data from server yet, trying ndjson framing first...\x1b[0m');
    writer.mode = 'ndjson';
  }

  // ── Step 1: Initialize ────────────────────────────────────────────────

  console.log('\n\x1b[1m=== Step 1: Initialize ===\x1b[0m\n');
  let initResult;
  try {
    initResult = await withTimeout(
      sendRequest('initialize', {
        clientInfo: {
          name: 'crispy-spike',
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
    // If ndjson failed, retry with Content-Length
    if (writer.mode === 'ndjson' && !reader.mode) {
      console.log('\x1b[33m[SPIKE] Retrying with Content-Length framing...\x1b[0m');
      writer.mode = 'content-length';
      reader.mode = 'content-length';
      try {
        initResult = await withTimeout(
          sendRequest('initialize', {
            clientInfo: {
              name: 'crispy-spike',
              version: '0.0.1',
            },
            capabilities: {
              experimentalApi: true,
            },
          }),
          10_000,
          'initialize (Content-Length)',
        );
        console.log(`\x1b[32m[SPIKE] Initialize succeeded with Content-Length framing!\x1b[0m`);
      } catch (err2) {
        console.error(`\x1b[31m[SPIKE] Initialize failed with both framings: ${err2.message}\x1b[0m`);
        console.error(`[SPIKE] stderr: ${stderrBuf}`);
        child.kill('SIGTERM');
        return;
      }
    } else {
      console.error(`[SPIKE] stderr: ${stderrBuf}`);
      child.kill('SIGTERM');
      return;
    }
  }

  // ── Step 2: Error handling test — send a malformed request ─────────────

  console.log('\n\x1b[1m=== Step 2: Error handling test ===\x1b[0m\n');
  try {
    const errorResult = await withTimeout(
      sendRequest('nonexistent/method', {}),
      5_000,
      'nonexistent/method',
    );
    console.log(`[SPIKE] Unexpected success for bad method: ${JSON.stringify(errorResult)}`);
  } catch (err) {
    console.log(`\x1b[32m[SPIKE] Expected error for bad method: ${err.message}\x1b[0m`);
  }

  // ── Step 3: thread/start ──────────────────────────────────────────────

  console.log('\n\x1b[1m=== Step 3: thread/start ===\x1b[0m\n');
  let threadStartResult;
  try {
    threadStartResult = await withTimeout(
      sendRequest('thread/start', {
        cwd: CWD,
        ephemeral: true,
        experimentalRawEvents: false,
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

  // Wait a moment for any thread/started notification
  await sleep(1000);
  const threadStartedNotif = notifications.find(n => n.method === 'thread/started');
  if (threadStartedNotif) {
    console.log(`\x1b[32m[SPIKE] Received thread/started notification\x1b[0m`);
  } else {
    console.log(`\x1b[33m[SPIKE] No thread/started notification received yet\x1b[0m`);
  }

  // ── Step 4: turn/start ────────────────────────────────────────────────

  console.log('\n\x1b[1m=== Step 4: turn/start ===\x1b[0m\n');
  let turnStartResult;
  try {
    turnStartResult = await withTimeout(
      sendRequest('turn/start', {
        threadId,
        input: [
          { type: 'text', text: 'Say hello in exactly 3 words. Do not use any tools.' },
        ],
      }),
      10_000,
      'turn/start',
    );
    console.log(`\x1b[32m[SPIKE] turn/start succeeded!\x1b[0m`);
    console.log(`turn/start result: ${JSON.stringify(turnStartResult, null, 2)}`);
  } catch (err) {
    console.error(`\x1b[31m[SPIKE] turn/start failed: ${err.message}\x1b[0m`);
    child.kill('SIGTERM');
    return;
  }

  const turnId = turnStartResult?.turn?.id;
  console.log(`\x1b[32m[SPIKE] Turn ID: ${turnId}\x1b[0m`);

  // ── Step 5: Wait for turn/completed ───────────────────────────────────

  console.log('\n\x1b[1m=== Step 5: Waiting for turn/completed ===\x1b[0m\n');

  const turnCompleted = await waitForNotification(
    notifications,
    (n) => n.method === 'turn/completed',
    60_000,
  );

  if (turnCompleted) {
    console.log(`\x1b[32m[SPIKE] turn/completed received!\x1b[0m`);
  } else {
    console.log(`\x1b[33m[SPIKE] Timed out waiting for turn/completed\x1b[0m`);
  }

  // ── Summary ───────────────────────────────────────────────────────────

  console.log('\n\x1b[1m=== Summary ===\x1b[0m\n');
  console.log(`Framing mode: ${reader.mode}`);
  console.log(`Total notifications received: ${notifications.length}`);
  console.log(`Total server requests received: ${serverRequests.length}`);
  console.log(`\nNotification methods received:`);
  const methodCounts = {};
  for (const n of notifications) {
    methodCounts[n.method] = (methodCounts[n.method] || 0) + 1;
  }
  for (const [method, count] of Object.entries(methodCounts).sort()) {
    console.log(`  ${method}: ${count}`);
  }

  if (serverRequests.length > 0) {
    console.log(`\nServer request methods received:`);
    for (const r of serverRequests) {
      console.log(`  ${r.method} (id=${r.id})`);
    }
  }

  // Print all item/agentMessage/delta deltas concatenated
  const deltas = notifications.filter(n => n.method === 'item/agentMessage/delta');
  if (deltas.length > 0) {
    const fullText = deltas.map(d => d.params?.delta ?? '').join('');
    console.log(`\nAgent message (${deltas.length} deltas): "${fullText}"`);
  }

  console.log(`\nTrace written to: ${TRACE_PATH}`);

  // Clean exit
  await sleep(500);
  child.kill('SIGTERM');
  await sleep(1000);
  traceStream.end();
  process.exit(0);
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

    const startLen = notifications.length;
    const interval = setInterval(() => {
      // Check new notifications since we started
      for (let i = startLen; i < notifications.length; i++) {
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
