/**
 * Tests for Codex history serializer (TranscriptEntry[] -> ResponseItem[])
 *
 * Validates that serializeToCodexHistory correctly transforms universal
 * TranscriptEntry arrays into Codex ResponseItem format for thread/resume.
 */

import { describe, it, expect } from 'vitest';
import { serializeToCodexHistory } from '../src/core/adapters/codex/codex-history-serializer.js';
import type { TranscriptEntry, ToolUseBlock, ThinkingBlock, ImageBlock } from '../src/core/transcript.js';
import type { ResponseItem } from '../src/core/adapters/codex/protocol/ResponseItem.js';

// ============================================================================
// Helpers
// ============================================================================

function makeUserEntry(text: string, uuid = 'u-1'): TranscriptEntry {
  return {
    type: 'user',
    uuid,
    vendor: 'claude',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function makeAssistantEntry(text: string, uuid = 'a-1'): TranscriptEntry {
  return {
    type: 'assistant',
    uuid,
    vendor: 'claude',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  };
}

function makeToolUseEntry(toolUse: ToolUseBlock, uuid = 'tu-1'): TranscriptEntry {
  return {
    type: 'assistant',
    uuid,
    vendor: 'claude',
    message: { role: 'assistant', content: [toolUse] },
  };
}

function makeToolResultEntry(
  toolUseId: string,
  output: string,
  opts: { isError?: boolean; uuid?: string; exitCode?: number } = {},
): TranscriptEntry {
  const { isError = false, uuid = `${toolUseId}-result`, exitCode } = opts;
  return {
    type: 'result',
    uuid,
    parentUuid: toolUseId,
    vendor: 'claude',
    message: {
      role: 'tool',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: output,
        is_error: isError,
      }],
    },
    ...(exitCode !== undefined && {
      toolUseResult: { output, exitCode },
    }),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('serializeToCodexHistory', () => {

  // ========== Basic serialization ==========

  describe('basic text serialization', () => {
    it('serializes a user text entry', () => {
      const items = serializeToCodexHistory([makeUserEntry('Hello world')]);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('message');

      const msg = items[0] as Extract<ResponseItem, { type: 'message' }>;
      expect(msg.role).toBe('user');
      expect(msg.content).toHaveLength(1);
      expect(msg.content[0]).toEqual({ type: 'input_text', text: 'Hello world' });
    });

    it('serializes an assistant text entry', () => {
      const items = serializeToCodexHistory([makeAssistantEntry('Hi there')]);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('message');

      const msg = items[0] as Extract<ResponseItem, { type: 'message' }>;
      expect(msg.role).toBe('assistant');
      expect(msg.content).toHaveLength(1);
      expect(msg.content[0]).toEqual({ type: 'output_text', text: 'Hi there' });
    });

    it('serializes a multi-turn conversation', () => {
      const entries = [
        makeUserEntry('What is 2+2?', 'u-1'),
        makeAssistantEntry('2+2 = 4', 'a-1'),
        makeUserEntry('And 3+3?', 'u-2'),
        makeAssistantEntry('3+3 = 6', 'a-2'),
      ];

      const items = serializeToCodexHistory(entries);

      expect(items).toHaveLength(4);
      expect(items[0].type).toBe('message');
      expect(items[1].type).toBe('message');
      expect(items[2].type).toBe('message');
      expect(items[3].type).toBe('message');

      expect((items[0] as any).role).toBe('user');
      expect((items[1] as any).role).toBe('assistant');
      expect((items[2] as any).role).toBe('user');
      expect((items[3] as any).role).toBe('assistant');
    });
  });

  // ========== Content as string ==========

  describe('content as string', () => {
    it('handles message.content as string for user entries', () => {
      const entry: TranscriptEntry = {
        type: 'user',
        uuid: 'u-str',
        vendor: 'claude',
        message: { role: 'user', content: 'plain string content' },
      };

      const items = serializeToCodexHistory([entry]);

      expect(items).toHaveLength(1);
      const msg = items[0] as Extract<ResponseItem, { type: 'message' }>;
      expect(msg.content[0]).toEqual({ type: 'input_text', text: 'plain string content' });
    });

    it('handles message.content as string for assistant entries', () => {
      const entry: TranscriptEntry = {
        type: 'assistant',
        uuid: 'a-str',
        vendor: 'claude',
        message: { role: 'assistant', content: 'plain assistant text' },
      };

      const items = serializeToCodexHistory([entry]);

      expect(items).toHaveLength(1);
      const msg = items[0] as Extract<ResponseItem, { type: 'message' }>;
      expect(msg.content[0]).toEqual({ type: 'output_text', text: 'plain assistant text' });
    });
  });

  // ========== Empty and edge cases ==========

  describe('empty and edge cases', () => {
    it('returns empty array for empty input', () => {
      expect(serializeToCodexHistory([])).toEqual([]);
    });

    it('skips entries with no message content', () => {
      const entry: TranscriptEntry = { type: 'user', uuid: 'u-empty' };
      const items = serializeToCodexHistory([entry]);
      expect(items).toEqual([]);
    });

    it('skips user entries with empty string content', () => {
      const entry: TranscriptEntry = {
        type: 'user',
        uuid: 'u-empty-str',
        vendor: 'claude',
        message: { role: 'user', content: '' },
      };
      const items = serializeToCodexHistory([entry]);
      expect(items).toEqual([]);
    });
  });

  // ========== Filtering ==========

  describe('entry type filtering', () => {
    it('skips stream_event entries', () => {
      const entries: TranscriptEntry[] = [
        { type: 'stream_event', uuid: 'se-1', message: { role: 'assistant', content: 'delta' } },
        makeUserEntry('Hello'),
      ];

      const items = serializeToCodexHistory(entries);
      expect(items).toHaveLength(1);
      expect((items[0] as any).role).toBe('user');
    });

    it('skips system entries', () => {
      const entries: TranscriptEntry[] = [
        { type: 'system', uuid: 'sys-1', message: { role: 'system', content: 'System info' } },
        makeAssistantEntry('Response'),
      ];

      const items = serializeToCodexHistory(entries);
      expect(items).toHaveLength(1);
    });

    it('skips progress entries', () => {
      const entries: TranscriptEntry[] = [
        { type: 'progress', uuid: 'pg-1' },
        makeUserEntry('Hello'),
      ];

      const items = serializeToCodexHistory(entries);
      expect(items).toHaveLength(1);
    });

    it('skips queue-operation entries', () => {
      const entries: TranscriptEntry[] = [
        { type: 'queue-operation', uuid: 'qo-1' },
        makeUserEntry('Hello'),
      ];

      const items = serializeToCodexHistory(entries);
      expect(items).toHaveLength(1);
    });

    it('skips file-history-snapshot entries', () => {
      const entries: TranscriptEntry[] = [
        { type: 'file-history-snapshot', uuid: 'fhs-1' },
        makeUserEntry('Hello'),
      ];

      const items = serializeToCodexHistory(entries);
      expect(items).toHaveLength(1);
    });

    it('skips summary entries', () => {
      const entries: TranscriptEntry[] = [
        { type: 'summary', uuid: 'sum-1', summary: 'A summary' },
        makeUserEntry('Hello'),
      ];

      const items = serializeToCodexHistory(entries);
      expect(items).toHaveLength(1);
    });
  });

  // ========== Thinking blocks ==========

  describe('thinking blocks', () => {
    it('serializes thinking blocks as reasoning item', () => {
      const entry: TranscriptEntry = {
        type: 'assistant',
        uuid: 'a-think',
        vendor: 'claude',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Let me think about this...' } as ThinkingBlock,
          ],
        },
      };

      const items = serializeToCodexHistory([entry]);

      expect(items).toHaveLength(1);
      expect(items[0].type).toBe('reasoning');

      const reasoning = items[0] as Extract<ResponseItem, { type: 'reasoning' }>;
      expect(reasoning.encrypted_content).toBeNull();
      expect(reasoning.summary).toHaveLength(1);
      expect(reasoning.summary[0]).toEqual({
        type: 'summary_text',
        text: 'Let me think about this...',
      });
    });

    it('serializes multiple thinking blocks into one reasoning item', () => {
      const entry: TranscriptEntry = {
        type: 'assistant',
        uuid: 'a-think2',
        vendor: 'claude',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Step 1: analyze' } as ThinkingBlock,
            { type: 'thinking', thinking: 'Step 2: implement' } as ThinkingBlock,
          ],
        },
      };

      const items = serializeToCodexHistory([entry]);

      expect(items).toHaveLength(1);
      const reasoning = items[0] as Extract<ResponseItem, { type: 'reasoning' }>;
      expect(reasoning.summary).toHaveLength(2);
    });

    it('strips signature field from thinking blocks', () => {
      const entry: TranscriptEntry = {
        type: 'assistant',
        uuid: 'a-sig',
        vendor: 'claude',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'thinking',
              thinking: 'Reasoning here',
              signature: 'some-signature-data',
            } as ThinkingBlock,
          ],
        },
      };

      const items = serializeToCodexHistory([entry]);

      expect(items).toHaveLength(1);
      const reasoning = items[0] as Extract<ResponseItem, { type: 'reasoning' }>;
      expect(reasoning.encrypted_content).toBeNull();
      // Signature should not appear in the output
      expect(JSON.stringify(reasoning)).not.toContain('some-signature-data');
    });

    it('handles assistant entry with both thinking and text blocks', () => {
      const entry: TranscriptEntry = {
        type: 'assistant',
        uuid: 'a-mixed',
        vendor: 'claude',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Thinking first...' } as ThinkingBlock,
            { type: 'text', text: 'Here is my answer.' },
          ],
        },
      };

      const items = serializeToCodexHistory([entry]);

      // Should produce both a reasoning item and a message item
      expect(items).toHaveLength(2);

      const reasoning = items.find((i) => i.type === 'reasoning');
      const message = items.find((i) => i.type === 'message');

      expect(reasoning).toBeDefined();
      expect(message).toBeDefined();
      expect((message as any).content[0].text).toBe('Here is my answer.');
    });
  });

  // ========== Tool use mapping ==========

  describe('tool use mapping', () => {
    it('serializes Bash tool_use as function_call + function_call_output', () => {
      const toolUse: ToolUseBlock = {
        type: 'tool_use',
        id: 'bash-1',
        name: 'Bash',
        input: { command: 'ls -la' },
      };
      const result = makeToolResultEntry('bash-1', 'file1\nfile2', { exitCode: 0 });

      const items = serializeToCodexHistory([
        makeToolUseEntry(toolUse, 'tu-bash'),
        result,
      ]);

      // Bash uses function_call (not local_shell_call) so output is self-contained
      // and Codex doesn't try to look up missing shell call outputs by call_id
      const funcCall = items.find((i) => i.type === 'function_call');
      const funcOutput = items.find((i) => i.type === 'function_call_output');

      expect(funcCall).toBeDefined();
      expect(funcOutput).toBeDefined();

      const fc = funcCall as Extract<ResponseItem, { type: 'function_call' }>;
      expect(fc.name).toBe('Bash');
      expect(fc.call_id).toBe('bash-1');
      expect(JSON.parse(fc.arguments)).toEqual({ command: 'ls -la' });

      const fo = funcOutput as Extract<ResponseItem, { type: 'function_call_output' }>;
      expect(fo.call_id).toBe('bash-1');
      expect(fo.output.body).toBe('file1\nfile2');
      expect(fo.output.success).toBe(true);
    });

    it('serializes non-Bash tool_use as function_call + function_call_output', () => {
      const toolUse: ToolUseBlock = {
        type: 'tool_use',
        id: 'read-1',
        name: 'Read',
        input: { file_path: '/tmp/test.txt' },
      };
      const result = makeToolResultEntry('read-1', 'file contents here');

      const items = serializeToCodexHistory([
        makeToolUseEntry(toolUse, 'tu-read'),
        result,
      ]);

      const funcCall = items.find((i) => i.type === 'function_call');
      const funcOutput = items.find((i) => i.type === 'function_call_output');

      expect(funcCall).toBeDefined();
      expect(funcOutput).toBeDefined();

      const fc = funcCall as Extract<ResponseItem, { type: 'function_call' }>;
      expect(fc.name).toBe('Read');
      expect(fc.call_id).toBe('read-1');
      expect(JSON.parse(fc.arguments)).toEqual({ file_path: '/tmp/test.txt' });

      const fo = funcOutput as Extract<ResponseItem, { type: 'function_call_output' }>;
      expect(fo.call_id).toBe('read-1');
      expect(fo.output.body).toBe('file contents here');
      expect(fo.output.success).toBe(true);
    });

    it('handles tool_use without corresponding result', () => {
      const toolUse: ToolUseBlock = {
        type: 'tool_use',
        id: 'orphan-1',
        name: 'Grep',
        input: { pattern: 'foo' },
      };

      const items = serializeToCodexHistory([
        makeToolUseEntry(toolUse, 'tu-orphan'),
      ]);

      // Should still emit function_call, but no function_call_output
      const funcCall = items.find((i) => i.type === 'function_call');
      const funcOutput = items.find((i) => i.type === 'function_call_output');

      expect(funcCall).toBeDefined();
      expect(funcOutput).toBeUndefined();
    });

    it('handles Bash tool_use without result (no output emitted)', () => {
      const toolUse: ToolUseBlock = {
        type: 'tool_use',
        id: 'bash-incomplete',
        name: 'Bash',
        input: { command: 'sleep 100' },
      };

      const items = serializeToCodexHistory([
        makeToolUseEntry(toolUse, 'tu-bash-inc'),
      ]);

      // Should still emit function_call, but no function_call_output
      const funcCall = items.find((i) => i.type === 'function_call');
      const funcOutput = items.find((i) => i.type === 'function_call_output');

      expect(funcCall).toBeDefined();
      expect(funcOutput).toBeUndefined();

      const fc = funcCall as Extract<ResponseItem, { type: 'function_call' }>;
      expect(fc.name).toBe('Bash');
      expect(fc.call_id).toBe('bash-incomplete');
    });

    it('handles tool result with is_error flag', () => {
      const toolUse: ToolUseBlock = {
        type: 'tool_use',
        id: 'err-1',
        name: 'Write',
        input: { file_path: '/etc/protected', content: 'data' },
      };
      const result = makeToolResultEntry('err-1', 'Permission denied', { isError: true });

      const items = serializeToCodexHistory([
        makeToolUseEntry(toolUse, 'tu-err'),
        result,
      ]);

      const funcOutput = items.find((i) => i.type === 'function_call_output') as
        Extract<ResponseItem, { type: 'function_call_output' }>;

      expect(funcOutput).toBeDefined();
      expect(funcOutput.output.success).toBe(false);
      expect(funcOutput.output.body).toBe('Permission denied');
    });

    it('handles assistant entry with text + tool_use blocks combined', () => {
      const entry: TranscriptEntry = {
        type: 'assistant',
        uuid: 'a-combo',
        vendor: 'claude',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check the file.' },
            {
              type: 'tool_use',
              id: 'read-combo',
              name: 'Read',
              input: { file_path: '/tmp/test.txt' },
            } as ToolUseBlock,
          ],
        },
      };
      const result = makeToolResultEntry('read-combo', 'file data');

      const items = serializeToCodexHistory([entry, result]);

      // Should have: message (text), function_call, function_call_output
      const message = items.find((i) => i.type === 'message');
      const funcCall = items.find((i) => i.type === 'function_call');
      const funcOutput = items.find((i) => i.type === 'function_call_output');

      expect(message).toBeDefined();
      expect(funcCall).toBeDefined();
      expect(funcOutput).toBeDefined();

      expect((message as any).content[0].text).toBe('Let me check the file.');
    });
  });

  // ========== Orphan result entries ==========

  describe('orphan result entries', () => {
    it('skips result entries without a matching tool_use', () => {
      const result = makeToolResultEntry('nonexistent-tool', 'some output');

      const items = serializeToCodexHistory([result]);

      // Result entries are always skipped at the top level
      // (they're consumed only when paired with their tool_use)
      expect(items).toEqual([]);
    });
  });

  // ========== Image content ==========

  describe('image content in user messages', () => {
    it('converts base64 image to input_image', () => {
      const entry: TranscriptEntry = {
        type: 'user',
        uuid: 'u-img',
        vendor: 'claude',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'What is this?' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
            } as ImageBlock,
          ],
        },
      };

      const items = serializeToCodexHistory([entry]);

      expect(items).toHaveLength(1);
      const msg = items[0] as Extract<ResponseItem, { type: 'message' }>;
      expect(msg.content).toHaveLength(2);
      expect(msg.content[0]).toEqual({ type: 'input_text', text: 'What is this?' });
      expect(msg.content[1]).toEqual({
        type: 'input_image',
        image_url: 'data:image/png;base64,iVBORw0KGgo=',
      });
    });

    it('converts url-sourced image to input_image', () => {
      const entry: TranscriptEntry = {
        type: 'user',
        uuid: 'u-img-url',
        vendor: 'claude',
        message: {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', data: 'https://example.com/img.png' },
            } as ImageBlock,
          ],
        },
      };

      const items = serializeToCodexHistory([entry]);

      expect(items).toHaveLength(1);
      const msg = items[0] as Extract<ResponseItem, { type: 'message' }>;
      expect(msg.content[0]).toEqual({
        type: 'input_image',
        image_url: 'https://example.com/img.png',
      });
    });
  });

  // ========== Mixed complex scenario ==========

  describe('complex mixed scenarios', () => {
    it('handles a full conversation with text, thinking, tools, and results', () => {
      const entries: TranscriptEntry[] = [
        makeUserEntry('Read the file and tell me what it contains', 'u-1'),
        {
          type: 'assistant',
          uuid: 'a-1',
          vendor: 'claude',
          message: {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'I need to read the file first.' } as ThinkingBlock,
              { type: 'text', text: 'Let me read that file for you.' },
              {
                type: 'tool_use',
                id: 'read-1',
                name: 'Read',
                input: { file_path: '/tmp/data.txt' },
              } as ToolUseBlock,
            ],
          },
        },
        makeToolResultEntry('read-1', 'Hello from the file!'),
        makeAssistantEntry('The file contains: "Hello from the file!"', 'a-2'),
      ];

      const items = serializeToCodexHistory(entries);

      // Expected: user message, reasoning, assistant text, function_call, function_call_output, assistant text
      expect(items.length).toBeGreaterThanOrEqual(5);

      // First item: user message
      expect(items[0].type).toBe('message');
      expect((items[0] as any).role).toBe('user');

      // Should have reasoning somewhere
      const reasoning = items.find((i) => i.type === 'reasoning');
      expect(reasoning).toBeDefined();

      // Should have function_call and output
      const funcCall = items.find((i) => i.type === 'function_call');
      const funcOutput = items.find((i) => i.type === 'function_call_output');
      expect(funcCall).toBeDefined();
      expect(funcOutput).toBeDefined();
    });

    it('preserves entry order for interleaved user/assistant messages', () => {
      const entries: TranscriptEntry[] = [
        makeUserEntry('First question', 'u-1'),
        makeAssistantEntry('First answer', 'a-1'),
        // System entry should be skipped
        { type: 'system', uuid: 'sys-1', message: { role: 'system', content: 'System message' } },
        makeUserEntry('Second question', 'u-2'),
        makeAssistantEntry('Second answer', 'a-2'),
      ];

      const items = serializeToCodexHistory(entries);

      expect(items).toHaveLength(4);
      expect((items[0] as any).role).toBe('user');
      expect((items[0] as any).content[0].text).toBe('First question');
      expect((items[1] as any).role).toBe('assistant');
      expect((items[1] as any).content[0].text).toBe('First answer');
      expect((items[2] as any).role).toBe('user');
      expect((items[2] as any).content[0].text).toBe('Second question');
      expect((items[3] as any).role).toBe('assistant');
      expect((items[3] as any).content[0].text).toBe('Second answer');
    });
  });
});
