/**
 * Tests for extractLatestAssistantModel + the upgraded getResumeModel cascade.
 *
 * These cover the v4 thinking-display fix: Crispy-tracked Claude sessions have
 * no system/init entry, so we must reverse-scan for the latest assistant
 * message.model. The window-expansion path also needs to handle large thinking
 * blocks that overflow the initial 128KB tail read.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { extractLatestAssistantModel } from '../src/core/adapters/claude/jsonl-reader.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-model-test-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function writeJsonl(filename: string, lines: object[]): string {
  const filepath = path.join(tempDir, filename);
  fs.writeFileSync(filepath, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  return filepath;
}

function userEntry(uuid: string, text = 'hi'): object {
  return { type: 'user', uuid, timestamp: '2026-04-20T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text }] } };
}

function assistantEntry(uuid: string, model: string, text = 'ok'): object {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-04-20T00:00:01Z',
    message: { role: 'assistant', model, content: [{ type: 'text', text }] },
  };
}

describe('extractLatestAssistantModel', () => {
  it('returns the most recent assistant model in a small file', () => {
    const file = writeJsonl('session.jsonl', [
      userEntry('u1'),
      assistantEntry('a1', 'claude-opus-4-6'),
      userEntry('u2'),
      assistantEntry('a2', 'claude-opus-4-7'),
    ]);
    expect(extractLatestAssistantModel(file)).toBe('claude-opus-4-7');
  });

  it('returns undefined for an empty file', () => {
    const file = path.join(tempDir, 'empty.jsonl');
    fs.writeFileSync(file, '', 'utf-8');
    expect(extractLatestAssistantModel(file)).toBeUndefined();
  });

  it('returns undefined when there are no assistant entries', () => {
    const file = writeJsonl('users.jsonl', [userEntry('u1'), userEntry('u2')]);
    expect(extractLatestAssistantModel(file)).toBeUndefined();
  });

  it('skips a torn trailing JSON line and returns the prior assistant model', () => {
    const file = writeJsonl('torn.jsonl', [
      userEntry('u1'),
      assistantEntry('a1', 'claude-opus-4-7'),
    ]);
    // Append a half-record without a newline — simulates active stream write
    fs.appendFileSync(file, '{"type":"assistant","message":{"model":"clau');
    expect(extractLatestAssistantModel(file)).toBe('claude-opus-4-7');
  });

  it('expands the window to find an assistant model behind a large thinking block', () => {
    // Synth assistant whose serialized line exceeds 128KB tail window
    const bigThinking = 'x'.repeat(200 * 1024);
    const heavyAssistant = {
      type: 'assistant',
      uuid: 'a-heavy',
      timestamp: '2026-04-20T00:00:01Z',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-7',
        content: [
          { type: 'thinking', thinking: bigThinking },
          { type: 'text', text: 'done' },
        ],
      },
    };
    const file = writeJsonl('big.jsonl', [userEntry('u1'), heavyAssistant]);
    expect(extractLatestAssistantModel(file)).toBe('claude-opus-4-7');
  });

  describe('upToUuid cutoff', () => {
    it('returns the assistant model at or before an assistant cutoff', () => {
      const file = writeJsonl('cutoff.jsonl', [
        userEntry('u1'),
        assistantEntry('a1', 'claude-opus-4-6'),
        userEntry('u2'),
        assistantEntry('a2', 'claude-opus-4-7'),
        userEntry('u3'),
        assistantEntry('a3', 'claude-haiku-4-5'),
      ]);
      // Cutoff at a2 → must return a2's model, not a3
      expect(extractLatestAssistantModel(file, { upToUuid: 'a2' })).toBe('claude-opus-4-7');
    });

    it('returns the assistant model preceding a user-message cutoff', () => {
      // Fork at a user-message boundary: cutoff is the user entry between
      // two assistants — must return the assistant before the user entry.
      const file = writeJsonl('user-cutoff.jsonl', [
        userEntry('u1'),
        assistantEntry('a1', 'claude-opus-4-6'),
        userEntry('u2'),
        assistantEntry('a2', 'claude-opus-4-7'),
      ]);
      expect(extractLatestAssistantModel(file, { upToUuid: 'u2' })).toBe('claude-opus-4-6');
    });

    it('returns undefined when the cutoff UUID is never found (fail closed)', () => {
      const file = writeJsonl('missing.jsonl', [
        userEntry('u1'),
        assistantEntry('a1', 'claude-opus-4-6'),
        assistantEntry('a2', 'claude-opus-4-7'),
      ]);
      expect(extractLatestAssistantModel(file, { upToUuid: 'never-existed' })).toBeUndefined();
    });
  });
});
