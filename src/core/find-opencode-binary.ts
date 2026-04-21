/**
 * Find OpenCode Binary — locate the globally-installed OpenCode CLI binary
 *
 * Mirrors the find-codex-binary.ts pattern. OpenCode is a Go binary,
 * so it ships as `opencode` on Unix — never `.cmd`.
 *
 * Search order:
 * 1. `OPENCODE_PATH` environment variable (explicit override)
 * 2. `which opencode` (Unix) / `where opencode` (Windows) via execFileSync
 * 3. Well-known install locations per platform
 *
 * Returns the absolute path if found and exists, or undefined.
 *
 * @module find-opencode-binary
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * Locate the globally-installed OpenCode CLI binary.
 *
 * @returns Absolute path to the `opencode` binary, or undefined if not found.
 */
export function findOpencodeBinary(): string | undefined {
  // 1. Explicit override via environment variable
  const envPath = process.env.OPENCODE_PATH;
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
 * Try to resolve `opencode` via the system PATH using `which` (Unix) or
 * `where` (Windows).
 */
function resolveViaWhich(): string | undefined {
  const cmd = platform() === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(cmd, ['opencode'], {
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
 * Check well-known install locations for the OpenCode binary.
 */
function resolveViaWellKnownPaths(): string | undefined {
  const os = platform();
  const home = homedir();

  const candidates: string[] = [];

  if (os === 'linux' || os === 'darwin') {
    candidates.push(
      join(home, '.local', 'bin', 'opencode'),
      join(home, 'go', 'bin', 'opencode'),     // Go install default
      join(home, 'dev', 'opencode', 'opencode'), // Dev build
    );
  }

  if (os === 'darwin') {
    candidates.push('/usr/local/bin/opencode');
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
