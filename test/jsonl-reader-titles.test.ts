/**
 * Tests for ai-title / custom-title extraction in jsonl-reader.
 *
 * ai-title is written early in the JSONL (typically within the first few
 * entries, then never repeated) so extraction must scan the 64KB head. The
 * 32KB tail fallback only covers small sessions whose head and tail overlap.
 *
 * custom-title is written on user /rename, typically late in the session, so
 * tail extraction suffices.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractMetadataFast, extractTailMetadata } from '../src/core/adapters/claude/jsonl-reader.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-reader-titles-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function writeJsonl(filename: string, lines: Array<Record<string, unknown>>): string {
  const filepath = path.join(tempDir, filename);
  const content = lines.map(l => JSON.stringify(l)).join('\n') + '\n';
  fs.writeFileSync(filepath, content);
  return filepath;
}

function largeAssistantEntry(index: number, sessionId: string): Record<string, unknown> {
  // ~2KB per entry to push ai-title out of the tail window fast
  const padding = 'x'.repeat(2000);
  return {
    type: 'assistant',
    uuid: `uuid-assistant-${index}`,
    parentUuid: `uuid-parent-${index}`,
    sessionId,
    timestamp: new Date(2026, 0, 1, 0, index).toISOString(),
    cwd: '/home/user/project',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: padding }],
    },
  };
}

describe('extractMetadataFast — aiTitle head extraction', () => {
  it('extracts aiTitle from the head of a large session (tail would miss it)', () => {
    const sessionId = '11111111-1111-1111-1111-111111111111';
    const entries: Array<Record<string, unknown>> = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/user/project', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'assistant', uuid: 'u2', parentUuid: 'u1', sessionId, timestamp: '2026-01-01T00:00:01.000Z', cwd: '/home/user/project', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
      { type: 'ai-title', sessionId, aiTitle: 'Refactoring session manager', timestamp: '2026-01-01T00:00:02.000Z' },
    ];
    // Pad with ~100 large entries to push ai-title well outside the 32KB tail window
    for (let i = 3; i < 103; i++) {
      entries.push(largeAssistantEntry(i, sessionId));
    }

    const filepath = writeJsonl('large-session.jsonl', entries);
    const meta = extractMetadataFast(filepath);

    expect(meta).not.toBeNull();
    expect(meta!.aiTitle).toBe('Refactoring session manager');
  });

  it('extracts customTitle from tail when user renames late', () => {
    const sessionId = '22222222-2222-2222-2222-222222222222';
    const entries: Array<Record<string, unknown>> = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/user/project', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'assistant', uuid: 'u2', parentUuid: 'u1', sessionId, timestamp: '2026-01-01T00:00:01.000Z', cwd: '/home/user/project', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
      // custom-title at the end (user renames late)
      { type: 'custom-title', sessionId, customTitle: 'My renamed session', timestamp: '2026-01-01T00:10:00.000Z' },
    ];

    const filepath = writeJsonl('renamed.jsonl', entries);
    const meta = extractMetadataFast(filepath);

    expect(meta).not.toBeNull();
    expect(meta!.customTitle).toBe('My renamed session');
  });

  it('extracts both aiTitle and customTitle when both are present', () => {
    const sessionId = '33333333-3333-3333-3333-333333333333';
    const entries: Array<Record<string, unknown>> = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/user/project', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'ai-title', sessionId, aiTitle: 'SDK-generated title', timestamp: '2026-01-01T00:00:01.000Z' },
      { type: 'assistant', uuid: 'u2', parentUuid: 'u1', sessionId, timestamp: '2026-01-01T00:00:02.000Z', cwd: '/home/user/project', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
      { type: 'custom-title', sessionId, customTitle: 'User-renamed title', timestamp: '2026-01-01T00:10:00.000Z' },
    ];

    const filepath = writeJsonl('both-titles.jsonl', entries);
    const meta = extractMetadataFast(filepath);

    expect(meta).not.toBeNull();
    expect(meta!.aiTitle).toBe('SDK-generated title');
    expect(meta!.customTitle).toBe('User-renamed title');
  });

  it('first ai-title wins (head-scan first-hit semantics)', () => {
    const sessionId = '44444444-4444-4444-4444-444444444444';
    const entries: Array<Record<string, unknown>> = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/user/project', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'ai-title', sessionId, aiTitle: 'First title', timestamp: '2026-01-01T00:00:01.000Z' },
      { type: 'ai-title', sessionId, aiTitle: 'Second title', timestamp: '2026-01-01T00:00:02.000Z' },
    ];

    const filepath = writeJsonl('two-ai-titles.jsonl', entries);
    const meta = extractMetadataFast(filepath);

    expect(meta).not.toBeNull();
    expect(meta!.aiTitle).toBe('First title');
  });

  it('returns undefined title fields when neither ai-title nor custom-title present', () => {
    const sessionId = '55555555-5555-5555-5555-555555555555';
    const entries: Array<Record<string, unknown>> = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/user/project', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'assistant', uuid: 'u2', parentUuid: 'u1', sessionId, timestamp: '2026-01-01T00:00:01.000Z', cwd: '/home/user/project', message: { role: 'assistant', content: [{ type: 'text', text: 'Hi' }] } },
    ];

    const filepath = writeJsonl('no-titles.jsonl', entries);
    const meta = extractMetadataFast(filepath);

    expect(meta).not.toBeNull();
    expect(meta!.aiTitle).toBeUndefined();
    expect(meta!.customTitle).toBeUndefined();
  });
});

describe('extractTailMetadata — tail extraction for small sessions', () => {
  it('extracts aiTitle from tail when ai-title is within the 32KB tail window', () => {
    const sessionId = '66666666-6666-6666-6666-666666666666';
    const entries: Array<Record<string, unknown>> = [
      { type: 'user', uuid: 'u1', parentUuid: null, sessionId, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/home/user/project', message: { role: 'user', content: [{ type: 'text', text: 'Hello' }] } },
      { type: 'ai-title', sessionId, aiTitle: 'Small session title', timestamp: '2026-01-01T00:00:01.000Z' },
    ];

    const filepath = writeJsonl('small-session.jsonl', entries);
    const tail = extractTailMetadata(filepath);

    expect(tail.aiTitle).toBe('Small session title');
  });
});
