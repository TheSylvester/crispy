/**
 * Find Claude Binary — locate the globally-installed Claude Code native binary
 *
 * Resolves the path to Claude Code so the Agent SDK can spawn it. The SDK's
 * spawn logic checks if the path ends in `.js` — if it does, it runs
 * `node <path>`; if it doesn't, it runs the binary directly. We return
 * either the native binary or the cli.js from an npm/bun global install.
 *
 * Search order:
 * 1. `CLAUDE_CODE_PATH` environment variable (explicit override)
 * 2. `which claude` (Unix) / `where claude` (Windows) via execFileSync
 * 3. Well-known install locations per platform
 *
 * Returns the absolute path if found and exists, or undefined.
 *
 * @module find-claude-binary
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';

/**
 * Locate the globally-installed Claude Code native binary.
 *
 * @returns Absolute path to the `claude` binary, or undefined if not found.
 */
export function findClaudeBinary(): string | undefined {
  // 1. Explicit override via environment variable
  const envPath = process.env.CLAUDE_CODE_PATH;
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
 * Try to resolve `claude` via the system PATH using `which` (Unix) or
 * `where` (Windows).
 */
function resolveViaWhich(): string | undefined {
  const cmd = platform() === 'win32' ? 'where' : 'which';
  try {
    const result = execFileSync(cmd, ['claude'], {
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

    // `where` on Windows may return multiple lines — take the first
    const firstLine = result.split('\n')[0]?.trim();
    if (firstLine && existsSync(firstLine)) {
      // On Windows, npm global installs produce `claude.cmd` — a batch wrapper
      // the SDK can't execute via execFile without shell: true. Resolve to the
      // underlying cli.js which the SDK knows how to run via `node`.
      if (firstLine.endsWith('.cmd')) {
        const cliJs = join(
          dirname(firstLine),
          'node_modules',
          '@anthropic-ai',
          'claude-code',
          'cli.js',
        );
        if (existsSync(cliJs)) return cliJs;
        // .cmd exists but cli.js doesn't — skip, fall through to well-known paths
        return undefined;
      }
      return firstLine;
    }
  } catch {
    // Not found on PATH — fall through
  }
  return undefined;
}

/**
 * Check well-known install locations for the Claude binary.
 */
function resolveViaWellKnownPaths(): string | undefined {
  const os = platform();

  const candidates: string[] = [];

  if (os === 'linux') {
    candidates.push(join(homedir(), '.local', 'bin', 'claude'));
  } else if (os === 'darwin') {
    candidates.push('/usr/local/bin/claude');
  } else if (os === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    if (localAppData) {
      candidates.push(join(localAppData, 'Programs', 'claude', 'claude.exe'));
    }
    // npm global install: %APPDATA%\npm\node_modules\@anthropic-ai\claude-code\cli.js
    const appData = process.env.APPDATA;
    if (appData) {
      candidates.push(
        join(appData, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
      );
    }
    // bun global install: %USERPROFILE%\.bun\install\global\node_modules\...
    candidates.push(
      join(
        homedir(),
        '.bun',
        'install',
        'global',
        'node_modules',
        '@anthropic-ai',
        'claude-code',
        'cli.js',
      ),
    );
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
