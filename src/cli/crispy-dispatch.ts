/**
 * crispy-dispatch — CLI client for Crispy IPC
 *
 * Connects to the running Crispy extension host over a Unix domain socket
 * (or Windows named pipe) and dispatches sessions via JSON-RPC.
 *
 * Single unified mode: all dispatches go through `sendTurn` RPC with
 * event streaming. Visibility, persistence, and child registration are
 * controlled via TurnIntent fields (openChannel, visible, parentSessionId).
 *
 * Exit codes:
 *   0   completed
 *   10  approval_required (session paused, can resume)
 *   11  timeout (may have partial text on stdout)
 *   12  transport_error (socket not found, connection dropped)
 *   13  invalid_usage (bad flags, no prompt)
 *
 * @module crispy-dispatch
 */

import { connect, type Socket } from 'node:net';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

import {
  EXIT_OK, EXIT_APPROVAL, EXIT_TIMEOUT, EXIT_TRANSPORT, EXIT_USAGE,
  discoverSocket, MessageRouter,
  type RpcEvent,
} from './ipc-client.js';
import { startIdleWatch } from '../core/channel-idle.js';
import type { ChannelMessage } from '../core/agent-adapter.js';
import type { SubscriberMessage } from '../core/session-channel.js';

// ============================================================================
// Structured Output
// ============================================================================

type ResultStatus = 'completed' | 'approval_required' | 'timeout' | 'error';

interface ResultMetadata {
  status: ResultStatus;
  sessionId: string;
  textLength: number;
  partial?: boolean;
  toolName?: string;
  toolUseId?: string;
  error?: string;
}

function emitResult(meta: ResultMetadata): void {
  process.stderr.write(JSON.stringify(meta) + '\n');
}

function exitForStatus(status: ResultStatus): number {
  switch (status) {
    case 'completed': return EXIT_OK;
    case 'approval_required': return EXIT_APPROVAL;
    case 'timeout': return EXIT_TIMEOUT;
    case 'error': return EXIT_TRANSPORT;
  }
}

// ============================================================================
// Argument Parsing
// ============================================================================

type ApprovalMode = 'fail' | 'bypass' | 'manual';

interface CliArgs {
  vendor: string;
  parentVendor?: string;
  prompt?: string;
  parentSessionId?: string;
  model?: string;
  timeoutMs: number;
  autoClose: boolean;
  visible: boolean;
  background: boolean;
  resume?: string;
  fork: boolean;
  resumeAt?: string;
  persist: boolean;
  approval: ApprovalMode;
  sessionIdFile?: string;
  debug: boolean;
}

function requireValue(flag: string, argv: string[], i: number): string {
  const val = argv[i + 1];
  if (val === undefined || val.startsWith('-')) {
    console.error(`Error: ${flag} requires a value`);
    process.exit(EXIT_USAGE);
  }
  return val;
}

function parseArgs(argv: string[]): CliArgs {
  const approvalEnv = process.env.CRISPY_DISPATCH_APPROVAL as ApprovalMode | undefined;
  const args: CliArgs = {
    vendor: 'claude',
    timeoutMs: 600_000,
    autoClose: true,
    visible: false,
    background: false,
    fork: false,
    persist: true,
    approval: approvalEnv && ['fail', 'bypass', 'manual'].includes(approvalEnv)
      ? approvalEnv : 'fail',
    debug: process.env.CRISPY_DISPATCH_DEBUG === '1',
  };

  // BYPASS_PERMISSIONS=1 is a shorthand for --approval bypass
  if (process.env.BYPASS_PERMISSIONS === '1') {
    args.approval = 'bypass';
  }

  const positionalParts: string[] = [];
  let explicitTimeout = false;
  let i = 2; // skip node + script

  while (i < argv.length) {
    const arg = argv[i]!;
    switch (arg) {
      case '--vendor':
        args.vendor = requireValue('--vendor', argv, i);
        i++;
        break;
      case '--parent-vendor':
        args.parentVendor = requireValue('--parent-vendor', argv, i);
        i++;
        break;
      case '--prompt':
      case '-p':
        args.prompt = requireValue(arg, argv, i);
        i++;
        break;
      case '--parent-session':
        args.parentSessionId = requireValue('--parent-session', argv, i);
        i++;
        break;
      case '--model':
      case '-m':
        args.model = requireValue(arg, argv, i);
        i++;
        break;
      case '--timeout':
        args.timeoutMs = parseInt(requireValue('--timeout', argv, i), 10);
        explicitTimeout = true;
        i++;
        break;
      case '--no-auto-close':
        args.autoClose = false;
        break;
      case '--visible':
      case '--open':
        args.visible = true;
        break;
      case '--background':
        args.visible = true;
        args.background = true;
        break;
      case '--resume':
      case '-r':
        args.resume = requireValue(arg, argv, i);
        i++;
        break;
      case '--fork':
      case '-f':
        args.fork = true;
        break;
      case '--resume-at':
        args.resumeAt = requireValue('--resume-at', argv, i);
        i++;
        break;
      case '--persist':
        // No-op — persist is now the default. Kept for backwards compatibility.
        break;
      case '--no-persist':
        args.persist = false;
        break;
      case '--approval': {
        const val = requireValue('--approval', argv, i) as ApprovalMode;
        i++;
        if (!['fail', 'bypass', 'manual'].includes(val)) {
          console.error(`Error: --approval must be fail, bypass, or manual (got "${val}")`);
          process.exit(EXIT_USAGE);
        }
        args.approval = val;
        break;
      }
      case '--debug':
        args.debug = true;
        break;
      case '--session-id-file':
        args.sessionIdFile = requireValue('--session-id-file', argv, i);
        i++;
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(EXIT_OK);
        break;
      default:
        if (arg.startsWith('-')) {
          console.error(`Unknown flag: ${arg}`);
          process.exit(EXIT_USAGE);
        }
        positionalParts.push(arg);
    }
    i++;
  }

  if (!args.prompt && positionalParts.length > 0) {
    args.prompt = positionalParts.join(' ');
  }

  // Long-running agent sessions (--no-auto-close) default to no timeout —
  // wait indefinitely for the turn to complete. Explicit --timeout overrides.
  if (!args.autoClose && !explicitTimeout) {
    args.timeoutMs = 0;
  }

  return args;
}

function printUsage(): void {
  console.log(`Usage: crispy-dispatch [options] [prompt...]
       crispy-dispatch rpc <method> [json-params] [--session <id>]

Subcommands:
  rpc <method> [params]     Send a single RPC and print JSON result on stdout.
                            Auto-injects $CRISPY_SESSION_ID as params.sessionId.

Prompt Input:
  [prompt...]               Prompt text (positional args joined with spaces)
  -p, --prompt <text>       Prompt text (explicit flag)
  PROMPT_FILE=<path>        Read prompt from file (env var)
  stdin                     Pipe prompt via stdin

Session Control:
  --resume, -r <id>         Resume or fork from this session ID
  --fork, -f                Fork from session (requires --resume)
  --resume-at <msg-id>      Fork at specific message UUID (requires --fork)

Vendor & Model:
  --vendor <vendor>         Vendor to use (default: claude)
  --parent-vendor <vendor>  Parent vendor (default: same as --vendor)
  -m, --model <model>       Model override

Behavior:
  --open, --visible         Show session in editor UI (tab + sidebar)
  --background              Visible in sidebar but no tab opens
  --parent-session <id>     Parent session ID (default: $CRISPY_SESSION_ID)
  --timeout <ms>            Timeout in milliseconds (default: 600000)
  --no-persist              Don't save session to disk (default: persist)
  --no-auto-close           Keep session alive after completion
  --approval <mode>         Approval handling: fail (default), bypass, manual
  --debug                   Print diagnostics to stderr

Exit Codes:
  0                         Completed successfully
  10                        Approval required (session paused, can resume)
  11                        Timeout (may have partial text on stdout)
  12                        Transport error
  13                        Invalid usage

Environment:
  CRISPY_SOCK               Override socket path (skip discovery)
  CRISPY_SESSION_ID         Parent session ID (auto-set in managed sessions)
  PROMPT_FILE               Read prompt from file
  BYPASS_PERMISSIONS=1      Shorthand for --approval bypass
  CRISPY_DISPATCH_APPROVAL  Default approval mode (fail|bypass|manual)
  CRISPY_DISPATCH_DEBUG=1   Enable diagnostics`);
}

// ============================================================================
// Main
// ============================================================================

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function getPrompt(args: CliArgs): string | undefined {
  if (args.prompt) return args.prompt;
  const pf = process.env.PROMPT_FILE;
  if (pf) {
    try {
      return readFileSync(resolve(pf), 'utf8').trim();
    } catch (err) {
      console.error(`Error reading PROMPT_FILE "${pf}": ${(err as Error).message}`);
      process.exit(EXIT_USAGE);
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  // Route to rpc pipe before parsing dispatch-specific args
  if (process.argv[2] === 'rpc') {
    const { runRpcPipe } = await import('./rpc-pipe.js');
    await runRpcPipe(process.argv.slice(3));
    return;
  }

  const args = parseArgs(process.argv);

  // Validate flag combinations
  if (args.fork && !args.resume) {
    console.error('Error: --fork requires --resume <session-id>');
    process.exit(EXIT_USAGE);
  }
  if (args.resumeAt && !args.fork) {
    console.error('Error: --resume-at requires --fork');
    process.exit(EXIT_USAGE);
  }

  // Resolve prompt
  let prompt = getPrompt(args);
  if (!prompt) {
    const stdinContent = await readStdin();
    if (stdinContent) {
      prompt = stdinContent;
    } else {
      console.error('Error: No prompt provided. Use --prompt, positional args, PROMPT_FILE, or pipe via stdin.');
      process.exit(EXIT_USAGE);
    }
  }

  // Build settings
  const settings: Record<string, unknown> = {};
  if (args.model) settings.model = args.model;
  if (args.approval === 'bypass') {
    settings.permissionMode = 'bypassPermissions';
  }

  // Connect to the IPC server
  let socketPath: string;
  try {
    socketPath = discoverSocket();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(EXIT_TRANSPORT);
  }

  let conn: Socket;
  try {
    conn = connect(socketPath);
    await new Promise<void>((resolve, reject) => {
      conn.once('connect', resolve);
      conn.once('error', reject);
    });
  } catch (err) {
    console.error(`Connection failed: ${(err as Error).message}`);
    process.exit(EXIT_TRANSPORT);
  }

  if (args.debug) console.error(`[crispy-dispatch] Connected to ${socketPath}`);

  const router = new MessageRouter(conn);

  // Silently resolve truncated session ID prefixes to full UUIDs
  if (args.resume && args.resume.length < 36) {
    try {
      const resolved = await router.sendRpc('resolveSessionPrefix', { sessionId: args.resume }) as { sessionId: string };
      args.resume = resolved.sessionId;
    } catch (err) {
      console.error(`Error resolving session prefix: ${(err as Error).message}`);
      process.exit(EXIT_USAGE);
    }
  }
  if (args.parentSessionId && args.parentSessionId.length < 36) {
    try {
      const resolved = await router.sendRpc('resolveSessionPrefix', { sessionId: args.parentSessionId }) as { sessionId: string };
      args.parentSessionId = resolved.sessionId;
    } catch (err) {
      console.error(`Error resolving session prefix: ${(err as Error).message}`);
      process.exit(EXIT_USAGE);
    }
  }

  try {
    await runMode(router, args, prompt!, settings);
  } catch (err) {
    emitResult({
      status: 'error',
      sessionId: '',
      textLength: 0,
      error: (err as Error).message,
    });
    process.exit(EXIT_TRANSPORT);
  }

  router.end();
}

// ============================================================================
// Unified Mode — all dispatches via sendTurn RPC with client-side event streaming
// ============================================================================

async function runMode(
  router: MessageRouter,
  args: CliArgs,
  prompt: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const skipPersistSession = !args.persist;

  const parentSessionId = args.parentSessionId
    || process.env.CRISPY_SESSION_ID
    || `cli-${Date.now()}`;

  // Build TurnTarget — omit cwd for new sessions so the server resolves it
  // from the parent session's projectPath (via parentSessionId on the target).
  // Falls back to process.cwd() only when there's no parent.
  let target: Record<string, unknown>;
  if (args.resume && args.fork) {
    target = {
      kind: 'fork',
      vendor: args.vendor,
      fromSessionId: args.resume,
      ...(args.resumeAt && { atMessageId: args.resumeAt }),
      ...(skipPersistSession && { skipPersistSession }),
    };
  } else if (args.resume) {
    target = { kind: 'existing', sessionId: args.resume };
  } else {
    target = {
      kind: 'new',
      vendor: args.vendor,
      parentSessionId,
      ...(skipPersistSession && { skipPersistSession }),
    };
  }

  // Build intent with visibility fields directly — no provenance sidecar.
  // visible and openChannel are independent:
  //   --open:       visible=true, openChannel=true (tab + sidebar)
  //   --background: visible=true, openChannel=false (sidebar only)
  //   hidden:       neither set
  const intent: Record<string, unknown> = {
    target,
    content: prompt,
    clientMessageId: crypto.randomUUID(),
    settings,
    ...(args.visible && !args.background && { openChannel: true }),
    ...(args.visible && { visible: true }),
    ...(args.autoClose !== undefined && { autoClose: args.autoClose }),
    ...(parentSessionId && { parentSessionId }),
  };

  // State for event collection
  let sessionId = '';
  let text = '';
  let approvalInfo: { toolName: string; toolUseId: string } | null = null;

  // Idle/debounce/timeout/approval-fail are all centralized in `startIdleWatch`.
  // The CLI feeds RPC events into the watcher; everything else (text streaming,
  // session-id rekey tracking, error logging) stays in the event handler.
  const watcher = startIdleWatch({
    ...(args.timeoutMs > 0 && { timeoutMs: args.timeoutMs }),
    onMessage: (msg) => {
      if (
        msg.type === 'event' &&
        msg.event.type === 'status' &&
        msg.event.status === 'awaiting_approval' &&
        args.approval === 'fail'
      ) {
        approvalInfo = {
          toolName: msg.event.toolName ?? 'unknown',
          toolUseId: msg.event.toolUseId ?? '',
        };
        return 'interrupt';
      }
    },
  });

  router.setEventHandler((evt) => {
    const event = evt.event as unknown as SubscriberMessage;

    // Track session ID rekey (pending → real). Done up front so the
    // sidecar file always carries the real ID even if the watcher has
    // already resolved.
    if (event.type === 'event' && event.event.type === 'notification') {
      const notif = event.event;
      if (notif.kind === 'session_changed' && 'sessionId' in notif && typeof notif.sessionId === 'string') {
        const newId = notif.sessionId;
        if (args.debug) console.error(`[crispy-dispatch] Session rekey: ${sessionId} → ${newId}`);
        sessionId = newId;
        if (args.sessionIdFile) {
          try { writeFileSync(args.sessionIdFile, newId, 'utf8'); } catch { /* best-effort */ }
        }
      }
      if (notif.kind === 'error') {
        console.error(`[crispy-dispatch] Error: ${(notif as { error?: string }).error ?? 'unknown'}`);
      }
    }

    // Collect assistant text from entry messages.
    if (event.type === 'entry' && event.entry) {
      const entry = event.entry as { type?: string; message?: { content?: unknown } };
      if ((entry.type === 'assistant' || entry.type === 'result') && entry.message) {
        const content = entry.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'text' && block.text) {
              process.stdout.write(block.text);
              text += block.text;
            }
          }
        } else if (typeof content === 'string') {
          process.stdout.write(content);
          text += content;
        }
      }
    }

    if (args.debug && event.type === 'event' && event.event.type === 'status') {
      const status = event.event.status;
      const turnComplete = status === 'idle' && 'turnComplete' in event.event && event.event.turnComplete;
      console.error(`[crispy-dispatch] Status: ${status}${turnComplete ? ' (turnComplete)' : ''}`);
      if (status === 'awaiting_approval' && args.approval === 'manual') {
        console.error(`[crispy-dispatch] Awaiting approval for "${event.event.toolName}". Approve in Crispy UI.`);
      }
    }

    if (event.type === 'event' || event.type === 'entry') {
      watcher.feed(event as ChannelMessage);
    }
  });

  const done: Promise<ResultStatus> = watcher.promise.then((reason) => {
    switch (reason) {
      case 'turnComplete':
      case 'settled': return 'completed';
      case 'timeout': return 'timeout';
      case 'interrupted': return 'approval_required';
    }
  });

  // For existing sessions, subscribe first
  if (target.kind === 'existing') {
    await router.sendRpc('subscribe', { sessionId: target.sessionId });
    sessionId = target.sessionId as string;
  }

  // Send the turn
  const turnResult = await router.sendRpc('sendTurn', { intent }) as { sessionId: string };
  if (!sessionId) sessionId = turnResult.sessionId;
  if (args.debug) console.error(`[crispy-dispatch] Turn sent, sessionId: ${sessionId}`);

  // Write session ID to sidecar file for early access by callers
  if (args.sessionIdFile) {
    try { writeFileSync(args.sessionIdFile, sessionId, 'utf8'); } catch { /* best-effort */ }
  }

  // Subscribe to the session for events (existing sessions already subscribed)
  if (target.kind !== 'existing') {
    await router.sendRpc('subscribe', { sessionId });
  }

  // Wait for completion
  const status = await done;

  // Auto-close
  if (args.autoClose && status === 'completed') {
    router.sendFireAndForget('close', { sessionId });
  }

  // Final newline
  if (text && !text.endsWith('\n')) process.stdout.write('\n');

  // Emit structured metadata
  const meta: ResultMetadata = { status, sessionId, textLength: text.length };
  if (status === 'timeout') meta.partial = text.length > 0;
  if (approvalInfo !== null) {
    meta.toolName = (approvalInfo as { toolName: string; toolUseId: string }).toolName;
    meta.toolUseId = (approvalInfo as { toolName: string; toolUseId: string }).toolUseId;
  }
  emitResult(meta);

  process.exit(exitForStatus(status));
}

main().catch((err) => {
  console.error(err);
  process.exit(EXIT_TRANSPORT);
});
