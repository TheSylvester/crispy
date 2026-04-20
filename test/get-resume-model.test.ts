/**
 * Tests for the upgraded getResumeModel cascade:
 *   1. extractInitModel  (pre-Crispy sessions with system/init)
 *   2. extractLatestAssistantModel  (Crispy-tracked sessions without init)
 *
 * Uses HOME override to point findSession at a temp ~/.claude/projects dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getResumeModel } from '../src/core/adapters/claude/claude-code-adapter.js';

let tempHome: string;
let projectsDir: string;
let originalHome: string | undefined;

beforeEach(() => {
  originalHome = process.env.HOME;
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crispy-home-'));
  process.env.HOME = tempHome;
  projectsDir = path.join(tempHome, '.claude', 'projects', 'test-project');
  fs.mkdirSync(projectsDir, { recursive: true });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(tempHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function writeSession(sessionId: string, lines: object[]): void {
  const file = path.join(projectsDir, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
}

function userEntry(uuid: string): object {
  return { type: 'user', uuid, timestamp: '2026-04-20T00:00:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } };
}

function assistantEntry(uuid: string, model: string): object {
  return {
    type: 'assistant',
    uuid,
    timestamp: '2026-04-20T00:00:01Z',
    message: { role: 'assistant', model, content: [{ type: 'text', text: 'ok' }] },
  };
}

describe('getResumeModel cascade', () => {
  it('returns init model for pre-Crispy session with system/init', () => {
    writeSession('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', [
      { type: 'system', subtype: 'init', model: 'claude-sonnet-4-20250514' },
      userEntry('u1'),
      assistantEntry('a1', 'claude-sonnet-4-7'),
    ]);
    expect(getResumeModel('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')).toBe('claude-sonnet-4-20250514');
  });

  it('falls back to latest assistant model for Crispy-tracked session without init', () => {
    writeSession('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', [
      userEntry('u1'),
      assistantEntry('a1', 'claude-opus-4-6'),
      userEntry('u2'),
      assistantEntry('a2', 'claude-opus-4-7'),
    ]);
    expect(getResumeModel('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb')).toBe('claude-opus-4-7');
  });

  it('returns undefined for missing session', () => {
    expect(getResumeModel('cccccccc-cccc-cccc-cccc-cccccccccccc')).toBeUndefined();
  });

  it('forwards upToUuid to the assistant-fallback path', () => {
    writeSession('dddddddd-dddd-dddd-dddd-dddddddddddd', [
      userEntry('u1'),
      assistantEntry('a1', 'claude-opus-4-6'),
      userEntry('u2'),
      assistantEntry('a2', 'claude-opus-4-7'),
    ]);
    expect(
      getResumeModel('dddddddd-dddd-dddd-dddd-dddddddddddd', { upToUuid: 'a1' }),
    ).toBe('claude-opus-4-6');
  });
});
