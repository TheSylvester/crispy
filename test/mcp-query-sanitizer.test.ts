/**
 * Tests for FTS5 Query Sanitizer
 */

import { describe, it, expect } from 'vitest';
import { sanitizeFts5Query } from '../src/core/recall/query-sanitizer.js';

describe('sanitizeFts5Query', () => {
  it('passes through a simple word query', () => {
    expect(sanitizeFts5Query('hello')).toBe('hello');
  });

  it('passes through a prefix search', () => {
    expect(sanitizeFts5Query('hello*')).toBe('hello*');
  });

  it('preserves quoted phrases', () => {
    expect(sanitizeFts5Query('"hello world"')).toBe('"hello world"');
  });

  it('returns null for empty string', () => {
    expect(sanitizeFts5Query('')).toBeNull();
  });

  it('returns null for whitespace-only input', () => {
    expect(sanitizeFts5Query('   ')).toBeNull();
  });

  it('handles unbalanced quotes gracefully', () => {
    const result = sanitizeFts5Query('"hello world');
    expect(result).not.toBeNull();
    // With quotes stripped, falls back to quoted-AND
    expect(result).toBe('"hello" "world"');
  });

  it('preserves FTS5 AND operator', () => {
    const result = sanitizeFts5Query('hello AND world');
    expect(result).toContain('AND');
  });

  it('preserves FTS5 OR operator', () => {
    const result = sanitizeFts5Query('hello OR world');
    expect(result).toContain('OR');
  });

  it('preserves FTS5 NOT operator', () => {
    const result = sanitizeFts5Query('hello NOT world');
    expect(result).toContain('NOT');
  });

  it('strips dangerous characters', () => {
    const result = sanitizeFts5Query('hello{}[]()world');
    expect(result).not.toBeNull();
    expect(result).not.toContain('{');
    expect(result).not.toContain('}');
    expect(result).not.toContain('[');
    expect(result).not.toContain(']');
  });

  it('falls back to quoted-OR for multiple words without operators', () => {
    const result = sanitizeFts5Query('rosie bot sessions');
    expect(result).toBe('"rosie" OR "bot" OR "sessions"');
  });

  it('handles single word with special chars', () => {
    const result = sanitizeFts5Query('hello^world');
    expect(result).not.toBeNull();
    expect(result).not.toContain('^');
  });
});
