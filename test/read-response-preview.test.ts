/**
 * Tests for readResponsePreview (Claude) and readCodexResponsePreview (Codex)
 *
 * Tests cover:
 * - Returns last assistant text before next user message
 * - Returns null when no assistant response exists
 * - Stops at the next user message (doesn't bleed into next turn)
 * - Truncates to ~200 chars
 * - Handles tool_use/tool_result pattern (returns text after them)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { readResponsePreview } from '../src/core/adapters/claude/jsonl-reader.js';
import { readCodexResponsePreview } from '../src/core/adapters/codex/codex-jsonl-reader.js';

// ============================================================================
// Test Helpers
// ============================================================================

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeTestFile(filename: string, content: string): string {
  const filepath = path.join(tempDir, filename);
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

// ============================================================================
// Claude Response Preview Tests
// ============================================================================

describe('readResponsePreview (Claude)', () => {
  it('returns assistant response text after user prompt', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"Hello"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Hi there, how can I help?"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readResponsePreview(filepath, 0);

    expect(result).toBe('Hi there, how can I help?');
  });

  it('returns the LAST assistant text before next user message', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"First prompt"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"First response"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Second response with more text"}}',
      '{"type":"user","message":{"role":"user","content":"Second prompt"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readResponsePreview(filepath, 0);

    // Should return the last assistant message before the next user message
    expect(result).toBe('Second response with more text');
  });

  it('returns null when no assistant response exists', () => {
    const content = '{"type":"user","message":{"role":"user","content":"User prompt at EOF"}}';

    const filepath = writeTestFile('session.jsonl', content);
    const result = readResponsePreview(filepath, 0);

    expect(result).toBeNull();
  });

  it('stops at the next user message', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"First prompt"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Response to first"}}',
      '{"type":"user","message":{"role":"user","content":"Second prompt"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Response to second - should NOT be included"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readResponsePreview(filepath, 0);

    expect(result).toBe('Response to first');
    expect(result).not.toContain('second');
  });

  it('truncates response to 200 chars', () => {
    const longResponse = 'X'.repeat(300);
    const content = [
      '{"type":"user","message":{"role":"user","content":"Hello"}}',
      `{"type":"assistant","message":{"role":"assistant","content":"${longResponse}"}}`,
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readResponsePreview(filepath, 0);

    expect(result).toHaveLength(200);
    expect(result).toBe('X'.repeat(200));
  });

  it('handles tool_use -> tool_result -> assistant pattern', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"Run ls command"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Bash","id":"tool-1","input":{"command":"ls"}}]}}',
      '{"type":"user","toolUseResult":{"content":"file1.txt\\nfile2.txt"},"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"tool-1","content":"file1.txt\\nfile2.txt"}]}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Here are the files: file1.txt and file2.txt"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readResponsePreview(filepath, 0);

    // Should get the final assistant response with text
    expect(result).toBe('Here are the files: file1.txt and file2.txt');
  });

  it('ignores isMeta user entries as stop condition', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"Real prompt"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"Response text"}}',
      '{"type":"user","isMeta":true,"message":{"role":"user","content":"Meta entry - should not stop"}}',
      '{"type":"assistant","message":{"role":"assistant","content":"More response"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readResponsePreview(filepath, 0);

    // Should continue past isMeta entry and get the last assistant message
    expect(result).toBe('More response');
  });

  it('handles content array format', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"Hello"}}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Array format response"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readResponsePreview(filepath, 0);

    expect(result).toBe('Array format response');
  });

  it('returns null for offset beyond file size', () => {
    const content = '{"type":"user","message":{"role":"user","content":"Hello"}}';
    const filepath = writeTestFile('session.jsonl', content);

    const result = readResponsePreview(filepath, 10000);

    expect(result).toBeNull();
  });

  it('returns null for nonexistent file', () => {
    const result = readResponsePreview('/nonexistent/path.jsonl', 0);
    expect(result).toBeNull();
  });

  it('works with offset pointing to user prompt mid-file', () => {
    const line1 = '{"type":"user","message":{"role":"user","content":"First"}}';
    const line2 = '{"type":"assistant","message":{"role":"assistant","content":"First response"}}';
    const line3 = '{"type":"user","message":{"role":"user","content":"Second"}}';
    const line4 = '{"type":"assistant","message":{"role":"assistant","content":"Second response"}}';
    const content = [line1, line2, line3, line4].join('\n');

    const filepath = writeTestFile('session.jsonl', content);

    // Calculate offset of line3 (the second user prompt)
    const line3Offset = Buffer.byteLength(line1 + '\n' + line2 + '\n', 'utf-8');

    const result = readResponsePreview(filepath, line3Offset);

    expect(result).toBe('Second response');
  });
});

// ============================================================================
// Codex Response Preview Tests
// ============================================================================

describe('readCodexResponsePreview (Codex)', () => {
  it('returns assistant response text after user prompt', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Hello"}]}}',
      '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Hi there, how can I help?"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readCodexResponsePreview(filepath, 0);

    expect(result).toBe('Hi there, how can I help?');
  });

  it('returns the LAST assistant text before next user message', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"First"}]}}',
      '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"First response"}]}}',
      '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Second response"}]}}',
      '{"timestamp":"2024-01-01T00:00:03Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Second prompt"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readCodexResponsePreview(filepath, 0);

    expect(result).toBe('Second response');
  });

  it('returns null when no assistant response exists', () => {
    const content = '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"User prompt at EOF"}]}}';

    const filepath = writeTestFile('session.jsonl', content);
    const result = readCodexResponsePreview(filepath, 0);

    expect(result).toBeNull();
  });

  it('stops at the next user message', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"First"}]}}',
      '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Response to first"}]}}',
      '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Second"}]}}',
      '{"timestamp":"2024-01-01T00:00:03Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Should NOT be included"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readCodexResponsePreview(filepath, 0);

    expect(result).toBe('Response to first');
    expect(result).not.toContain('NOT');
  });

  it('truncates response to 200 chars', () => {
    const longResponse = 'Y'.repeat(300);
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Hello"}]}}',
      `{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"${longResponse}"}]}}`,
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readCodexResponsePreview(filepath, 0);

    expect(result).toHaveLength(200);
    expect(result).toBe('Y'.repeat(200));
  });

  it('ignores developer role as stop condition', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"User prompt"}]}}',
      '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"First response"}]}}',
      '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"role":"developer","content":[{"type":"input_text","text":"System instruction"}]}}',
      '{"timestamp":"2024-01-01T00:00:03Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"More response"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readCodexResponsePreview(filepath, 0);

    // Developer messages shouldn't stop the scan
    expect(result).toBe('More response');
  });

  it('returns null for offset beyond file size', () => {
    const content = '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Hello"}]}}';
    const filepath = writeTestFile('session.jsonl', content);

    const result = readCodexResponsePreview(filepath, 10000);

    expect(result).toBeNull();
  });

  it('returns null for nonexistent file', () => {
    const result = readCodexResponsePreview('/nonexistent/path.jsonl', 0);
    expect(result).toBeNull();
  });

  it('works with offset pointing to user prompt mid-file', () => {
    const line1 = '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"First"}]}}';
    const line2 = '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"First response"}]}}';
    const line3 = '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Second"}]}}';
    const line4 = '{"timestamp":"2024-01-01T00:00:03Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Second response"}]}}';
    const content = [line1, line2, line3, line4].join('\n');

    const filepath = writeTestFile('session.jsonl', content);

    // Calculate offset of line3 (the second user prompt)
    const line3Offset = Buffer.byteLength(line1 + '\n' + line2 + '\n', 'utf-8');

    const result = readCodexResponsePreview(filepath, line3Offset);

    expect(result).toBe('Second response');
  });

  it('skips non-response_item envelope types', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Hello"}]}}',
      '{"timestamp":"2024-01-01T00:00:01Z","type":"event_msg","payload":{"some":"event"}}',
      '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Response"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = readCodexResponsePreview(filepath, 0);

    expect(result).toBe('Response');
  });
});
