/**
 * Crispy CLI — Daemon lifecycle manager
 *
 * Thin entry point that manages the standalone Crispy daemon.
 *
 * Commands:
 *   crispy          — foreground mode: start server, open browser, block
 *   crispy start    — background daemon: spawn detached child
 *   crispy stop     — SIGTERM via PID file
 *   crispy status   — check PID + health
 *   crispy open     — open browser to running instance
 *   crispy config   — interactive settings wizard
 *   crispy add      — add a workspace root to the running daemon
 *   crispy _daemon  — (hidden) actual server process invoked by `start`
 *
 * @module crispy-cli
 */

import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { logsDir, tokenPath } from '../core/paths.js';
import { rotateToken } from '../host/auth.js';
import { CRISPY_VERSION } from '../core/version.js';
import {
  writePidFile, readPidFile, writePortFile, readPortFile,
  isProcessAlive, cleanupRunFiles,
} from './process-manager.js';

const DEFAULT_PORT = 3456;

function parsePortFlag(): number {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) {
    return parseInt(process.argv[idx + 1], 10);
  }
  return DEFAULT_PORT;
}

function parseHostFlag(): string {
  const idx = process.argv.indexOf('--host');
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  return '127.0.0.1';
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function checkHealth(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await res.json() as { status: string };
    return data.status === 'ok';
  } catch { return false; }
}

// ---- Subcommands ----

async function startForeground(): Promise<void> {
  // Check if already running
  const existingPid = readPidFile('prod');
  if (existingPid && isProcessAlive(existingPid)) {
    const port = readPortFile('prod');
    console.log(`Crispy is already running (PID ${existingPid}) on http://localhost:${port}`);
    return;
  }

  console.log('Starting Crispy (this may take a moment on first run)...');

  delete process.env.CLAUDECODE;

  const port = parsePortFlag();
  const host = parseHostFlag();
  const { startServer } = await import('../host/dev-server.js');

  const handle = await startServer({
    port,
    host,
    mode: 'daemon',
    hostType: 'daemon',
  });

  writePidFile('prod');
  writePortFile(handle.port, 'prod');

  // Open browser
  try {
    const open = (await import('open')).default;
    await open(`http://localhost:${handle.port}`);
  } catch { /* browser launch is best-effort */ }

  console.log(`Crispy running on http://localhost:${handle.port} (PID ${process.pid})`);

  const cleanup = () => {
    cleanupRunFiles('prod');
    handle.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

async function startBackground(): Promise<void> {
  const existingPid = readPidFile('prod');
  if (existingPid && isProcessAlive(existingPid)) {
    const port = readPortFile('prod');
    console.log(`Crispy is already running (PID ${existingPid}) on http://localhost:${port}`);
    return;
  }

  console.log(`Starting Crispy v${CRISPY_VERSION} daemon...`);
  mkdirSync(logsDir(), { recursive: true });
  const logPath = join(logsDir(), 'crispy.log');
  const logFd = openSync(logPath, 'a');

  // Build args: pass through --port if provided
  const args = [process.argv[1], '_daemon'];
  const portIdx = process.argv.indexOf('--port');
  if (portIdx !== -1 && process.argv[portIdx + 1]) {
    args.push('--port', process.argv[portIdx + 1]);
  }

  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: { ...process.env },
  });

  child.unref();

  // Poll for daemon readiness (port file + health check)
  let port: number | null = null;
  let healthy = false;
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    port = readPortFile('prod');
    if (port && await checkHealth(port)) {
      healthy = true;
      break;
    }
  }

  if (healthy) {
    console.log(`Crispy v${CRISPY_VERSION} daemon started (PID ${child.pid}) on http://localhost:${port}`);
    console.log(`Logs: ${logPath}`);
  } else {
    console.error('Daemon may have failed to start. Check logs:', logPath);
    process.exit(1);
  }
}

async function runDaemon(): Promise<void> {
  delete process.env.CLAUDECODE;

  const port = parsePortFlag();
  const host = parseHostFlag();
  const { startServer } = await import('../host/dev-server.js');

  const handle = await startServer({
    port,
    host,
    mode: 'daemon',
    hostType: 'daemon',
  });

  writePidFile('prod');
  writePortFile(handle.port, 'prod');

  const cleanup = () => {
    cleanupRunFiles('prod');
    handle.shutdown().then(() => process.exit(0));
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

async function stopDaemon(): Promise<void> {
  const pid = readPidFile('prod');
  if (!pid || !isProcessAlive(pid)) {
    console.log('Crispy is not running.');
    cleanupRunFiles('prod');
    return;
  }

  process.kill(pid, 'SIGTERM');
  console.log(`Sent SIGTERM to PID ${pid}`);

  // Wait for process to exit
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    if (!isProcessAlive(pid)) {
      cleanupRunFiles('prod');
      console.log('Crispy stopped.');
      return;
    }
  }

  console.error('Process did not exit within 5s. You may need to kill it manually.');
}

async function showStatus(): Promise<void> {
  const pid = readPidFile('prod');
  if (!pid || !isProcessAlive(pid)) {
    console.log('Crispy is not running.');
    return;
  }

  const port = readPortFile('prod');
  if (port && await checkHealth(port)) {
    console.log(`Crispy is running (PID ${pid}) on http://localhost:${port}`);
  } else {
    console.log(`Crispy process exists (PID ${pid}) but is not responding.`);
  }
}

async function openBrowser(): Promise<void> {
  const port = readPortFile('prod');
  if (!port) {
    console.error('Crispy is not running. Run: crispy start');
    process.exit(1);
  }
  if (!(await checkHealth(port))) {
    console.error(`Port ${port} is not responding. Try: crispy stop && crispy start`);
    process.exit(1);
  }
  const open = (await import('open')).default;
  await open(`http://localhost:${port}`);
}

// ---- Token management flags ----

if (process.argv.includes('--rotate-token')) {
  const newToken = rotateToken();
  console.log(`Token rotated: ${newToken}`);
  console.log(`Saved to: ${tokenPath()}`);
  process.exit(0);
}

const tokenFlagIndex = process.argv.indexOf('--token');
if (tokenFlagIndex !== -1) {
  const value = process.argv[tokenFlagIndex + 1];
  if (!value) { console.error('--token requires a value'); process.exit(1); }
  writeFileSync(tokenPath(), value + '\n', { mode: 0o600 });
  console.log(`Token set. Saved to: ${tokenPath()}`);
  process.exit(0);
}

// ---- Main dispatch ----

const command = process.argv[2] || '';

switch (command) {
  case 'help':
  case '--help':
  case '-h':
    console.log(`
Crispy v${CRISPY_VERSION} — zero-compromise infrastructure for AI coding tools

Usage: crispy [command] [options]

Commands:
  (none)     Start in foreground (server + browser)
  start      Start as background daemon
  stop       Stop the running daemon
  status     Check daemon status
  open       Open browser to running instance
  config     Interactive settings wizard
  add <path> Add a workspace root to the running daemon
  cloud      Cloud relay tunnel (link, unlink, status)
  help       Show this help message

Options:
  --port <number>    Server port (default: 3456)
  --host <address>   Bind address (default: 127.0.0.1)
  --token <value>    Set auth token
  --rotate-token     Rotate auth token and print it
  -v, --version      Show version
  -h, --help         Show this help message
`.trim());
    process.exit(0);
    break;
  case '--version':
  case '-v':
    console.log(CRISPY_VERSION);
    process.exit(0);
    break;
  case '':        startForeground(); break;
  case 'start':   startBackground(); break;
  case 'stop':    stopDaemon(); break;
  case 'status':  showStatus(); break;
  case 'open':    openBrowser(); break;
  case '_daemon': runDaemon(); break;
  case 'config': {
    import('./crispy-config.js').then(({ runConfig }) => runConfig()).catch((err) => {
      console.error('Config failed:', err);
      process.exit(1);
    });
    break;
  }
  case 'add': {
    const target = process.argv[3];
    if (!target) { console.error('Usage: crispy add <path>'); process.exit(1); }
    const expanded = target.startsWith('~')
      ? join(homedir(), target.slice(1))
      : resolve(target);
    import('./ipc-client.js').then(async ({ discoverSocket, MessageRouter }) => {
      const { connect } = await import('node:net');
      let socketPath: string;
      try {
        socketPath = discoverSocket();
      } catch {
        console.error('No running Crispy daemon found.');
        process.exit(1);
        return;
      }
      const conn = connect(socketPath);
      const router = new MessageRouter(conn);
      await router.sendRpc('addWorkspaceRoot', { path: expanded });
      console.log(`Workspace root added: ${expanded}`);
      router.end();
      process.exit(0);
    }).catch((err) => {
      console.error('Failed to add workspace root:', err);
      process.exit(1);
    });
    break;
  }
  case 'cloud': {
    import('./crispy-cloud.js').then(({ runCloud }) => runCloud()).catch((err) => {
      console.error('Cloud command failed:', err);
      process.exit(1);
    });
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Run `crispy help` for usage.');
    process.exit(1);
}
