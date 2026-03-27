/**
 * RPC Pipe — single-shot RPC invocation for LLMs and scripts
 *
 * Sends one RPC to the running Crispy host, prints the JSON result
 * on stdout, and exits. No event streaming, no provenance.
 *
 * Usage:
 *   crispy-dispatch rpc <method> [json-params] [--session <id>]
 *
 * Session ID resolution:
 *   1. $CRISPY_SESSION_ID (auto-injected by Crispy for managed sessions)
 *   2. --session <id> overrides the env var
 *   3. If the ID starts with "pending:", resolves via resolveSessionId RPC
 *   4. Auto-injected as params.sessionId if not already present
 *
 * @module rpc-pipe
 */

import { connect } from 'node:net';
import { discoverSocket, MessageRouter, EXIT_TRANSPORT, EXIT_USAGE } from './ipc-client.js';

export async function runRpcPipe(argv: string[]): Promise<void> {
  // Parse flags from argv, collecting remaining positional args
  let sessionOverride: string | undefined;
  let subscribeFirst = false;
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--session') {
      sessionOverride = argv[++i];
      if (!sessionOverride) {
        process.stderr.write(JSON.stringify({ error: '--session requires a value' }) + '\n');
        process.exitCode = EXIT_USAGE;
        return;
      }
    } else if (argv[i] === '--subscribe-first') {
      subscribeFirst = true;
    } else {
      positional.push(argv[i]!);
    }
  }

  const method = positional[0];
  if (!method) {
    process.stderr.write(JSON.stringify({ error: 'Usage: crispy-dispatch rpc <method> [json-params] [--session <id>]' }) + '\n');
    process.exitCode = EXIT_USAGE;
    return;
  }

  let params: Record<string, unknown>;
  try {
    params = positional[1] ? JSON.parse(positional[1]) : {};
  } catch {
    process.stderr.write(JSON.stringify({ error: `Invalid JSON params: ${positional[1]}` }) + '\n');
    process.exitCode = EXIT_USAGE;
    return;
  }

  // Discover socket and connect
  let socketPath: string;
  try {
    socketPath = discoverSocket();
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: (err as Error).message }) + '\n');
    process.exitCode = EXIT_TRANSPORT;
    return;
  }

  let conn: import('node:net').Socket;
  try {
    conn = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      conn.once('connect', resolve);
      conn.once('error', reject);
    });
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: `Connection failed: ${(err as Error).message}` }) + '\n');
    process.exitCode = EXIT_TRANSPORT;
    return;
  }

  const router = new MessageRouter(conn);

  try {
    // Resolve session ID: --session override > $CRISPY_SESSION_ID
    let sessionId = sessionOverride ?? process.env.CRISPY_SESSION_ID;

    // Resolve pending: prefix via RPC
    if (sessionId?.startsWith('pending:')) {
      const resolved = await router.sendRpc('resolveSessionId', { sessionId }) as { sessionId: string };
      sessionId = resolved.sessionId;
    } else if (sessionId && sessionId.length < 36) {
      // Silently resolve truncated session ID prefixes to full UUIDs
      const resolved = await router.sendRpc('resolveSessionPrefix', { sessionId }) as { sessionId: string };
      sessionId = resolved.sessionId;
    }

    // Auto-inject sessionId into params if not already present
    if (sessionId && !('sessionId' in params)) {
      params.sessionId = sessionId;
    }

    // Auto-inject cwd for switchSession so the new session inherits the
    // caller's working directory rather than the host process's cwd
    if (method === 'switchSession' && !('cwd' in params)) {
      params.cwd = process.cwd();
    }

    // Subscribe to the session first if requested — ensures the caller
    // holds a subscription on this connection before the main RPC.
    // Required by switchSession which guards against cross-client rekey bugs.
    if (subscribeFirst && sessionId) {
      await router.sendRpc('subscribe', { sessionId });
    }

    const result = await router.sendRpc(method, params);
    process.stdout.write(JSON.stringify(result) + '\n', () => {
      process.exitCode = 0;
      router.end();
    });
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: (err as Error).message }) + '\n', () => {
      process.exitCode = 1;
      router.end();
    });
  }
}
