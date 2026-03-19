#!/usr/bin/env node
/**
 * crispy-tracker.mjs — IPC-native CLI for project tracking
 *
 * Connects directly to the Crispy IPC socket (line-delimited JSON-RPC)
 * instead of shelling out to crispy-dispatch. Zero dependencies beyond
 * Node built-ins.
 *
 * Wire protocol (matches ipc-server.ts / client-connection.ts):
 *   Request:  {"kind":"request","id":"<n>","method":"<method>","params":{...}}\n
 *   Response: {"kind":"response","id":"<n>","result":{...}}\n
 *   Error:    {"kind":"error","id":"<n>","error":"<message>"}\n
 *
 * SYNC NOTE: Socket discovery and JSON-RPC framing are duplicated from
 * src/cli/ipc-client.ts and src/cli/rpc-pipe.ts. This file must be a
 * standalone .mjs (no build step, no TypeScript) so it can run from
 * `node $CRISPY_TRACKER` inside a child session. If the wire protocol
 * or discovery logic changes in those files, update this file too.
 */

import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

// ============================================================================
// Socket Discovery
// ============================================================================

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function discoverSocket() {
  if (process.env.CRISPY_SOCK) return process.env.CRISPY_SOCK;

  // SYNC: POSIX-only fallback. In normal Rosie invocation CRISPY_SOCK is always
  // set (see rosie-bot-hook.ts), so this path is dead code. Does NOT handle
  // Windows %APPDATA% — see src/core/paths.ts for the canonical logic.
  const serversFile = join(homedir(), '.crispy', 'ipc', 'servers.json');
  let entries;
  try {
    entries = JSON.parse(readFileSync(serversFile, 'utf8'));
  } catch {
    throw new Error('No Crispy IPC servers found. Is VS Code/Cursor running with Crispy?');
  }

  entries = entries.filter(e => isPidAlive(e.pid));
  if (entries.length === 0) throw new Error('No Crispy IPC servers running.');
  if (entries.length === 1) return entries[0].socket;

  // Multiple servers — match by longest CWD prefix
  const pwd = process.cwd();
  const sorted = entries
    .filter(e => pwd === e.cwd || pwd.startsWith(e.cwd.endsWith('/') ? e.cwd : e.cwd + '/'))
    .sort((a, b) => b.cwd.length - a.cwd.length);

  if (sorted.length > 0) return sorted[0].socket;
  throw new Error(
    `Multiple Crispy servers running but none match CWD "${pwd}". Set CRISPY_SOCK.\n` +
    `Active servers:\n${entries.map(e => `  PID ${e.pid}: ${e.cwd}`).join('\n')}`,
  );
}

// ============================================================================
// JSON-RPC over IPC
// ============================================================================

let nextId = 1;

function sendRpc(socketPath, method, params) {
  return new Promise((resolve, reject) => {
    const conn = connect(socketPath);
    const id = String(nextId++);
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    let settled = false;

    function settle(fn, value) {
      if (settled) return;
      settled = true;
      conn.end();
      fn(value);
    }

    conn.on('connect', () => {
      const msg = JSON.stringify({ kind: 'request', id, method, params });
      conn.write(msg + '\n');
    });

    conn.on('data', (chunk) => {
      buffer += decoder.write(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }

        if (parsed.id !== id) continue;

        if (parsed.kind === 'response') {
          settle(resolve, parsed.result);
        } else if (parsed.kind === 'error') {
          settle(reject, new Error(parsed.error));
        }
      }
    });

    conn.on('error', (err) => settle(reject, new Error(`Connection failed: ${err.message}`)));
    conn.on('close', () => settle(reject, new Error('Connection closed before response')));

    // Timeout after 30s
    setTimeout(() => settle(reject, new Error('RPC timeout (30s)')), 30000);
  });
}

/**
 * Full RPC call with session resolution (pending: prefix, short prefix).
 */
async function callRpc(socketPath, method, params) {
  let sessionId = process.env.CRISPY_SESSION_ID;

  // Resolve pending: or short prefixes
  if (sessionId?.startsWith('pending:')) {
    const resolved = await sendRpc(socketPath, 'resolveSessionId', { sessionId });
    sessionId = resolved.sessionId;
  } else if (sessionId && sessionId.length < 36) {
    const resolved = await sendRpc(socketPath, 'resolveSessionPrefix', { sessionId });
    sessionId = resolved.sessionId;
  }

  // Auto-inject sessionId if not already present
  if (sessionId && !('sessionId' in params)) {
    params.sessionId = sessionId;
  }

  // Pass parent session ID for session linking (the session being tracked)
  if (process.env.CRISPY_PARENT_SESSION_ID && !('parentSessionId' in params)) {
    params.parentSessionId = process.env.CRISPY_PARENT_SESSION_ID;
  }

  return sendRpc(socketPath, method, params);
}

// ============================================================================
// Arg Parsing Helpers
// ============================================================================

function parseFlags(args, spec) {
  const result = {};
  for (const key of Object.keys(spec)) result[key] = spec[key].default ?? '';
  let i = 0;
  while (i < args.length) {
    const flag = args[i];
    const key = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (!(key in spec)) {
      process.stderr.write(`Unknown flag: ${flag}\n`);
      process.exit(1);
    }
    result[key] = args[++i] ?? '';
    i++;
  }
  return result;
}

function buildParams(flags, mapping) {
  const params = {};
  for (const [flagKey, paramKey] of Object.entries(mapping)) {
    const val = flags[flagKey];
    if (val === undefined || val === '' || val === null) continue;
    params[paramKey] = val;
  }
  return params;
}

// ============================================================================
// Subcommands
// ============================================================================

const COMMANDS = {
  create: {
    help: `Usage: crispy-tracker create [flags]

Flags:
  --title      (required) Project title
  --type       (required) Project type (e.g. "project")
  --stage      (required) Stage name (e.g. "active", "done")
  --status     (required) Current status description
  --summary    (optional) Brief summary
  --icon       (optional) Emoji icon
  --parent-id  (optional) Parent project UUID (for type=task)`,

    run(args) {
      const flags = parseFlags(args, {
        title: {}, type: {}, stage: {}, status: {},
        summary: {}, icon: {}, parentId: {},
      });
      const params = buildParams(flags, {
        title: 'title', type: 'type', stage: 'stage', status: 'status',
        summary: 'summary', icon: 'icon', parentId: 'parent_id',
      });
      return { method: 'createProject', params };
    },
  },

  track: {
    help: `Usage: crispy-tracker track [flags]

Flags:
  --id          (required) Project UUID
  --status      (required) New status description
  --stage       (optional) Move to a different stage
  --blocked-by  (optional) Reason project is blocked
  --branch      (optional) Git branch name`,

    run(args) {
      const flags = parseFlags(args, {
        id: {}, status: {}, stage: {},
        blockedBy: {}, branch: {},
      });
      const params = buildParams(flags, {
        id: 'projectId', status: 'status', stage: 'stage',
        blockedBy: 'blocked_by', branch: 'branch',
      });
      return { method: 'trackProject', params };
    },
  },

  merge: {
    help: `Usage: crispy-tracker merge [flags]

Flags:
  --keep    (required) UUID of the project to keep
  --remove  (required) UUID of the duplicate to remove`,

    run(args) {
      const flags = parseFlags(args, { keep: {}, remove: {} });
      return {
        method: 'mergeProject',
        params: { keepId: flags.keep, removeId: flags.remove },
      };
    },
  },

  trivial: {
    help: `Usage: crispy-tracker trivial [flags]

Flags:
  --reason  (required) Why this turn is trivial`,

    run(args) {
      const flags = parseFlags(args, { reason: {} });
      return { method: 'markTrivial', params: { reason: flags.reason } };
    },
  },

  title: {
    help: `Usage: crispy-tracker title [flags]

Flags:
  --session  (required) Session ID
  --title    (required) New session title`,

    run(args) {
      const flags = parseFlags(args, { session: {}, title: {} });
      return {
        method: 'setSessionTitle',
        params: { sessionId: flags.session, title: flags.title },
      };
    },
  },

  show: {
    help: `Usage: crispy-tracker show [flags]

Flags:
  --id  (required) Project UUID to show details for`,

    run(args) {
      const flags = parseFlags(args, { id: {} });
      return { method: 'getProjectDetails', params: { projectId: flags.id } };
    },
  },

  stages: {
    help: `Usage: crispy-tracker stages

Lists all available project stages. No flags required.`,

    run() {
      return { method: 'getStages', params: {} };
    },
  },

  list: {
    help: `Usage: crispy-tracker list [flags]

Lists all projects with filtering and pagination. Excludes archived/done by default.

Flags:
  --all      (optional) Include archived and done projects
  --stage    (optional) Filter by stage name
  --type     (optional) Filter by type (project, task, idea)
  --limit    (optional) Results per page (default: 50)
  --offset   (optional) Pagination offset (default: 0)
  --json     (optional) Output raw JSON instead of formatted`,

    run(args) {
      const flags = parseFlags(args, {
        all: { default: 'false' },
        stage: { default: '' },
        type: { default: '' },
        limit: { default: '50' },
        offset: { default: '0' },
        json: { default: 'false' },
      });
      const limit = parseInt(flags.limit, 10) || 50;
      const offset = parseInt(flags.offset, 10) || 0;
      return {
        method: 'getProjects',
        params: {
          all: flags.all === 'true',
          stage: flags.stage || undefined,
          type: flags.type || undefined,
          limit,
          offset,
        },
        format: flags.json !== 'true',
        formatFlags: {
          excludeArchived: flags.all !== 'true',
          stageFilter: flags.stage,
          typeFilter: flags.type,
          limit,
          offset,
        },
      };
    },
  },

  dump: {
    help: `Usage: crispy-tracker dump

Dumps all projects as raw JSON. No filters, no pagination.`,

    run() {
      return { method: 'getProjects', params: { all: true, json: true } };
    },
  },
};

// ============================================================================
// Formatting
// ============================================================================

function formatListOutput(result, flags) {
  const { excludeArchived, stageFilter, typeFilter, limit, offset } = flags;
  let projects = result.projects || [];

  // Client-side filtering (server should filter, but ensure consistency)
  if (excludeArchived) {
    projects = projects.filter(p => p.stage !== 'archived' && p.stage !== 'done');
  }
  if (stageFilter) {
    projects = projects.filter(p => p.stage === stageFilter);
  }
  if (typeFilter) {
    projects = projects.filter(p => p.type === typeFilter);
  }

  // Format as table
  const header = `${'ID'.padEnd(8)} | ${'Stage'.padEnd(12)} | Title`;
  process.stdout.write(header + '\n');
  process.stdout.write('-'.repeat(80) + '\n');

  for (const p of projects.slice(0, limit)) {
    const row = `${p.id.substring(0, 8).padEnd(8)} | ${p.stage.padEnd(12)} | ${p.title}`;
    process.stdout.write(row + '\n');
  }

  // Pagination hint
  if (projects.length > limit) {
    process.stdout.write(`\n(Showing ${limit} of ${projects.length}. Use --offset ${offset + limit} for next page)\n`);
  }
}

// ============================================================================
// Main
// ============================================================================

function usage() {
  process.stdout.write(`Usage: crispy-tracker <subcommand> [flags]

Subcommands:
  create    Create a new project
  track     Update an existing project
  merge     Merge duplicate projects
  trivial   Mark a turn as trivial
  title     Set session title
  show      Show full details for a project
  stages    List available stages
  list      List projects with filtering and pagination
  dump      Dump all projects as raw JSON

Run \`crispy-tracker <subcommand> --help\` for subcommand flags.
`);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    usage();
    process.exit(0);
  }

  const subcommand = args[0];
  const subArgs = args.slice(1);

  const cmd = COMMANDS[subcommand];
  if (!cmd) {
    process.stderr.write(`Unknown subcommand: ${subcommand}\nRun 'crispy-tracker --help' for usage.\n`);
    process.exit(1);
  }

  if (subArgs[0] === '--help') {
    process.stdout.write(cmd.help + '\n');
    process.exit(0);
  }

  // Discover socket
  let socketPath;
  try {
    socketPath = discoverSocket();
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
    process.exit(1);
  }

  // Build RPC call from subcommand
  const spec = cmd.run(subArgs);
  const { method, params, format = false, formatFlags = {} } = spec;

  // Execute
  try {
    const result = await callRpc(socketPath, method, params);

    // Optional client-side formatting
    if (format && subcommand === 'list') {
      formatListOutput(result, formatFlags);
    } else {
      process.stdout.write(JSON.stringify(result) + '\n');
    }
    process.exit(0);
  } catch (err) {
    process.stderr.write(JSON.stringify({ error: err.message }) + '\n');
    process.exit(1);
  }
}

main();
