/**
 * Tests for text renderer registration and shared markdown helpers
 *
 * Pure value-level tests — no jsdom, no React rendering.
 * Verifies the rendererMap has the correct entries and that
 * extractLanguage correctly parses react-markdown classNames.
 */

import { describe, it, expect } from 'vitest';
import { rendererMap } from '../src/webview/renderers/BlockRenderer.js';
import { UserTextRenderer } from '../src/webview/renderers/UserTextRenderer.js';
import { AssistantTextRenderer } from '../src/webview/renderers/AssistantTextRenderer.js';
import { extractLanguage } from '../src/webview/renderers/markdown-components.js';

// ── rendererMap registration ──────────────────────────────────────────

describe('rendererMap', () => {
  it('maps "user:text" to UserTextRenderer', () => {
    expect(rendererMap.get('user:text')).toBe(UserTextRenderer);
  });

  it('maps "assistant:text" to AssistantTextRenderer', () => {
    expect(rendererMap.get('assistant:text')).toBe(AssistantTextRenderer);
  });

  it('does not have a role-agnostic "text" fallback', () => {
    expect(rendererMap.get('text')).toBeUndefined();
  });
});

// ── extractLanguage ───────────────────────────────────────────────────

describe('extractLanguage', () => {
  it('extracts language from "language-typescript"', () => {
    expect(extractLanguage('language-typescript')).toBe('typescript');
  });

  it('returns null for undefined', () => {
    expect(extractLanguage(undefined)).toBeNull();
  });

  it('returns null for a class without language- prefix', () => {
    expect(extractLanguage('some-class')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractLanguage('')).toBeNull();
  });

  it('extracts language from multi-class string', () => {
    expect(extractLanguage('some-class language-python other')).toBe('python');
  });
});
