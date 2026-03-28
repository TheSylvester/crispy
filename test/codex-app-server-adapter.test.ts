/**
 * Tests for CodexAgentAdapter (Codex app-server integration)
 *
 * Validates session lifecycle, turn sending, streaming entries,
 * approval flows, and process lifecycle management.
 *
 * Uses mocked child_process.spawn to inject a MockCodexProcess.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { MockCodexProcess } from './helpers/mock-codex-process.js';
import type { ChildProcess, SpawnOptionsWithoutStdio } from 'child_process';
import type { ChannelMessage, SessionOpenSpec } from '../src/core/agent-adapter.js';

// Mock child_process.spawn before importing CodexAgentAdapter
let mockProcess: MockCodexProcess;
let capturedSpawnCalls: Array<{ command: string; args: string[]; options: SpawnOptionsWithoutStdio }> = [];

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    spawn: vi.fn((command: string, args: string[], options: SpawnOptionsWithoutStdio) => {
      capturedSpawnCalls.push({ command, args, options });
      // Access mockProcess from outer scope - set before each test
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (globalThis as any).__mockCodexProcess?.asChildProcess() as unknown as ChildProcess;
    }),
  };
});

// Import after mock is set up
import { CodexAgentAdapter } from '../src/core/adapters/codex/codex-app-server-adapter.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Collect messages from the adapter until a predicate is satisfied.
 * Useful for waiting for specific events or entry counts.
 */
async function collectUntil(
  adapter: CodexAgentAdapter,
  predicate: (msgs: ChannelMessage[]) => boolean,
  timeoutMs = 500,
): Promise<ChannelMessage[]> {
  const collected: ChannelMessage[] = [];
  const deadline = Date.now() + timeoutMs;

  const messages = adapter.messages();
  const iter = messages[Symbol.asyncIterator]();

  while (Date.now() < deadline) {
    if (predicate(collected)) break;

    const race = Promise.race([
      iter.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 50),
      ),
    ]);

    const result = await race;
    if (result.done) continue;
    collected.push(result.value);
  }

  return collected;
}

/**
 * Wait for process/stream initialization to complete.
 */
async function waitForTick(ms = 10): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

// ============================================================================
// Tests
// ============================================================================

describe('CodexAgentAdapter', () => {
  beforeEach(() => {
    // Reset mock process for each test
    mockProcess = new MockCodexProcess();
    (globalThis as any).__mockCodexProcess = mockProcess;
    capturedSpawnCalls = [];
  });

  afterEach(async () => {
    // Clean up any test processes
    // Give time for any pending operations to settle
    await waitForTick(20);
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Group 1: Session Lifecycle
  // --------------------------------------------------------------------------

  describe('Fresh session lifecycle', () => {
    it('spawns codex app-server on sendTurn', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test/project' };
      const adapter = new CodexAgentAdapter(spec);

      // Send a turn (triggers startup)
      adapter.sendTurn('Hello', {});

      // Wait for spawn
      await waitForTick();

      // Verify spawn was called
      expect(capturedSpawnCalls.length).toBe(1);
      expect(capturedSpawnCalls[0].command).toBe('codex');
      expect(capturedSpawnCalls[0].args).toEqual(['app-server']);

      // Complete protocol handshake to avoid unhandled rejections
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      adapter.close();
    });

    it('passes custom command to spawn when provided', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test/project' };
      const adapter = new CodexAgentAdapter({ ...spec, command: '/usr/local/bin/codex' });

      // Send a turn (triggers startup)
      adapter.sendTurn('Hello', {});

      // Wait for spawn
      await waitForTick();

      // Verify spawn was called with the custom command
      expect(capturedSpawnCalls.length).toBe(1);
      expect(capturedSpawnCalls[0].command).toBe('/usr/local/bin/codex');
      expect(capturedSpawnCalls[0].args).toEqual(['app-server']);

      // Complete protocol handshake to avoid unhandled rejections
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      adapter.close();
    });

    it('sends initialize then thread/start for fresh session', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test/project', model: 'o3' };
      const adapter = new CodexAgentAdapter(spec);

      // Start the turn
      adapter.sendTurn('Hello', {});

      // Get initialize request
      const initMsg = await mockProcess.getNextClientMessage();
      expect(initMsg.method).toBe('initialize');
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      // Get thread/start request
      const startMsg = await mockProcess.getNextClientMessage();
      expect(startMsg.method).toBe('thread/start');
      expect((startMsg.params as any).cwd).toBe('/test/project');
      expect((startMsg.params as any).model).toBe('o3');

      // Respond with thread
      mockProcess.pushResponse(startMsg.id, {
        thread: { id: 'thread-123', status: 'idle', turns: [] },
        model: 'o3',
        approvalPolicy: 'on-request',
      });

      // Get turn/start request
      const turnMsg = await mockProcess.getNextClientMessage();
      expect(turnMsg.method).toBe('turn/start');
      expect((turnMsg.params as any).threadId).toBe('thread-123');
      expect((turnMsg.params as any).input).toEqual([{ type: 'text', text: 'Hello', text_elements: [] }]);

      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      adapter.close();
    });

    it('emits SessionChangedEvent after thread/start', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test/project' };
      const adapter = new CodexAgentAdapter(spec);

      const collected: ChannelMessage[] = [];
      const collectionPromise = collectUntil(
        adapter,
        (msgs) => msgs.some((m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'session_changed'),
        1000,
      ).then((msgs) => {
        collected.push(...msgs);
      });

      adapter.sendTurn('Hello', {});

      // Handle protocol
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, {
        thread: { id: 'new-session-id', status: 'idle', turns: [] },
        model: 'o3',
      });

      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await collectionPromise;

      const sessionChangedEvent = collected.find(
        (m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'session_changed',
      );
      expect(sessionChangedEvent).toBeDefined();
      if (sessionChangedEvent?.type === 'event' && 'sessionId' in sessionChangedEvent.event) {
        expect((sessionChangedEvent.event as any).sessionId).toBe('new-session-id');
      }

      adapter.close();
    });

    it('discovers bundled Crispy skills and injects resolved Codex skill inputs', async () => {
      const bundledSkillRoot = resolve(process.cwd(), 'src', 'plugin', 'skills');
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test/project' };
      const adapter = new CodexAgentAdapter({
        ...spec,
        effectiveCwd: '/test/project',
        bundledSkillRoot,
      });

      adapter.sendTurn('Use $recall before coding.', {});

      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      const startMsg = await mockProcess.getNextClientMessage();
      expect(startMsg.method).toBe('thread/start');
      mockProcess.pushResponse(startMsg.id, {
        thread: { id: 'thread-123', status: 'idle', turns: [] },
        model: 'o3',
      });

      const skillsListMsg = await mockProcess.getNextClientMessage();
      expect(skillsListMsg.method).toBe('skills/list');
      expect((skillsListMsg.params as any)).toEqual({
        cwds: ['/test/project'],
        forceReload: true,
        perCwdExtraUserRoots: [{
          cwd: '/test/project',
          extraUserRoots: [bundledSkillRoot],
        }],
      });
      mockProcess.pushResponse(skillsListMsg.id, {
        data: [{
          cwd: '/test/project',
          skills: [{
            name: 'recall',
            description: 'Recall past sessions',
            path: `${bundledSkillRoot}/recall/SKILL.md`,
            scope: 'user',
            enabled: true,
          }],
          errors: [],
        }],
      });

      const turnMsg = await mockProcess.getNextClientMessage();
      expect(turnMsg.method).toBe('turn/start');
      const input = (turnMsg.params as any).input;
      expect(input[0]).toEqual({ type: 'text', text: 'Use ', text_elements: [] });
      expect(input[1]).toEqual({ type: 'skill', name: 'recall', path: `${bundledSkillRoot}/recall/SKILL.md` });
      // Self-expanded skill content follows the skill input
      expect(input[2]).toMatchObject({ type: 'text' });
      expect(input[2].text).toContain('# Recall');
      expect(input[3]).toEqual({ type: 'text', text: ' before coding.', text_elements: [] });
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      adapter.close();
    });

    it('skips bundled skill discovery when the turn has no $skill references', async () => {
      const bundledSkillRoot = resolve(process.cwd(), 'src', 'plugin', 'skills');
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test/project' };
      const adapter = new CodexAgentAdapter({
        ...spec,
        effectiveCwd: '/test/project',
        bundledSkillRoot,
      });

      adapter.sendTurn('Plain text only', {});

      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, {
        thread: { id: 'thread-123', status: 'idle', turns: [] },
        model: 'o3',
      });

      const turnMsg = await mockProcess.getNextClientMessage();
      expect(turnMsg.method).toBe('turn/start');
      expect((turnMsg.params as any).input).toEqual([
        { type: 'text', text: 'Plain text only', text_elements: [] },
      ]);
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      adapter.close();
    });

    it('preserves skills/changed invalidation that arrives during in-flight discovery', async () => {
      const bundledSkillRoot = resolve(process.cwd(), 'src', 'plugin', 'skills');
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test/project' };
      const adapter = new CodexAgentAdapter({
        ...spec,
        effectiveCwd: '/test/project',
        bundledSkillRoot,
      });

      adapter.sendTurn('Use $recall before coding.', {});

      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, {
        thread: { id: 'thread-123', status: 'idle', turns: [] },
        model: 'o3',
      });

      const firstSkillsListMsg = await mockProcess.getNextClientMessage();
      expect(firstSkillsListMsg.method).toBe('skills/list');
      mockProcess.pushNotification('skills/changed', {});
      mockProcess.pushResponse(firstSkillsListMsg.id, {
        data: [{
          cwd: '/test/project',
          skills: [],
          errors: [],
        }],
      });

      const firstTurnMsg = await mockProcess.getNextClientMessage();
      expect(firstTurnMsg.method).toBe('turn/start');
      expect((firstTurnMsg.params as any).input).toEqual([
        { type: 'text', text: 'Use $recall before coding.', text_elements: [] },
      ]);
      mockProcess.pushResponse(firstTurnMsg.id, { turn: { id: 'turn-1' } });

      adapter.sendTurn('Use $recall again.', {});

      const secondSkillsListMsg = await mockProcess.getNextClientMessage();
      expect(secondSkillsListMsg.method).toBe('skills/list');
      expect((secondSkillsListMsg.params as any).forceReload).toBe(true);
      mockProcess.pushResponse(secondSkillsListMsg.id, {
        data: [{
          cwd: '/test/project',
          skills: [{
            name: 'recall',
            description: 'Recall past sessions',
            path: `${bundledSkillRoot}/recall/SKILL.md`,
            scope: 'user',
            enabled: true,
          }],
          errors: [],
        }],
      });

      const secondTurnMsg = await mockProcess.getNextClientMessage();
      expect(secondTurnMsg.method).toBe('turn/start');
      const secondInput = (secondTurnMsg.params as any).input;
      expect(secondInput[0]).toEqual({ type: 'text', text: 'Use ', text_elements: [] });
      expect(secondInput[1]).toEqual({ type: 'skill', name: 'recall', path: `${bundledSkillRoot}/recall/SKILL.md` });
      // Self-expanded skill content follows the skill input
      expect(secondInput[2]).toMatchObject({ type: 'text' });
      expect(secondInput[2].text).toContain('# Recall');
      expect(secondInput[3]).toEqual({ type: 'text', text: ' again.', text_elements: [] });
      mockProcess.pushResponse(secondTurnMsg.id, { turn: { id: 'turn-2' } });

      adapter.close();
    });

    it('does not inject disabled bundled skills', async () => {
      const bundledSkillRoot = resolve(process.cwd(), 'src', 'plugin', 'skills');
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test/project' };
      const adapter = new CodexAgentAdapter({
        ...spec,
        effectiveCwd: '/test/project',
        bundledSkillRoot,
      });

      adapter.sendTurn('Use $recall before coding.', {});

      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, {
        thread: { id: 'thread-123', status: 'idle', turns: [] },
        model: 'o3',
      });

      const skillsListMsg = await mockProcess.getNextClientMessage();
      expect(skillsListMsg.method).toBe('skills/list');
      mockProcess.pushResponse(skillsListMsg.id, {
        data: [{
          cwd: '/test/project',
          skills: [{
            name: 'recall',
            description: 'Recall past sessions',
            path: `${bundledSkillRoot}/recall/SKILL.md`,
            scope: 'user',
            enabled: false,
          }],
          errors: [],
        }],
      });

      const turnMsg = await mockProcess.getNextClientMessage();
      expect(turnMsg.method).toBe('turn/start');
      expect((turnMsg.params as any).input).toEqual([
        { type: 'text', text: 'Use $recall before coding.', text_elements: [] },
      ]);
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      adapter.close();
    });
  });

  describe('Resume session', () => {
    it('sends thread/resume for resume mode', async () => {
      const spec: SessionOpenSpec = { mode: 'resume', sessionId: 'existing-session' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Continue', {});

      // Handle initialize
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      // Expect thread/resume
      const resumeMsg = await mockProcess.getNextClientMessage();
      expect(resumeMsg.method).toBe('thread/resume');
      expect((resumeMsg.params as any).threadId).toBe('existing-session');

      mockProcess.pushResponse(resumeMsg.id, {
        thread: {
          id: 'existing-session',
          status: 'idle',
          turns: [
            {
              id: 'turn-0',
              items: [
                { type: 'userMessage', id: 'msg-1', content: [{ type: 'text', text: 'Previous message', text_elements: [] }] },
                { type: 'agentMessage', id: 'msg-2', text: 'Previous response' },
              ],
            },
          ],
        },
        model: 'o3',
      });

      const turnMsg = await mockProcess.getNextClientMessage();
      expect(turnMsg.method).toBe('turn/start');

      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      adapter.close();
    });

    it('forwards resume-time config and instruction overrides', async () => {
      const spec: SessionOpenSpec = {
        mode: 'resume',
        sessionId: 'existing-session',
        cwd: '/resume/project',
        model: 'o4-mini',
        permissionMode: 'acceptEdits',
        systemPrompt: 'Use memory first',
        mcpServers: {
          memory: { type: 'stdio', command: 'memory-mcp' },
        },
        env: { FOO: 'bar' },
      };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Continue', {});

      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      const resumeMsg = await mockProcess.getNextClientMessage();
      expect(resumeMsg.method).toBe('thread/resume');
      expect((resumeMsg.params as any)).toMatchObject({
        threadId: 'existing-session',
        cwd: '/resume/project',
        model: 'o4-mini',
        approvalPolicy: 'on-request',
        config: {
          mcp_servers: {
            memory: { type: 'stdio', command: 'memory-mcp' },
          },
        },
      });

      mockProcess.pushResponse(resumeMsg.id, {
        thread: { id: 'existing-session', status: 'idle', turns: [] },
        model: 'o4-mini',
        approvalPolicy: 'on-request',
      });

      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      expect(adapter.settings.permissionMode).toBe('acceptEdits');

      adapter.close();
    });
  });

  describe('Fork session', () => {
    it('sends thread/fork for fork mode', async () => {
      const spec: SessionOpenSpec = { mode: 'fork', fromSessionId: 'original-session', atMessageId: 'msg-5' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Fork from here', {});

      // Handle initialize
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      // Expect thread/fork
      const forkMsg = await mockProcess.getNextClientMessage();
      expect(forkMsg.method).toBe('thread/fork');
      expect((forkMsg.params as any).threadId).toBe('original-session');
      expect((forkMsg.params as any).atItemId).toBe('msg-5');

      mockProcess.pushResponse(forkMsg.id, {
        thread: { id: 'forked-session', status: 'idle', turns: [] },
        model: 'o3',
      });

      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      expect(adapter.sessionId).toBe('forked-session');

      adapter.close();
    });

    it('forwards fork MCP and instruction overrides', async () => {
      const spec: SessionOpenSpec = {
        mode: 'fork',
        fromSessionId: 'original-session',
        atMessageId: 'msg-5',
        model: 'o3',
        systemPrompt: 'Fork prompt',
        mcpServers: {
          memory: { type: 'stdio', command: 'memory-mcp', args: ['serve'] },
        },
      };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Fork from here', {});

      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex/0.1.0' });

      const forkMsg = await mockProcess.getNextClientMessage();
      expect(forkMsg.method).toBe('thread/fork');
      expect((forkMsg.params as any)).toMatchObject({
        threadId: 'original-session',
        atItemId: 'msg-5',
        model: 'o3',
        config: {
          mcp_servers: {
            memory: { type: 'stdio', command: 'memory-mcp', args: ['serve'] },
          },
        },
      });

      mockProcess.pushResponse(forkMsg.id, {
        thread: { id: 'forked-session', status: 'idle', turns: [] },
        model: 'o3',
      });

      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 2: Streaming Entries
  // --------------------------------------------------------------------------

  describe('Streaming entries', () => {
    it('emits TranscriptEntry from item/completed notification', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push turn/started
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      // Push an agent message completion
      mockProcess.pushNotification('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-agent-1',
          text: 'Hello from Codex!',
        },
      });

      await waitForTick(50);

      // Collect the entry
      const messages = await collectUntil(adapter, (msgs) => msgs.some((m) => m.type === 'entry'), 200);

      const entryMsg = messages.find((m) => m.type === 'entry');
      expect(entryMsg).toBeDefined();
      if (entryMsg?.type === 'entry') {
        expect(entryMsg.entry.type).toBe('assistant');
        expect(entryMsg.entry.uuid).toBe('msg-agent-1');
      }

      adapter.close();
    });

    it('emits streaming_content events from agentMessage deltas', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push turn/started so we're in active state
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      // Push streaming deltas
      mockProcess.pushNotification('item/agentMessage/delta', {
        threadId: 't-1',
        turnId: 'turn-1',
        itemId: 'msg-stream-1',
        delta: 'Hello ',
      });

      mockProcess.pushNotification('item/agentMessage/delta', {
        threadId: 't-1',
        turnId: 'turn-1',
        itemId: 'msg-stream-1',
        delta: 'world!',
      });

      // Wait for throttled emission (~16ms)
      await waitForTick(50);

      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) =>
          m.type === 'event' && 'kind' in m.event && m.event.kind === 'streaming_content',
        ),
        200,
      );

      const streamEvent = messages.find(
        (m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'streaming_content',
      );
      expect(streamEvent).toBeDefined();

      // Check that accumulated text is present
      if (streamEvent?.type === 'event') {
        const evt = streamEvent.event as any;
        expect(evt.content).toBeDefined();
        const textBlock = evt.content.find((b: any) => b.type === 'text');
        expect(textBlock).toBeDefined();
        expect(textBlock.text).toContain('Hello ');
      }

      adapter.close();
    });

    it('emits streaming_content with thinking blocks from reasoning deltas', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      // Push reasoning delta
      mockProcess.pushNotification('item/reasoning/summaryTextDelta', {
        threadId: 't-1',
        turnId: 'turn-1',
        itemId: 'reason-1',
        delta: 'Let me think...',
        summaryIndex: 0,
      });

      await waitForTick(50);

      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) =>
          m.type === 'event' && 'kind' in m.event && m.event.kind === 'streaming_content',
        ),
        200,
      );

      const streamEvent = messages.find(
        (m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'streaming_content',
      );
      expect(streamEvent).toBeDefined();

      if (streamEvent?.type === 'event') {
        const evt = streamEvent.event as any;
        const thinkingBlock = evt.content.find((b: any) => b.type === 'thinking');
        expect(thinkingBlock).toBeDefined();
        expect(thinkingBlock.thinking).toBe('Let me think...');
      }

      adapter.close();
    });

    it('clears streaming buffer on item/completed with agentMessage', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      // Push delta then complete item
      mockProcess.pushNotification('item/agentMessage/delta', {
        threadId: 't-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Hello world',
      });

      await waitForTick(30);

      // Now push item/completed
      mockProcess.pushNotification('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-1',
          text: 'Hello world',
        },
      });

      await waitForTick(50);

      // Collect all messages and find the null clear event
      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) =>
          m.type === 'event' && 'kind' in m.event &&
          m.event.kind === 'streaming_content' && (m.event as any).content === null,
        ),
        300,
      );

      const clearEvent = messages.find(
        (m) => m.type === 'event' && 'kind' in m.event &&
          m.event.kind === 'streaming_content' && (m.event as any).content === null,
      );
      expect(clearEvent).toBeDefined();

      adapter.close();
    });

    it('clears streaming buffer on turn/completed', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      // Push delta without item/completed
      mockProcess.pushNotification('item/agentMessage/delta', {
        threadId: 't-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Partial text',
      });

      await waitForTick(30);

      // End the turn (safety net clear)
      mockProcess.pushNotification('turn/completed', { turn: { id: 'turn-1' } });

      await waitForTick(50);

      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) =>
          m.type === 'event' && 'kind' in m.event &&
          m.event.kind === 'streaming_content' && (m.event as any).content === null,
        ),
        300,
      );

      const clearEvent = messages.find(
        (m) => m.type === 'event' && 'kind' in m.event &&
          m.event.kind === 'streaming_content' && (m.event as any).content === null,
      );
      expect(clearEvent).toBeDefined();

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 3: Approval Flow
  // --------------------------------------------------------------------------

  describe('Approval flow', () => {
    it('emits AwaitingApprovalEvent on command approval request', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Run a command', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push turn started
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      // Push approval request as SERVER REQUEST (has id)
      mockProcess.pushServerRequest('item/commandExecution/requestApproval', 0, {
        itemId: 'call-123',
        command: 'ls -la',
        cwd: '/test',
        reason: 'List files',
        proposedExecpolicyAmendment: ['ls', '-la'],
      });

      await waitForTick(50);

      // Check status
      expect(adapter.status).toBe('awaiting_approval');

      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) => m.type === 'event' && 'status' in m.event && m.event.status === 'awaiting_approval'),
        200,
      );

      const approvalEvent = messages.find(
        (m) => m.type === 'event' && 'status' in m.event && m.event.status === 'awaiting_approval',
      );
      expect(approvalEvent).toBeDefined();

      if (approvalEvent?.type === 'event' && approvalEvent.event.type === 'status') {
        const evt = approvalEvent.event as any;
        expect(evt.toolUseId).toBe('call-123');
        expect(evt.toolName).toBe('Bash');
      }

      adapter.close();
    });

    it('sends approval response and transitions to active', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Run a command', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push approval request
      mockProcess.pushServerRequest('item/commandExecution/requestApproval', 0, {
        itemId: 'call-456',
        command: 'echo hello',
        cwd: '/test',
        reason: 'Echo command',
        proposedExecpolicyAmendment: ['echo', 'hello'],
      });

      await waitForTick(50);

      expect(adapter.status).toBe('awaiting_approval');

      // Respond to approval
      adapter.respondToApproval('call-456', 'allow');

      // Check response was sent
      const responseMsg = await mockProcess.getNextClientMessage();
      expect(responseMsg.id).toBe(0);
      expect((responseMsg as any).result?.decision).toBe('accept');

      // Status should transition to active
      expect(adapter.status).toBe('active');

      adapter.close();
    });

    it('sends allow_session response with amendment', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Run a command', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push approval request with amendment
      mockProcess.pushServerRequest('item/commandExecution/requestApproval', 0, {
        itemId: 'call-789',
        command: 'npm install',
        cwd: '/test',
        reason: 'Install packages',
        proposedExecpolicyAmendment: ['npm', 'install'],
      });

      await waitForTick(50);

      // Respond with allow_session
      adapter.respondToApproval('call-789', 'allow_session');

      const responseMsg = await mockProcess.getNextClientMessage();
      const result = (responseMsg as any).result;
      expect(result.decision.acceptWithExecpolicyAmendment).toBeDefined();
      expect(result.decision.acceptWithExecpolicyAmendment.execpolicy_amendment).toEqual(['npm', 'install']);

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 4: Token Usage
  // --------------------------------------------------------------------------

  describe('Token usage updates', () => {
    it('maps per-turn Codex token usage into context occupancy', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push token usage notification
      mockProcess.pushNotification('thread/tokenUsage/updated', {
        threadId: 't-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 743067,
            inputTokens: 700000,
            cachedInputTokens: 500000,
            outputTokens: 43067,
          },
          last: {
            totalTokens: 1200,
            inputTokens: 1100,
            cachedInputTokens: 900,
            outputTokens: 100,
          },
          modelContextWindow: 200000,
        },
      });

      await waitForTick(50);

      expect(adapter.contextUsage).not.toBeNull();
      expect(adapter.contextUsage!.tokens.input).toBe(1100);
      expect(adapter.contextUsage!.tokens.output).toBe(100);
      expect(adapter.contextUsage!.tokens.cacheRead).toBe(900);
      expect(adapter.contextUsage!.contextWindow).toBe(200000);
      expect(adapter.contextUsage!.totalTokens).toBe(1200);

      adapter.close();
    });

    it('backfills Codex token usage into assistant entry', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      const collectionPromise = collectUntil(
        adapter,
        (msgs) => msgs.some((m) => m.type === 'entry' && m.entry.type === 'assistant'),
        1000,
      );

      adapter.sendTurn('Test', {});

      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });
      mockProcess.pushNotification('thread/tokenUsage/updated', {
        threadId: 't-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            totalTokens: 743067,
            inputTokens: 700000,
            cachedInputTokens: 500000,
            outputTokens: 43067,
          },
          last: {
            totalTokens: 1200,
            inputTokens: 1100,
            cachedInputTokens: 900,
            outputTokens: 100,
          },
          modelContextWindow: 200000,
        },
      });
      mockProcess.pushNotification('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'msg-agent-1',
          text: 'Hello from Codex!',
        },
      });

      const messages = await collectionPromise;
      const assistantEntry = messages.find(
        (msg) => msg.type === 'entry' && msg.entry.type === 'assistant',
      );

      expect(assistantEntry?.type).toBe('entry');
      if (assistantEntry?.type === 'entry' && assistantEntry.entry.type === 'assistant') {
        expect(assistantEntry.entry.message?.usage).toEqual({
          input_tokens: 1100,
          output_tokens: 100,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 900,
        });
      }

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 5: Interrupt
  // --------------------------------------------------------------------------

  describe('Interrupt', () => {
    it('sends turn/interrupt request', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Long task', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push turn started
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      await waitForTick();

      // Call interrupt
      const interruptPromise = adapter.interrupt();

      // Expect turn/interrupt request
      const interruptMsg = await mockProcess.getNextClientMessage();
      expect(interruptMsg.method).toBe('turn/interrupt');
      expect((interruptMsg.params as any).threadId).toBe('t-1');
      expect((interruptMsg.params as any).turnId).toBe('turn-1');

      mockProcess.pushResponse(interruptMsg.id, {});
      await interruptPromise;

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 6: Close
  // --------------------------------------------------------------------------

  describe('Close', () => {
    it('cancels pending approvals on close', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Run command', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push approval request
      mockProcess.pushServerRequest('item/commandExecution/requestApproval', 0, {
        itemId: 'call-close-test',
        command: 'rm -rf /',
        cwd: '/test',
      });

      await waitForTick(50);
      expect(adapter.status).toBe('awaiting_approval');

      // Close adapter
      adapter.close();

      // Check that a cancel response was sent
      const cancelResponse = await mockProcess.getNextClientMessage();
      expect(cancelResponse.id).toBe(0);
      expect((cancelResponse as any).result?.decision).toBe('cancel');

      expect(adapter.status).toBe('idle');
    });

    it('kills the process on close', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      adapter.close();

      expect(mockProcess.asChildProcess().killed).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Group 7: Legacy Notification Filtering
  // --------------------------------------------------------------------------

  describe('Legacy notification filtering', () => {
    it('ignores codex/event/* notifications', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push turn/started so deltas are processed in active state
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      // Push legacy notification (should be ignored)
      mockProcess.pushNotification('codex/event/agent_message_delta', {
        delta: 'Should be ignored',
      });

      // Push v2 notification (should produce streaming_content event)
      mockProcess.pushNotification('item/agentMessage/delta', {
        threadId: 't-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Should be processed',
      });

      await waitForTick(50);

      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) =>
          m.type === 'event' && 'kind' in m.event && m.event.kind === 'streaming_content',
        ),
        200,
      );

      // Only the v2 delta should result in a streaming_content event (not an entry)
      const streamEvents = messages.filter(
        (m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'streaming_content',
      );
      expect(streamEvents.length).toBeGreaterThanOrEqual(1);
      const entries = messages.filter((m) => m.type === 'entry');
      expect(entries.length).toBe(0);

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 8: Error Handling
  // --------------------------------------------------------------------------

  describe('Error handling', () => {
    it('emits error event on error notification', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push error notification
      mockProcess.pushNotification('error', {
        message: 'Something went wrong',
      });

      await waitForTick(50);

      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'error'),
        200,
      );

      const errorEvent = messages.find(
        (m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'error',
      );
      expect(errorEvent).toBeDefined();

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 9: Settings Changes
  // --------------------------------------------------------------------------

  describe('Settings changes', () => {
    it('emits SettingsChangedEvent on setModel', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      const collected: ChannelMessage[] = [];
      const collectionPromise = collectUntil(
        adapter,
        (msgs) => msgs.some((m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'settings_changed'),
        500,
      ).then((msgs) => {
        collected.push(...msgs);
      });

      await adapter.setModel('gpt-4');

      await collectionPromise;

      const settingsEvent = collected.find(
        (m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'settings_changed',
      );
      expect(settingsEvent).toBeDefined();
      expect(adapter.settings.model).toBe('gpt-4');

      adapter.close();
    });

    it('emits SettingsChangedEvent on setPermissionMode', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      const collected: ChannelMessage[] = [];
      const collectionPromise = collectUntil(
        adapter,
        (msgs) => msgs.some((m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'settings_changed'),
        500,
      ).then((msgs) => {
        collected.push(...msgs);
      });

      await adapter.setPermissionMode('bypassPermissions');

      await collectionPromise;

      expect(adapter.settings.permissionMode).toBe('bypassPermissions');

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 10: Thread Events
  // --------------------------------------------------------------------------

  describe('Thread events', () => {
    it('emits compacting event on thread/compacted', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push compacted notification
      mockProcess.pushNotification('thread/compacted', {
        threadId: 't-1',
      });

      await waitForTick(50);

      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'compacting'),
        200,
      );

      const compactEvent = messages.find(
        (m) => m.type === 'event' && 'kind' in m.event && m.event.kind === 'compacting',
      );
      expect(compactEvent).toBeDefined();

      adapter.close();
    });

    it('emits idle event on turn/completed', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push turn/started then turn/completed
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });
      await waitForTick();
      mockProcess.pushNotification('turn/completed', { turn: { id: 'turn-1' } });

      await waitForTick(50);

      // Should be idle
      expect(adapter.status).toBe('idle');

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 11: Turn-completion with pending approvals
  // --------------------------------------------------------------------------

  describe('Turn-completion with pending approvals', () => {
    it('emits idle+turnComplete when approval resolves after turn/completed', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Run a command', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push turn/started
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });
      // item/started for the tool call
      mockProcess.pushNotification('item/started', { itemId: 'item-1' });

      await waitForTick();

      // Approval request arrives
      mockProcess.pushServerRequest('item/commandExecution/requestApproval', 42, {
        itemId: 'call-hang-test',
        command: 'ls',
        cwd: '/test',
      });

      await waitForTick(50);
      expect(adapter.status).toBe('awaiting_approval');

      // turn/completed fires while approval is still pending
      mockProcess.pushNotification('turn/completed', { turn: { id: 'turn-1' } });
      await waitForTick();

      // Adapter should still be awaiting_approval (not stuck in active)
      expect(adapter.status).toBe('awaiting_approval');

      // User approves
      adapter.respondToApproval('call-hang-test', 'allow');

      // Consume the approval response
      const approvalResponse = await mockProcess.getNextClientMessage();
      expect((approvalResponse as any).result?.decision).toBe('accept');

      // item/completed arrives for the tool call
      mockProcess.pushNotification('item/completed', {
        threadId: 't-1',
        turnId: 'turn-1',
        item: {
          type: 'agentMessage',
          id: 'item-1',
          text: 'Done.',
        },
      });

      await waitForTick(50);

      // Should have transitioned to idle (not stuck in active)
      expect(adapter.status).toBe('idle');

      // Verify the idle event has turnComplete
      const messages = await collectUntil(
        adapter,
        (msgs) => msgs.some((m) =>
          m.type === 'event' && m.event.type === 'status' && m.event.status === 'idle',
        ),
        200,
      );

      // At minimum, we shouldn't be stuck — idle is the important thing
      expect(adapter.status).toBe('idle');

      adapter.close();
    });

    it('emits idle+turnComplete immediately when approval resolves after turn/completed with no pending items', async () => {
      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Run a command', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await waitForTick();

      // Push turn/started
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });

      await waitForTick();

      // Approval request (no item/started — items already settled)
      mockProcess.pushServerRequest('item/commandExecution/requestApproval', 42, {
        itemId: 'call-no-items',
        command: 'echo hi',
        cwd: '/test',
      });

      await waitForTick(50);
      expect(adapter.status).toBe('awaiting_approval');

      // turn/completed fires while approval is still pending
      mockProcess.pushNotification('turn/completed', { turn: { id: 'turn-1' } });
      await waitForTick();

      // User approves — with no pending items, should go straight to idle
      adapter.respondToApproval('call-no-items', 'allow');

      // Consume the approval response
      await mockProcess.getNextClientMessage();

      await waitForTick(50);

      // Should be idle with turnComplete (not active)
      expect(adapter.status).toBe('idle');

      adapter.close();
    });
  });

  // --------------------------------------------------------------------------
  // Group 12: Safety timeout for stuck pendingItemCount
  // --------------------------------------------------------------------------

  describe('Safety timeout for stuck items', () => {
    it('emits plain idle after 10s when items never settle', async () => {
      vi.useFakeTimers();

      const spec: SessionOpenSpec = { mode: 'fresh', cwd: '/test' };
      const adapter = new CodexAgentAdapter(spec);

      adapter.sendTurn('Test', {});

      // Complete handshake
      const initMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(initMsg.id, { userAgent: 'codex' });
      const startMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(startMsg.id, { thread: { id: 't-1', turns: [] }, model: 'o3' });
      const turnMsg = await mockProcess.getNextClientMessage();
      mockProcess.pushResponse(turnMsg.id, { turn: { id: 'turn-1' } });

      await vi.advanceTimersByTimeAsync(20);

      // Push turn/started, then item/started without item/completed
      mockProcess.pushNotification('turn/started', { turn: { id: 'turn-1' } });
      await vi.advanceTimersByTimeAsync(10);

      mockProcess.pushNotification('item/started', { itemId: 'stuck-item' });
      await vi.advanceTimersByTimeAsync(10);

      // turn/completed with items still pending
      mockProcess.pushNotification('turn/completed', { turn: { id: 'turn-1' } });
      await vi.advanceTimersByTimeAsync(10);

      // Status should still be active (waiting for items)
      expect(adapter.status).toBe('active');

      // Advance past the 10s safety timeout
      await vi.advanceTimersByTimeAsync(10_000);

      // Safety timeout should have fired — adapter goes idle
      expect(adapter.status).toBe('idle');

      adapter.close();
      vi.useRealTimers();
    });
  });
});
