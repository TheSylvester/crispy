/**
 * Find Codex Binary — locate the globally-installed Codex CLI binary
 *
 * Mirrors the find-claude-binary.ts pattern. Codex is a native Rust binary
 * (not an npm package), so it ships as `codex` on Unix and `codex.exe` on
 * Windows — never `.cmd`.
 *
 * Search order:
 * 1. `CODEX_PATH` environment variable (explicit override)
 * 2. `which codex` (Unix) / `where codex` (Windows) via execFileSync
 * 3. Well-known install locations per platform
 *
 * Returns the absolute path if found and exists, or undefined.
 *
 * @module find-codex-binary
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * Locate the globally-installed Codex CLI binary.
 *
 * @returns Absolute path to the `codex` binary, or undefined if not found.
 */
export function findCodexBinary(): string | undefined {
  // 1. Explicit override via environment variable
  const envPath = process.env.CODEX_PATH;
  if (envPath && existsSync(envPath)) {
    return envPath;
  }

  // 2. which/where lookup
  const whichResult = resolveViaWhich();
  if (whichResult) {
    return whichResult;
  }

  // 3. Well-known install locations
  const wellKnown = resolveViaWellKnownPaths();
  if (wellKnown) {
    return wellKnown;
  }

  return undefined;
}

/**
 * Try to resolve `codex` via the system PATH using `which` (Unix) or
 * `where` (Windows).
 */
function resolveViaWhich(): string | undefined {
  const cmd = platform() === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(cmd, ['codex'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();

    // `where` on Windows may return multiple lines — take the first
    const firstLine = result.split('\n')[0]?.trim();
    if (firstLine && existsSync(firstLine)) {
      return firstLine;
    }
  } catch {
    // Not found on PATH — fall through
  }
  return undefined;
}

/**
 * Check well-known install locations for the Codex binary.
 */
function resolveViaWellKnownPaths(): string | undefined {
  const os = platform();

  const candidates: string[] = [];

  if (os === 'linux') {
    candidates.push(join(homedir(), '.local', 'bin', 'codex'));
  } else if (os === 'darwin') {
    candidates.push('/usr/local/bin/codex');
  } else if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(join(localAppData, 'Programs', 'codex', 'codex.exe'));
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
