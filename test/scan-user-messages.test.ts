/**
 * Tests for scanUserMessages (Claude) and scanCodexUserMessages (Codex)
 *
 * Tests cover:
 * - Correct number of user prompts extracted
 * - Byte offset accuracy (seek to offset, confirm line is correct)
 * - Preview text truncation to 120 chars
 * - Warmup message filtering (Claude)
 * - isMeta and toolUseResult filtering (Claude)
 * - Incremental scanning (resume from returned offset)
 * - Incomplete line at EOF handling
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanUserMessages } from '../src/core/adapters/claude/jsonl-reader.js';
import { scanCodexUserMessages } from '../src/core/adapters/codex/codex-jsonl-reader.js';

// ============================================================================
// Test Helpers
// ============================================================================

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function writeTestFile(filename: string, content: string): string {
  const filepath = path.join(tempDir, filename);
  fs.writeFileSync(filepath, content, 'utf-8');
  return filepath;
}

// ============================================================================
// Claude Scanner Tests
// ============================================================================

describe('scanUserMessages (Claude)', () => {
  it('extracts user prompts from JSONL', () => {
    const content = [
      '{"type":"user","timestamp":"2024-01-01T00:00:00Z","uuid":"uuid-1","message":{"role":"user","content":"Hello world"}}',
      '{"type":"assistant","timestamp":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"Hi there"}}',
      '{"type":"user","timestamp":"2024-01-01T00:00:02Z","uuid":"uuid-2","message":{"role":"user","content":"How are you?"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].preview).toBe('Hello world');
    expect(result.prompts[0].uuid).toBe('uuid-1');
    expect(result.prompts[1].preview).toBe('How are you?');
    expect(result.prompts[1].uuid).toBe('uuid-2');
  });

  it('filters out Warmup messages', () => {
    const content = [
      '{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":"Warmup"}}',
      '{"type":"user","timestamp":"2024-01-01T00:00:01Z","uuid":"uuid-1","message":{"role":"user","content":"Real prompt"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toBe('Real prompt');
  });

  it('filters out isMeta entries', () => {
    const content = [
      '{"type":"user","timestamp":"2024-01-01T00:00:00Z","isMeta":true,"message":{"role":"user","content":"Meta entry"}}',
      '{"type":"user","timestamp":"2024-01-01T00:00:01Z","message":{"role":"user","content":"Real prompt"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toBe('Real prompt');
  });

  it('filters out toolUseResult entries', () => {
    const content = [
      '{"type":"user","timestamp":"2024-01-01T00:00:00Z","toolUseResult":{"agentId":"agent-1"},"message":{"role":"user","content":"Tool result"}}',
      '{"type":"user","timestamp":"2024-01-01T00:00:01Z","message":{"role":"user","content":"Real prompt"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toBe('Real prompt');
  });

  it('stores full preview without truncation', () => {
    const longText = 'A'.repeat(200);
    const content = `{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":"${longText}"}}`;

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toHaveLength(200);
    expect(result.prompts[0].preview).toBe('A'.repeat(200));
  });

  it('returns accurate byte offsets', () => {
    const line1 = '{"type":"user","timestamp":"2024-01-01T00:00:00Z","uuid":"uuid-1","message":{"role":"user","content":"First"}}';
    const line2 = '{"type":"assistant","timestamp":"2024-01-01T00:00:01Z","message":{"role":"assistant","content":"Response"}}';
    const line3 = '{"type":"user","timestamp":"2024-01-01T00:00:02Z","uuid":"uuid-2","message":{"role":"user","content":"Second"}}';
    const content = [line1, line2, line3].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(2);

    // Verify first prompt offset
    expect(result.prompts[0].offset).toBe(0);

    // Verify second prompt offset points to the correct line
    const secondOffset = result.prompts[1].offset;
    const fileContent = fs.readFileSync(filepath, 'utf-8');
    const lineAtOffset = fileContent.slice(secondOffset).split('\n')[0];
    expect(lineAtOffset).toContain('"uuid":"uuid-2"');
    expect(lineAtOffset).toContain('Second');
  });

  it('supports incremental scanning from offset', () => {
    const line1 = '{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":"First"}}';
    const line2 = '{"type":"assistant","message":{"role":"assistant","content":"Response"}}';
    const content = [line1, line2].join('\n') + '\n';

    const filepath = writeTestFile('session.jsonl', content);

    // First scan
    const result1 = scanUserMessages(filepath, 0);
    expect(result1.prompts).toHaveLength(1);
    expect(result1.prompts[0].preview).toBe('First');

    // Append more content
    const line3 = '{"type":"user","timestamp":"2024-01-01T00:00:02Z","message":{"role":"user","content":"Second"}}';
    fs.appendFileSync(filepath, line3 + '\n');

    // Incremental scan from previous offset
    const result2 = scanUserMessages(filepath, result1.offset);
    expect(result2.prompts).toHaveLength(1);
    expect(result2.prompts[0].preview).toBe('Second');
  });

  it('handles empty file', () => {
    const filepath = writeTestFile('empty.jsonl', '');
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(0);
    expect(result.offset).toBe(0);
  });

  it('handles file with only non-user entries', () => {
    const content = [
      '{"type":"assistant","message":{"role":"assistant","content":"Response"}}',
      '{"type":"system","message":{"role":"system","content":"Init"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(0);
  });

  it('handles malformed JSON lines gracefully', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":"Valid"}}',
      '{"this is invalid json',
      '{"type":"user","message":{"role":"user","content":"Also valid"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].preview).toBe('Valid');
    expect(result.prompts[1].preview).toBe('Also valid');
  });

  it('handles content array format', () => {
    const content = '{"type":"user","timestamp":"2024-01-01T00:00:00Z","message":{"role":"user","content":[{"type":"text","text":"Array format"}]}}';

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toBe('Array format');
  });

  it('skips entries with empty content', () => {
    const content = [
      '{"type":"user","message":{"role":"user","content":""}}',
      '{"type":"user","message":{"role":"user","content":[]}}',
      '{"type":"user","message":{"role":"user","content":"Valid"}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toBe('Valid');
  });

  it('returns original offset on file read error', () => {
    const result = scanUserMessages('/nonexistent/path.jsonl', 100);

    expect(result.prompts).toHaveLength(0);
    expect(result.offset).toBe(100);
  });

  it('does not advance offset past incomplete line at EOF', () => {
    // Write file without trailing newline
    const content = '{"type":"user","message":{"role":"user","content":"Complete"}}\n{"type":"user","message":';
    const filepath = writeTestFile('incomplete.jsonl', content);

    const result = scanUserMessages(filepath, 0);

    // Should have parsed the complete line
    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toBe('Complete');

    // Offset should not advance past the incomplete line
    // The complete line + newline should be parsed, but incomplete line should be retained
    const completeLineBytes = Buffer.byteLength('{"type":"user","message":{"role":"user","content":"Complete"}}\n', 'utf-8');
    expect(result.offset).toBe(completeLineBytes);
  });
});

// ============================================================================
// Codex Scanner Tests
// ============================================================================

describe('scanCodexUserMessages (Codex)', () => {
  it('extracts user prompts from JSONL', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"id":"id-1","role":"user","content":[{"type":"input_text","text":"Hello world"}]}}',
      '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Hi there"}]}}',
      '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"id":"id-2","role":"user","content":[{"type":"input_text","text":"How are you?"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanCodexUserMessages(filepath);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].preview).toBe('Hello world');
    expect(result.prompts[0].uuid).toBe('id-1');
    expect(result.prompts[1].preview).toBe('How are you?');
    expect(result.prompts[1].uuid).toBe('id-2');
  });

  it('skips session_meta and other envelope types', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"session_meta","payload":{"id":"session-1","cwd":"/home/user"}}',
      '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Real prompt"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanCodexUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toBe('Real prompt');
  });

  it('skips developer role messages', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"developer","content":[{"type":"input_text","text":"System prompt"}]}}',
      '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"User prompt"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanCodexUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toBe('User prompt');
  });

  it('stores full preview without truncation', () => {
    const longText = 'B'.repeat(200);
    const content = `{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"${longText}"}]}}`;

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanCodexUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].preview).toHaveLength(200);
    expect(result.prompts[0].preview).toBe('B'.repeat(200));
  });

  it('returns accurate byte offsets', () => {
    const line1 = '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"id":"id-1","role":"user","content":[{"type":"input_text","text":"First"}]}}';
    const line2 = '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Response"}]}}';
    const line3 = '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"id":"id-2","role":"user","content":[{"type":"input_text","text":"Second"}]}}';
    const content = [line1, line2, line3].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanCodexUserMessages(filepath);

    expect(result.prompts).toHaveLength(2);

    // Verify first prompt offset
    expect(result.prompts[0].offset).toBe(0);

    // Verify second prompt offset points to the correct line
    const secondOffset = result.prompts[1].offset;
    const fileContent = fs.readFileSync(filepath, 'utf-8');
    const lineAtOffset = fileContent.slice(secondOffset).split('\n')[0];
    expect(lineAtOffset).toContain('"id":"id-2"');
    expect(lineAtOffset).toContain('Second');
  });

  it('supports incremental scanning from offset', () => {
    const line1 = '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"First"}]}}';
    const line2 = '{"timestamp":"2024-01-01T00:00:01Z","type":"response_item","payload":{"role":"assistant","content":[{"type":"output_text","text":"Response"}]}}';
    const content = [line1, line2].join('\n') + '\n';

    const filepath = writeTestFile('session.jsonl', content);

    // First scan
    const result1 = scanCodexUserMessages(filepath, 0);
    expect(result1.prompts).toHaveLength(1);
    expect(result1.prompts[0].preview).toBe('First');

    // Append more content
    const line3 = '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Second"}]}}';
    fs.appendFileSync(filepath, line3 + '\n');

    // Incremental scan from previous offset
    const result2 = scanCodexUserMessages(filepath, result1.offset);
    expect(result2.prompts).toHaveLength(1);
    expect(result2.prompts[0].preview).toBe('Second');
  });

  it('handles empty file', () => {
    const filepath = writeTestFile('empty.jsonl', '');
    const result = scanCodexUserMessages(filepath);

    expect(result.prompts).toHaveLength(0);
    expect(result.offset).toBe(0);
  });

  it('handles malformed JSON lines gracefully', () => {
    const content = [
      '{"timestamp":"2024-01-01T00:00:00Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Valid"}]}}',
      '{"this is invalid json',
      '{"timestamp":"2024-01-01T00:00:02Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Also valid"}]}}',
    ].join('\n');

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanCodexUserMessages(filepath);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0].preview).toBe('Valid');
    expect(result.prompts[1].preview).toBe('Also valid');
  });

  it('returns original offset on file read error', () => {
    const result = scanCodexUserMessages('/nonexistent/path.jsonl', 100);

    expect(result.prompts).toHaveLength(0);
    expect(result.offset).toBe(100);
  });

  it('preserves timestamp from envelope level', () => {
    const content = '{"timestamp":"2024-01-15T10:30:45Z","type":"response_item","payload":{"role":"user","content":[{"type":"input_text","text":"Test"}]}}';

    const filepath = writeTestFile('session.jsonl', content);
    const result = scanCodexUserMessages(filepath);

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].timestamp).toBe('2024-01-15T10:30:45Z');
  });
});
