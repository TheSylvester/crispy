/**
 * ANSI Escape Code Utilities
 *
 * Provides stripping and React-based rendering of ANSI SGR (Select Graphic
 * Rendition) escape sequences commonly found in terminal output.
 *
 * Supports:
 * - Strip: removes all ANSI escape sequences from text
 * - Render: converts SGR color/style codes to styled React spans
 *
 * Covers the standard 16-color palette (codes 30-37, 40-47, 90-97, 100-107),
 * bold, dim, italic, underline, and strikethrough. Does NOT handle 256-color
 * or truecolor (24-bit) sequences — those are stripped silently.
 *
 * @module webview/renderers/tools/shared/ansi
 */

import { createElement } from 'react';
import type { ReactNode } from 'react';

// ============================================================================
// ANSI Regex
// ============================================================================

/**
 * Matches all ANSI escape sequences (CSI and OSC).
 * Covers SGR (colors/styles), cursor movement, and other terminal codes.
 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;

// ============================================================================
// Strip
// ============================================================================

/** Remove all ANSI escape sequences from text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, '');
}

// ============================================================================
// Render — ANSI SGR to React spans
// ============================================================================

/** Standard 16 ANSI colors (normal + bright). */
const COLORS: Record<number, string> = {
  30: '#1e1e1e', 31: '#cd3131', 32: '#0dbc79', 33: '#e5e510',
  34: '#2472c8', 35: '#bc3fbc', 36: '#11a8cd', 37: '#e5e5e5',
  90: '#666666', 91: '#f14c4c', 92: '#23d18b', 93: '#f5f543',
  94: '#3b8eea', 95: '#d670d6', 96: '#29b8db', 97: '#e5e5e5',
};

const BG_COLORS: Record<number, string> = {
  40: '#1e1e1e', 41: '#cd3131', 42: '#0dbc79', 43: '#e5e510',
  44: '#2472c8', 45: '#bc3fbc', 46: '#11a8cd', 47: '#e5e5e5',
  100: '#666666', 101: '#f14c4c', 102: '#23d18b', 103: '#f5f543',
  104: '#3b8eea', 105: '#d670d6', 106: '#29b8db', 107: '#e5e5e5',
};

interface SgrState {
  color?: string;
  bgColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
}

/** Apply a single SGR parameter code to the current style state. */
function applySgrCode(code: number, state: SgrState): void {
  if (code === 0) {
    // Reset all
    state.color = undefined;
    state.bgColor = undefined;
    state.bold = undefined;
    state.dim = undefined;
    state.italic = undefined;
    state.underline = undefined;
    state.strikethrough = undefined;
  } else if (code === 1) {
    state.bold = true;
  } else if (code === 2) {
    state.dim = true;
  } else if (code === 3) {
    state.italic = true;
  } else if (code === 4) {
    state.underline = true;
  } else if (code === 9) {
    state.strikethrough = true;
  } else if (code === 22) {
    state.bold = undefined;
    state.dim = undefined;
  } else if (code === 23) {
    state.italic = undefined;
  } else if (code === 24) {
    state.underline = undefined;
  } else if (code === 29) {
    state.strikethrough = undefined;
  } else if (code === 39) {
    state.color = undefined;
  } else if (code === 49) {
    state.bgColor = undefined;
  } else if (COLORS[code]) {
    state.color = COLORS[code];
  } else if (BG_COLORS[code]) {
    state.bgColor = BG_COLORS[code];
  }
  // 256-color (38;5;n) and truecolor (38;2;r;g;b) are silently ignored —
  // the semi-colon-separated params are split by the caller, so codes like
  // 38, 48, 5, 2 are individually no-ops here.
}

/** Build a CSS style object from the current SGR state. */
function sgrToStyle(state: SgrState): React.CSSProperties | undefined {
  const style: React.CSSProperties = {};
  let hasStyle = false;

  if (state.color) { style.color = state.color; hasStyle = true; }
  if (state.bgColor) { style.backgroundColor = state.bgColor; hasStyle = true; }
  if (state.bold) { style.fontWeight = 'bold'; hasStyle = true; }
  if (state.dim) { style.opacity = 0.6; hasStyle = true; }
  if (state.italic) { style.fontStyle = 'italic'; hasStyle = true; }
  if (state.underline) { style.textDecoration = 'underline'; hasStyle = true; }
  if (state.strikethrough) {
    style.textDecoration = state.underline ? 'underline line-through' : 'line-through';
    hasStyle = true;
  }

  return hasStyle ? style : undefined;
}

/**
 * Convert text with ANSI SGR codes into an array of React elements.
 *
 * Each styled run becomes a `<span>` with inline styles. Unstyled runs
 * remain as plain strings. Returns the array directly (caller wraps in
 * a container element).
 */
export function renderAnsi(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const state: SgrState = {};
  let lastIndex = 0;
  let key = 0;

  // eslint-disable-next-line no-control-regex
  const sgrRe = /\x1b\[([0-9;]*)([A-Za-z])/g;
  let match: RegExpExecArray | null;

  while ((match = sgrRe.exec(text)) !== null) {
    // Flush text before this escape
    if (match.index > lastIndex) {
      const chunk = text.slice(lastIndex, match.index);
      const style = sgrToStyle(state);
      if (style) {
        parts.push(createElement('span', { key: key++, style }, chunk));
      } else {
        parts.push(chunk);
      }
    }

    lastIndex = match.index + match[0].length;

    // Only process SGR sequences (ending with 'm')
    if (match[2] !== 'm') continue;

    // Parse semicolon-separated params
    const params = match[1] ? match[1].split(';').map(Number) : [0];
    for (const code of params) {
      applySgrCode(code, state);
    }
  }

  // Flush remaining text
  if (lastIndex < text.length) {
    const chunk = text.slice(lastIndex);
    const style = sgrToStyle(state);
    if (style) {
      parts.push(createElement('span', { key: key++, style }, chunk));
    } else {
      parts.push(chunk);
    }
  }

  return parts;
}

/**
 * Check if text contains ANSI SGR (styling) sequences.
 *
 * Only detects sequences ending with 'm' (colors, bold, etc.) — not cursor
 * movement, erase, or other terminal control codes. This avoids false
 * positives that would route plain text through renderAnsi() unnecessarily.
 */
export function hasAnsi(text: string): boolean {
  return /\x1b\[[0-9;]*m/.test(text);
}
