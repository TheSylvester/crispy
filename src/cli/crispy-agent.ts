/**
 * crispy-agent — cross-platform CLI wrapper for multi-vendor IPC dispatch
 *
 * Replaces the bash script `src/plugin/scripts/crispy-agent` with a Node.js
 * implementation that works on Windows. Connects directly to the Crispy IPC
 * host via discoverSocket() + MessageRouter (same primitives as crispy-dispatch).
 *
 * Prompt resolution: PROMPT_FILE env var → positional args → stdin
 *
 * Exit codes:
 *   0   completed
 *   10  approval_required (session paused, can resume)
 *   11  timeout (may have partial text on stdout)
 *   12  transport_error (socket not found, connection dropped)
 *   13  invalid_usage (bad flags, no prompt)
 *
 * @module crispy-agent
 */

import { connect, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
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

interface AgentArgs {
  vendor: string;
  model?: string;
  resume?: string;
  timeoutMs: number;
  autoClose: boolean;
  visible: boolean;
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

function parseArgs(argv: string[]): { args: AgentArgs; positionalParts: string[] } {
  const args: AgentArgs = {
    vendor: 'claude',
    timeoutMs: 600_000,
    autoClose: true,
    visible: true,
    fork: false,
    persist: true,
    approval: 'bypass',
    debug: false,
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
      case '--model':
      case '-m':
        args.model = requireValue(arg, argv, i);
        i++;
        break;
      case '--resume':
      case '-r':
        args.resume = requireValue(arg, argv, i);
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
      case '--auto-close':
        args.autoClose = true;
        break;
      case '--visible':
      case '--open':
        args.visible = true;
        break;
      case '--no-open':
        args.visible = false;
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
      case '--session-id-file':
        args.sessionIdFile = requireValue('--session-id-file', argv, i);
        i++;
        break;
      case '--debug':
        args.debug = true;
        break;
      case '--':
        i++;
        while (i < argv.length) { positionalParts.push(argv[i]!); i++; }
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

  // Long-running agent sessions (--no-auto-close) default to no timeout —
  // wait indefinitely for the turn to complete. Explicit --timeout overrides.
  if (!args.autoClose && !explicitTimeout) {
    args.timeoutMs = 0;
  }

  return { args, positionalParts };
}

// ============================================================================
// Prompt Resolution
// ============================================================================

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

function resolvePrompt(positionalParts: string[]): string | undefined {
  // Priority: PROMPT_FILE > positional args > (stdin handled by caller)
  const pf = process.env.PROMPT_FILE;
  if (pf) {
    try {
      return readFileSync(resolve(pf), 'utf8').trim();
    } catch (err) {
      console.error(`Error reading PROMPT_FILE "${pf}": ${(err as Error).message}`);
      process.exit(EXIT_USAGE);
    }
  }
  if (positionalParts.length > 0) return positionalParts.join(' ');
  return undefined;
}

// ============================================================================
// Main
// ============================================================================

const OUTPUT_DIR = join(tmpdir(), 'crispy-agents');

async function main(): Promise<void> {
  const { args, positionalParts } = parseArgs(process.argv);

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
  let prompt = resolvePrompt(positionalParts);
  if (!prompt) {
    const stdinContent = await readStdin();
    if (stdinContent) {
      prompt = stdinContent;
    } else {
      console.error('Usage: crispy-agent [--vendor <vendor>] [--model <model>] [--resume <UUID>] <prompt>');
      console.error('       PROMPT_FILE=task.md crispy-agent');
      console.error('       cat task.md | crispy-agent');
      process.exit(EXIT_USAGE);
    }
  }

  // Validate non-empty
  if (!prompt.trim()) {
    console.error('Error: prompt is empty');
    process.exit(EXIT_USAGE);
  }

  // Set up output file
  let outputFile: string | null = null;
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    outputFile = join(OUTPUT_DIR, `crispy-agent-${Date.now()}-${process.pid}.log`);
    console.error(`[output_file: ${outputFile}]`);
  } catch { /* best-effort */ }

  // Build settings
  const settings: Record<string, unknown> = {};
  if (args.model) settings.model = args.model;
  if (args.approval === 'bypass') {
    settings.permissionMode = 'bypassPermissions';
  }

  // Connect to IPC
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
    await new Promise<void>((ok, fail) => {
      conn.once('connect', ok);
      conn.once('error', fail);
    });
  } catch (err) {
    console.error(`Connection failed: ${(err as Error).message}`);
    process.exit(EXIT_TRANSPORT);
  }

  if (args.debug) console.error(`[crispy-agent] Connected to ${socketPath}`);

  const router = new MessageRouter(conn);

  // Resolve truncated session ID prefixes
  if (args.resume && args.resume.length < 36) {
    try {
      const resolved = await router.sendRpc('resolveSessionPrefix', { sessionId: args.resume }) as { sessionId: string };
      args.resume = resolved.sessionId;
    } catch (err) {
      console.error(`Error resolving session prefix: ${(err as Error).message}`);
      process.exit(EXIT_USAGE);
    }
  }

  try {
    await runTurn(router, args, prompt, settings, outputFile);
  } catch (err) {
    emitResult({ status: 'error', sessionId: '', textLength: 0, error: (err as Error).message });
    process.exit(EXIT_TRANSPORT);
  }

  router.end();
}

// ============================================================================
// Turn Execution
// ============================================================================

async function runTurn(
  router: MessageRouter,
  args: AgentArgs,
  prompt: string,
  settings: Record<string, unknown>,
  outputFile: string | null,
): Promise<void> {
  const skipPersistSession = !args.persist;
  const parentSessionId = process.env.CRISPY_SESSION_ID || `cli-${Date.now()}`;

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
      parentSessionId,
      ...(skipPersistSession && { skipPersistSession }),
    };
  }

  // Build intent
  const intent: Record<string, unknown> = {
    target,
    content: prompt,
    clientMessageId: crypto.randomUUID(),
    settings,
    ...(args.visible && { openChannel: true }),
    ...(args.visible && { visible: true }),
    ...(args.autoClose !== undefined && { autoClose: args.autoClose }),
    ...(parentSessionId && { parentSessionId }),
  };

  // State for event collection
  let sessionId = '';
  let text = '';
  let settled = false;
  let approvalInfo: { toolName: string; toolUseId: string } | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  // Install event handler BEFORE any RPCs — no event gap
  const done = new Promise<ResultStatus>((resolve) => {
    const timer = args.timeoutMs > 0
      ? setTimeout(() => {
          if (!settled) {
            settled = true;
            if (idleTimer) clearTimeout(idleTimer);
            resolve('timeout');
          }
        }, args.timeoutMs)
      : undefined;

    router.setEventHandler((evt) => {
      if (settled) return;
      const event = evt.event;
      const inner = event.type === 'event' && event.event ? event.event as Record<string, unknown> : event;

      // Track session ID rekey
      if (inner.type === 'notification' && inner.kind === 'session_changed' && inner.sessionId) {
        const newId = inner.sessionId as string;
        if (args.debug) console.error(`[crispy-agent] Session rekey: ${sessionId} → ${newId}`);
        sessionId = newId;
        if (args.sessionIdFile) {
          try { writeFileSync(args.sessionIdFile, newId, 'utf8'); } catch { /* best-effort */ }
        }
      }

      // Collect assistant text
      if (event.type === 'entry' && event.entry) {
        const entry = event.entry as { type?: string; message?: { content?: unknown } };
        if ((entry.type === 'assistant' || entry.type === 'result') && entry.message) {
          const content = entry.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'text' && block.text) {
                text += block.text;
              }
            }
          } else if (typeof content === 'string') {
            text += content;
          }
        }
      }

      // Turn complete — two-tier detection
      if (inner.type === 'status' && inner.status === 'idle') {
        if (args.debug) console.error(`[crispy-agent] Session idle (turnComplete: ${'turnComplete' in inner && inner.turnComplete})`);

        if ('turnComplete' in inner && inner.turnComplete) {
          settled = true;
          if (idleTimer) clearTimeout(idleTimer);
          clearTimeout(timer);
          resolve('completed');
        } else {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve('completed');
            }
          }, 2000);
        }
      }

      // Non-idle cancels debounce
      if (inner.type === 'status' && inner.status !== 'idle') {
        if (idleTimer) { clearTimeout(idleTimer); idleTimer = undefined; }
      }

      // Approval required
      if (inner.type === 'status' && inner.status === 'awaiting_approval') {
        if (args.approval === 'fail') {
          approvalInfo = {
            toolName: (inner.toolName as string) ?? 'unknown',
            toolUseId: (inner.toolUseId as string) ?? '',
          };
          settled = true;
          if (idleTimer) clearTimeout(idleTimer);
          clearTimeout(timer);
          resolve('approval_required');
        } else if (args.approval === 'manual') {
          if (args.debug) console.error(
            `[crispy-agent] Awaiting approval for "${inner.toolName}". Approve in Crispy UI.`,
          );
        }
      }

      // Error notification
      if (inner.type === 'notification' && inner.kind === 'error') {
        console.error(`[crispy-agent] Error: ${(inner as { error?: string }).error ?? 'unknown'}`);
      }
    });
  });

  // Subscribe first for existing sessions
  if (target.kind === 'existing') {
    await router.sendRpc('subscribe', { sessionId: target.sessionId });
    sessionId = target.sessionId as string;
  }

  // Send turn
  const turnResult = await router.sendRpc('sendTurn', { intent }) as { sessionId: string };
  if (!sessionId) sessionId = turnResult.sessionId;
  if (args.debug) console.error(`[crispy-agent] Turn sent, sessionId: ${sessionId}`);

  // Write session ID sidecar
  if (args.sessionIdFile) {
    try { writeFileSync(args.sessionIdFile, sessionId, 'utf8'); } catch { /* best-effort */ }
  }

  // Subscribe for new/fork sessions
  if (target.kind !== 'existing') {
    await router.sendRpc('subscribe', { sessionId });
  }

  // Wait for completion
  const status = await done;

  // Output text to stdout
  if (text) {
    process.stdout.write(text);
    if (!text.endsWith('\n')) process.stdout.write('\n');
  }

  // Output session ID and resume hint
  if (sessionId) {
    process.stdout.write(`\n[session_id: ${sessionId}]\n`);
    process.stdout.write(`To resume: $CRISPY_AGENT --resume ${sessionId} "Your follow-up message"\n`);
  }

  // Write to persistent output file
  if (outputFile) {
    try {
      let content = text || '';
      if (sessionId) {
        content += `\n[session_id: ${sessionId}]\n`;
        content += `To resume: $CRISPY_AGENT --resume ${sessionId} "Your follow-up message"\n`;
      }
      writeFileSync(outputFile, content, 'utf8');
    } catch { /* best-effort */ }
  }

  // Auto-close
  if (args.autoClose && status === 'completed') {
    router.sendFireAndForget('close', { sessionId });
  }

  // Emit structured metadata to stderr
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
