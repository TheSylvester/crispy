/**
 * crispy-dispatch — CLI client for Crispy IPC
 *
 * Connects to the running Crispy extension host over a Unix domain socket
 * (or Windows named pipe) and dispatches sessions via JSON-RPC.
 *
 * Three modes:
 *   1. dispatchChild (default) — hidden child session, collects text, exits
 *   2. sendTurn (--visible)    — real session visible in editor, streams events
 *   3. resumeChild (--resume)  — follow-up turn on existing child session
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
import { join, resolve } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

import {
  EXIT_OK, EXIT_APPROVAL, EXIT_TIMEOUT, EXIT_TRANSPORT, EXIT_USAGE,
  discoverSocket, MessageRouter,
  type RpcEvent,
} from './ipc-client.js';

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
  resume?: string;
  fork: boolean;
  resumeAt?: string;
  persist: boolean;
  approval: ApprovalMode;
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
    fork: false,
    persist: false,
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
        args.visible = true;
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
        args.persist = true;
        break;
      case '--no-persist':
        // Deprecated alias — default is already ephemeral
        if (args.debug) console.error('[crispy-dispatch] --no-persist is deprecated (ephemeral is the default). Use --persist to opt-in to persistence.');
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
  --visible                 Show session in editor UI (uses sendTurn instead of dispatchChild)
  --parent-session <id>     Parent session ID (or set CRISPY_PARENT_SESSION)
  --timeout <ms>            Timeout in milliseconds (default: 600000)
  --persist                 Save session to disk (default: ephemeral)
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
  CRISPY_PARENT_SESSION     Default parent session ID
  PROMPT_FILE               Read prompt from file
  BYPASS_PERMISSIONS=1      Shorthand for --approval bypass
  CRISPY_DISPATCH_APPROVAL  Default approval mode (fail|bypass|manual)
  CRISPY_DISPATCH_DEBUG=1   Enable diagnostics`);
}

// ============================================================================
// Main
// ============================================================================

const OUTPUT_DIR = join('/tmp', 'crispy-agents');

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

  // Set up output file
  let outputFile: string | null = null;
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    outputFile = join(OUTPUT_DIR, `crispy-dispatch-${Date.now()}-${process.pid}.log`);
    if (args.debug) console.error(`[output_file: ${outputFile}]`);
  } catch { /* best-effort */ }

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
    if (args.visible) {
      console.error('[crispy-dispatch] --visible mode is temporarily disabled');
      process.exit(EXIT_USAGE);
    } else if (args.resume && !args.fork) {
      await runResumeMode(router, args, prompt!, settings, outputFile);
    } else {
      await runDispatchMode(router, args, prompt!, settings, outputFile);
    }
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
// Mode: Visible (sendTurn — fix #1: event handler installed before RPC)
// ============================================================================

async function runVisibleMode(
  router: MessageRouter,
  args: CliArgs,
  prompt: string,
  settings: Record<string, unknown>,
  outputFile: string | null,
): Promise<void> {
  const skipPersistSession = !args.persist;
  const cwd = process.cwd();

  // Build TurnTarget
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
      cwd,
      ...(skipPersistSession && { skipPersistSession }),
    };
  }

  const intent = {
    target,
    content: prompt,
    clientMessageId: crypto.randomUUID(),
    settings,
  };

  const parentSessionId = args.parentSessionId
    || process.env.CRISPY_PARENT_SESSION
    || `cli-${Date.now()}`;
  const provenance = {
    parentSessionId,
    autoClose: args.autoClose,
    visible: true,
  };

  // State for event collection
  let sessionId = '';
  let text = '';
  let settled = false;
  let approvalInfo: { toolName: string; toolUseId: string } | null = null;

  // Install event handler BEFORE any RPCs — no event gap (fix #1)
  const done = new Promise<ResultStatus>((resolve) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve('timeout');
      }
    }, args.timeoutMs);

    router.setEventHandler((evt) => {
      if (settled) return;
      const event = evt.event;

      // Unwrap ChannelMessage envelope: EventMessage wraps the real event
      // as { type: 'event', event: ChannelEvent }, while EntryMessage has
      // { type: 'entry', entry: TranscriptEntry } — no extra nesting.
      const inner = event.type === 'event' && event.event ? event.event as Record<string, unknown> : event;

      // Track session ID rekey (pending → real)
      if (inner.type === 'notification' && inner.kind === 'session_changed' && inner.sessionId) {
        const newId = inner.sessionId as string;
        if (args.debug) console.error(`[crispy-dispatch] Session rekey: ${sessionId} → ${newId}`);
        sessionId = newId;
      }

      // Collect assistant text from entry messages
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

      // Turn complete
      if (inner.type === 'status' && inner.status === 'idle') {
        if (args.debug) console.error(`[crispy-dispatch] Session idle — turn complete`);
        settled = true;
        clearTimeout(timer);
        resolve('completed');
      }

      // Approval required (fix #5)
      if (inner.type === 'status' && inner.status === 'awaiting_approval') {
        if (args.approval === 'fail') {
          approvalInfo = {
            toolName: (inner.toolName as string) ?? 'unknown',
            toolUseId: (inner.toolUseId as string) ?? '',
          };
          settled = true;
          clearTimeout(timer);
          resolve('approval_required');
        } else if (args.approval === 'manual') {
          if (args.debug) console.error(
            `[crispy-dispatch] Awaiting approval for "${inner.toolName}". Approve in Crispy UI.`,
          );
          // Don't resolve — wait for idle or timeout
        }
        // bypass: never reaches here (permissionMode=bypassPermissions)
      }

      // Error notification
      if (inner.type === 'notification' && inner.kind === 'error') {
        console.error(`[crispy-dispatch] Error: ${(inner as { error?: string }).error ?? 'unknown'}`);
      }
    });
  });

  // For existing sessions, subscribe first
  if (target.kind === 'existing') {
    await router.sendRpc('subscribe', { sessionId: target.sessionId });
    sessionId = target.sessionId as string;
  }

  // Send the turn
  const turnResult = await router.sendRpc('sendTurn', { intent, provenance }) as { sessionId: string };
  if (!sessionId) sessionId = turnResult.sessionId;
  if (args.debug) console.error(`[crispy-dispatch] Turn sent, sessionId: ${sessionId}`);

  // Subscribe to the session for events (existing sessions already subscribed)
  if (target.kind !== 'existing') {
    await router.sendRpc('subscribe', { sessionId });
  }

  // Wait for completion
  const status = await done;

  // Write output file
  if (outputFile && text) {
    try { writeFileSync(outputFile, text, 'utf8'); } catch { /* best-effort */ }
  }

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

// ============================================================================
// Mode: Resume (resumeChild)
// ============================================================================

async function runResumeMode(
  router: MessageRouter,
  args: CliArgs,
  prompt: string,
  settings: Record<string, unknown>,
  outputFile: string | null,
): Promise<void> {
  const resumeParams: Record<string, unknown> = {
    sessionId: args.resume,
    prompt,
    settings,
    autoClose: args.autoClose,
    timeoutMs: args.timeoutMs,
  };
  if (outputFile) {
    resumeParams.logFile = outputFile;
    writeFileSync(outputFile,
      `# crispy-dispatch resume vendor=${args.vendor} started=${new Date().toISOString()}\n---\n`,
      'utf8');
  }

  const result = await router.sendRpc('resumeChild', resumeParams) as {
    sessionId: string; text: string; structured?: unknown;
  } | null;

  if (result) {
    if (result.text) {
      process.stdout.write(result.text);
      if (!result.text.endsWith('\n')) process.stdout.write('\n');
    }
    // Log file is now streamed via onEntry — no all-at-once write needed
    emitResult({ status: 'completed', sessionId: result.sessionId, textLength: result.text.length });
    process.exit(EXIT_OK);
  } else {
    emitResult({ status: 'timeout', sessionId: args.resume!, textLength: 0 });
    process.exit(EXIT_TIMEOUT);
  }
}

// ============================================================================
// Mode: Dispatch (dispatchChild — default)
// ============================================================================

async function runDispatchMode(
  router: MessageRouter,
  args: CliArgs,
  prompt: string,
  settings: Record<string, unknown>,
  outputFile: string | null,
): Promise<void> {
  const parentSessionId = args.parentSessionId
    || process.env.CRISPY_PARENT_SESSION
    || `cli-${Date.now()}`;

  const dispatchParams: Record<string, unknown> = {
    parentSessionId,
    vendor: args.vendor,
    parentVendor: args.parentVendor ?? args.vendor,
    prompt,
    autoClose: args.autoClose,
    skipPersistSession: !args.persist,
    forceNew: !args.resume,
    cwd: process.cwd(),
  };

  if (Object.keys(settings).length > 0) {
    dispatchParams.settings = settings;
  }
  dispatchParams.timeoutMs = args.timeoutMs;

  // Stream log entries to the output file as they arrive (instead of all-at-once at the end)
  if (outputFile) {
    dispatchParams.logFile = outputFile;
    writeFileSync(outputFile,
      `# crispy-dispatch vendor=${args.vendor} started=${new Date().toISOString()}\n---\n`,
      'utf8');
  }

  // Fork mode with dispatchChild
  if (args.resume && args.fork) {
    dispatchParams.parentSessionId = args.resume;
    dispatchParams.forceNew = false;
  }

  const result = await router.sendRpc('dispatchChild', dispatchParams) as {
    sessionId: string;
    text: string;
    structured?: unknown;
  } | null;

  if (result) {
    if (result.text) {
      process.stdout.write(result.text);
      if (!result.text.endsWith('\n')) process.stdout.write('\n');
    }
    // Log file is now streamed via onEntry — no all-at-once write needed
    emitResult({ status: 'completed', sessionId: result.sessionId, textLength: result.text.length });
    process.exit(EXIT_OK);
  } else {
    emitResult({ status: 'timeout', sessionId: '', textLength: 0 });
    process.exit(EXIT_TIMEOUT);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(EXIT_TRANSPORT);
});
