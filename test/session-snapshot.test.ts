import { describe, expect, it } from 'vitest';

import type { AdapterSettings, ChannelMessage } from '../src/core/agent-adapter.js';
import type { ChannelCatchupMessage, PendingApprovalInfo } from '../src/core/channel-events.js';
import { getStatusLine, renderSession } from '../src/core/message-view/render.js';
import {
  applyCatchup,
  applyChannelMessage,
  applySubscriberMessage,
  createSessionSnapshot,
} from '../src/core/session-snapshot.js';
import type { ContextUsage, TranscriptEntry } from '../src/core/transcript.js';

function makeAssistantEntry(text: string, toolUseId?: string): TranscriptEntry {
  return {
    type: 'assistant',
    message: {
      content: toolUseId
        ? [
            { type: 'text', text },
            { type: 'tool_use', id: toolUseId, name: 'bash', input: { command: `echo ${toolUseId}` } },
          ]
        : text,
    },
  };
}

function makeUserToolResultEntry(toolUseId: string, isError = false): TranscriptEntry {
  return {
    type: 'user',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'result', is_error: isError },
      ],
    },
  };
}

function makeResultToolResultEntry(toolUseId: string, isError = false): TranscriptEntry {
  return {
    type: 'result',
    message: {
      content: [
        { type: 'tool_result', tool_use_id: toolUseId, content: 'result', is_error: isError },
      ],
    },
  };
}

function makeApproval(toolUseId: string): PendingApprovalInfo {
  return {
    toolUseId,
    toolName: 'Bash',
    input: { command: 'npm test' },
    reason: 'Need permission',
    options: [
      { id: 'allow', label: 'Allow once' },
      { id: 'deny', label: 'Deny' },
    ],
  };
}

const SETTINGS: AdapterSettings = {
  vendor: 'claude',
  model: 'claude-sonnet-4-5',
  permissionMode: 'default',
  allowDangerouslySkipPermissions: false,
  extraArgs: undefined,
};

const CONTEXT_USAGE: ContextUsage = {
  tokens: { input: 10, output: 5, cacheCreation: 0, cacheRead: 0 },
  totalTokens: 15,
  contextWindow: 200_000,
  percent: 0,
};

function makeCatchup(
  overrides: Partial<ChannelCatchupMessage> = {},
): ChannelCatchupMessage {
  return {
    type: 'catchup',
    state: 'idle',
    sessionId: 'sess-1',
    settings: SETTINGS,
    contextUsage: CONTEXT_USAGE,
    pendingApprovals: [],
    entries: [],
    ...overrides,
  };
}

describe('session-snapshot', () => {
  it('initializes from catchup, including zero-entry catchup metadata', () => {
    const approval = makeApproval('toolu-1');
    const snapshot = applyCatchup(
      createSessionSnapshot(),
      makeCatchup({
        entries: [],
        state: 'awaiting_approval',
        pendingApprovals: [approval],
      }),
    );

    expect(snapshot.entries).toEqual([]);
    expect(snapshot.toolResults.size).toBe(0);
    expect(snapshot.status).toBe('approval');
    expect(snapshot.pendingApprovals).toEqual([approval]);
    expect(snapshot.settings).toEqual(SETTINGS);
    expect(snapshot.contextUsage).toEqual(CONTEXT_USAGE);
  });

  it('catchup replaces prior semantic state cleanly', () => {
    let snapshot = createSessionSnapshot();
    snapshot = applyChannelMessage(snapshot, { type: 'entry', entry: makeAssistantEntry('old', 'tool-old') });
    snapshot = applyChannelMessage(snapshot, { type: 'entry', entry: makeUserToolResultEntry('tool-old') });
    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: {
        type: 'status',
        status: 'awaiting_approval',
        ...makeApproval('tool-old'),
      },
    });

    const replacement = makeCatchup({
      entries: [makeAssistantEntry('new', 'tool-new'), makeResultToolResultEntry('tool-new', true)],
      state: 'background',
      pendingApprovals: [],
      settings: {
        ...SETTINGS,
        vendor: 'codex',
        model: 'gpt-5.4',
      },
      contextUsage: null,
    });

    snapshot = applyCatchup(snapshot, replacement);

    expect(snapshot.entries).toEqual(replacement.entries);
    expect([...snapshot.toolResults.entries()]).toEqual([['tool-new', true]]);
    expect(snapshot.status).toBe('background');
    expect(snapshot.pendingApprovals).toEqual([]);
    expect(snapshot.settings).toEqual(replacement.settings);
    expect(snapshot.contextUsage).toBeNull();
  });

  it('appends entry events without replacing prior history', () => {
    const start = applyCatchup(
      createSessionSnapshot(),
      makeCatchup({ entries: [makeAssistantEntry('first')] }),
    );

    const next = applySubscriberMessage(start, {
      type: 'entry',
      entry: makeAssistantEntry('second'),
    });

    expect(next.entries).toHaveLength(2);
    expect(next.entries[0]?.message?.content).toBe('first');
    expect(next.entries[1]?.message?.content).toBe('second');
  });

  it('maps status events and keeps approvals in sync', () => {
    const approvalOne = makeApproval('toolu-1');
    const approvalTwo = makeApproval('toolu-2');
    let snapshot = createSessionSnapshot();

    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: { type: 'status', status: 'active' },
    });
    expect(snapshot.status).toBe('working');
    expect(snapshot.pendingApprovals).toEqual([]);

    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: { type: 'status', status: 'awaiting_approval', ...approvalOne },
    });
    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: { type: 'status', status: 'awaiting_approval', ...approvalTwo },
    });
    expect(snapshot.status).toBe('approval');
    expect(snapshot.pendingApprovals.map((approval) => approval.toolUseId)).toEqual(['toolu-1', 'toolu-2']);

    // active preserves approvals (matches session-channel: only idle/background clear)
    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: { type: 'status', status: 'active' },
    });
    expect(snapshot.status).toBe('working');
    expect(snapshot.pendingApprovals).toHaveLength(2);

    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: { type: 'status', status: 'idle' },
    });
    expect(snapshot.status).toBe('idle');
    expect(snapshot.pendingApprovals).toEqual([]);

    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: { type: 'status', status: 'background' },
    });
    expect(snapshot.status).toBe('background');
  });

  it('updates settings from settings_changed notifications', () => {
    const nextSettings: AdapterSettings = {
      ...SETTINGS,
      model: 'claude-haiku-4-5',
      permissionMode: 'acceptEdits',
    };

    const snapshot = applyChannelMessage(createSessionSnapshot(), {
      type: 'event',
      event: {
        type: 'notification',
        kind: 'settings_changed',
        settings: nextSettings,
      },
    });

    expect(snapshot.settings).toEqual(nextSettings);
  });

  it('derives tool results from both user and result entries', () => {
    let snapshot = createSessionSnapshot();
    snapshot = applyChannelMessage(snapshot, {
      type: 'entry',
      entry: makeUserToolResultEntry('toolu-user'),
    });
    snapshot = applyChannelMessage(snapshot, {
      type: 'entry',
      entry: makeResultToolResultEntry('toolu-result', true),
    });

    expect([...snapshot.toolResults.entries()]).toEqual([
      ['toolu-user', false],
      ['toolu-result', true],
    ]);
  });

  it('maps streaming catchup state to working', () => {
    const snapshot = applyCatchup(createSessionSnapshot(), makeCatchup({ state: 'streaming' }));
    expect(snapshot.status).toBe('working');
  });

  it('maps unattached catchup state to connecting', () => {
    const snapshot = applyCatchup(createSessionSnapshot(), makeCatchup({ state: 'unattached' }));
    expect(snapshot.status).toBe('connecting');
  });

  it('upserts approval with same toolUseId', () => {
    let snapshot = createSessionSnapshot();
    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: { type: 'status', status: 'awaiting_approval', ...makeApproval('toolu-1') },
    });
    snapshot = applyChannelMessage(snapshot, {
      type: 'event',
      event: {
        type: 'status',
        status: 'awaiting_approval',
        toolUseId: 'toolu-1',
        toolName: 'Write',
        input: {},
        reason: 'updated',
        options: [{ id: 'allow', label: 'Allow' }],
      },
    });
    expect(snapshot.pendingApprovals).toHaveLength(1);
    expect(snapshot.pendingApprovals[0].toolName).toBe('Write');
  });

  it('returns snapshot unchanged for non-settings_changed notifications', () => {
    const snapshot = applyCatchup(createSessionSnapshot(), makeCatchup({ state: 'idle' }));
    const next = applyChannelMessage(snapshot, {
      type: 'event',
      event: { type: 'notification', kind: 'error', error: 'boom' },
    });
    expect(next).toBe(snapshot);
  });
});

describe('session-snapshot + message-view render integration', () => {
  it('renders a long catchup deterministically across repeated sync cycles', () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push(
        makeAssistantEntry(
          `Analysis step ${i}: ${'investigating the codebase for potential issues '.repeat(3)}`,
          `tool-${i}`,
        ),
      );
      entries.push(makeUserToolResultEntry(`tool-${i}`));
    }

    const snapshot = applyCatchup(
      createSessionSnapshot(),
      makeCatchup({ entries, state: 'streaming' }),
    );

    const first = renderSession(snapshot.entries, snapshot.toolResults, getStatusLine(snapshot.status));
    const second = renderSession(snapshot.entries, snapshot.toolResults, getStatusLine(snapshot.status));

    expect(first.length).toBeGreaterThanOrEqual(2);
    expect(first.length).toBeLessThanOrEqual(8);
    expect(first).toEqual(second);
  });

  it('handles catchup with approvals, then live entry and status updates', () => {
    const approval = makeApproval('toolu-approval');
    let snapshot = applyCatchup(
      createSessionSnapshot(),
      makeCatchup({
        entries: [makeAssistantEntry('Waiting on approval')],
        state: 'awaiting_approval',
        pendingApprovals: [approval],
      }),
    );

    let chunks = renderSession(snapshot.entries, snapshot.toolResults, getStatusLine(snapshot.status));
    expect(chunks.join('\n')).toContain('Awaiting approval');
    expect(snapshot.pendingApprovals).toEqual([approval]);

    const liveMessages: ChannelMessage[] = [
      { type: 'entry', entry: makeAssistantEntry('Resumed work') },
      { type: 'event', event: { type: 'status', status: 'active' } },
      { type: 'event', event: { type: 'status', status: 'idle' } },
    ];

    for (const message of liveMessages) {
      snapshot = applyChannelMessage(snapshot, message);
    }

    chunks = renderSession(snapshot.entries, snapshot.toolResults, getStatusLine(snapshot.status));
    expect(chunks.join('\n')).toContain('Resumed work');
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.status).toBe('idle');
    expect(snapshot.pendingApprovals).toEqual([]);
  });
});
