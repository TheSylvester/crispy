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
 *   crispy _daemon  — (hidden) actual server process invoked by `start`
 *
 * @module crispy-cli
 */

import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openSync, mkdirSync, writeFileSync } from 'node:fs';
import { logsDir, tokenPath } from '../core/paths.js';
import { rotateToken } from '../host/auth.js';
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
  const { startServer } = await import('../host/dev-server.js');

  const handle = await startServer({
    port,
    host: '127.0.0.1',
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

  console.log('Starting Crispy daemon...');
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

  // Wait for daemon to write port file
  await sleep(2000);
  const port = readPortFile('prod');
  if (port && await checkHealth(port)) {
    console.log(`Crispy daemon started (PID ${child.pid}) on http://localhost:${port}`);
    console.log(`Logs: ${logPath}`);
  } else {
    console.error('Daemon may have failed to start. Check logs:', logPath);
    process.exit(1);
  }
}

async function runDaemon(): Promise<void> {
  delete process.env.CLAUDECODE;

  const port = parsePortFlag();
  const { startServer } = await import('../host/dev-server.js');

  const handle = await startServer({
    port,
    host: '127.0.0.1',
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
  case '':        startForeground(); break;
  case 'start':   startBackground(); break;
  case 'stop':    stopDaemon(); break;
  case 'status':  showStatus(); break;
  case 'open':    openBrowser(); break;
  case '_daemon': runDaemon(); break;
  default:
    console.error(`Unknown command: ${command}`);
    console.error('Usage: crispy [start|stop|status|open]');
    process.exit(1);
}
