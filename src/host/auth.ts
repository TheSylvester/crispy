/**
 * Auth — Token-based authentication for the Crispy daemon
 *
 * Generates and validates a 128-bit random token stored at ~/.crispy/token.
 * Localhost connections bypass auth entirely — zero friction for local use.
 * Non-localhost connections authenticate via cookie set through token exchange.
 *
 * @module auth
 */

import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tokenPath } from '../core/paths.js';

// ============================================================================
// Token management
// ============================================================================

/** Read existing token or create a new one. */
export function getOrCreateToken(): string {
  try {
    return readFileSync(tokenPath(), 'utf8').trim();
  } catch {
    return rotateToken();
  }
}

/** Generate a new token and write it to disk. */
export function rotateToken(): string {
  const token = randomBytes(16).toString('hex');
  writeFileSync(tokenPath(), token + '\n', { mode: 0o600 });
  try { chmodSync(tokenPath(), 0o600); } catch { /* Windows no-op */ }
  return token;
}

/** Constant-time comparison of a candidate token against the stored token. */
export function validateToken(candidate: string): boolean {
  try {
    const stored = readFileSync(tokenPath(), 'utf8').trim();
    if (candidate.length !== stored.length) return false;
    let result = 0;
    for (let i = 0; i < stored.length; i++) {
      result |= candidate.charCodeAt(i) ^ stored.charCodeAt(i);
    }
    return result === 0;
  } catch { return false; }
}

// ============================================================================
// Cookie helpers
// ============================================================================

const COOKIE_PREFIX = 'crispy_token_';

/** Port-scoped cookie name to avoid collisions across instances. */
export function cookieName(port: number): string {
  return `${COOKIE_PREFIX}${port}`;
}

/** Extract a named cookie value from a Cookie header. */
export function parseCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.split(';').find(c => c.trim().startsWith(`${name}=`));
  return match ? match.split('=')[1]?.trim() ?? null : null;
}

/** Build a Set-Cookie header value for token auth. */
export function setTokenCookie(port: number, token: string): string {
  const name = cookieName(port);
  return `${name}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${30 * 24 * 60 * 60}`;
}

// ============================================================================
// Connection detection
// ============================================================================

/** True when the request originates from a loopback address. */
export function isLocalConnection(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress;
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}
