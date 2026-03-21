/**
 * Process Manager — PID/port file utilities for daemon lifecycle
 *
 * Pure file utilities for writing and reading PID/port run files.
 * Only imports from core/paths — no host-layer dependencies.
 *
 * @module process-manager
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { runDir } from '../core/paths.js';

function filePath(name: string, mode: 'prod' | 'dev'): string {
  const suffix = mode === 'dev' ? '-dev' : '';
  return join(runDir(), `crispy${suffix}.${name}`);
}

export function writePidFile(mode: 'prod' | 'dev'): void {
  mkdirSync(runDir(), { recursive: true });
  writeFileSync(filePath('pid', mode), String(process.pid));
}

export function readPidFile(mode: 'prod' | 'dev'): number | null {
  try {
    return parseInt(readFileSync(filePath('pid', mode), 'utf8').trim(), 10);
  } catch { return null; }
}

export function writePortFile(port: number, mode: 'prod' | 'dev'): void {
  mkdirSync(runDir(), { recursive: true });
  writeFileSync(filePath('port', mode), String(port));
}

export function readPortFile(mode: 'prod' | 'dev'): number | null {
  try {
    return parseInt(readFileSync(filePath('port', mode), 'utf8').trim(), 10);
  } catch { return null; }
}

export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function cleanupRunFiles(mode: 'prod' | 'dev'): void {
  for (const ext of ['pid', 'port']) {
    try { unlinkSync(filePath(ext, mode)); } catch { /* ENOENT ok */ }
  }
}
