/**
 * codex-settings-mapping.ts
 *
 * Bidirectional mapping between Crispy settings and Codex protocol parameters.
 *
 * Responsibilities:
 * - Map permission modes ↔ approval policies
 * - Convert TurnSettings to Codex params
 * - Parse thread config into AdapterSettings
 * - Convert token usage to ContextUsage when the protocol exposes
 *   defensible in-window occupancy
 * - Transform MessageContent to UserInput[]
 *
 * Does NOT:
 * - Make RPC calls
 * - Manage session state
 */

import type { AdapterSettings, TurnSettings } from '../../agent-adapter.js';
import type { ContextUsage, MessageContent, MessageContentBlock } from '../../transcript.js';
import type { AskForApproval } from './protocol/v2/AskForApproval.js';
import type { SandboxMode } from './protocol/v2/SandboxMode.js';
import type { SandboxPolicy } from './protocol/v2/SandboxPolicy.js';
import type { UserInput } from './protocol/v2/UserInput.js';

export interface ResolvedCodexSkillReference {
  name: string;
  path: string;
  /** Pre-read SKILL.md content for self-expansion (Codex doesn't expand skill inputs). */
  content?: string;
}

export type CodexSkillReferenceResolver = (
  name: string,
) => ResolvedCodexSkillReference | undefined;

// ============================================================================
// Permission Mode ↔ Approval Policy Mapping
// ============================================================================

/**
 * Map Crispy permissionMode → Codex approvalPolicy.
 *
 * | Crispy permissionMode | → Codex approvalPolicy |
 * |---|---|
 * | 'default' | 'on-request' |
 * | 'acceptEdits' | 'on-request' |
 * | 'bypassPermissions' | 'never' |
 * | 'plan' | 'on-request' |
 */
export function mapPermissionMode(mode: string): AskForApproval {
  switch (mode) {
    case 'default':
      return 'on-request';
    case 'acceptEdits':
      // Codex CLI 0.115.0 still accepts on-failure but marks it deprecated.
      // Keep Crispy on the supported path even though this collapses multiple
      // UI modes onto the same Codex approval policy.
      return 'on-request';
    case 'bypassPermissions':
      return 'never';
    case 'plan':
      return 'on-request';
    default:
      return 'on-request';
  }
}

/**
 * Map Codex approvalPolicy → Crispy permissionMode.
 *
 * | Codex approvalPolicy | → Crispy permissionMode |
 * |---|---|
 * | 'on-request' | 'default' / preserved current mode |
 * | 'on-failure' | 'acceptEdits' |
 * | 'never' | 'bypassPermissions' |
 * | 'untrusted' | 'default' (closest match) |
 */
export function mapApprovalPolicy(
  policy: string,
  currentMode?: TurnSettings['permissionMode'],
): TurnSettings['permissionMode'] {
  switch (policy) {
    case 'on-request':
      // Codex reports on-request for several Crispy modes once we stop using
      // deprecated on-failure. Preserve the current UI mode when possible so
      // round-trips don't silently flip back to "ask before edits".
      if (currentMode === 'acceptEdits' || currentMode === 'plan') {
        return currentMode;
      }
      return 'default';
    case 'on-failure':
      return 'acceptEdits';
    case 'never':
      return 'bypassPermissions';
    case 'untrusted':
      return 'default';
    default:
      return 'default';
  }
}

// ============================================================================
// Permission Mode → Sandbox Mapping
// ============================================================================

/**
 * Map Crispy permissionMode → Codex SandboxMode (thread-level).
 *
 * | Crispy permissionMode | → Codex sandbox |
 * |---|---|
 * | 'bypassPermissions'  | 'danger-full-access' |
 * | *                     | 'workspace-write' |
 */
export function mapSandboxMode(mode: string): SandboxMode {
  return mode === 'bypassPermissions' ? 'danger-full-access' : 'workspace-write';
}

/**
 * Map Crispy permissionMode → Codex SandboxPolicy (turn-level).
 *
 * Only overrides for bypassPermissions; returns undefined otherwise
 * to let the thread-level sandbox stand.
 */
export function mapSandboxPolicy(mode: string): SandboxPolicy | undefined {
  if (mode === 'bypassPermissions') {
    return { type: 'dangerFullAccess' };
  }
  return undefined;
}

// ============================================================================
// Turn Settings → Codex Params
// ============================================================================

/**
 * Extract Codex-relevant fields from TurnSettings.
 *
 * Returns an object with only the fields that have values,
 * suitable for spreading into TurnStartParams.
 */
export function mapTurnSettings(settings: TurnSettings): Record<string, unknown> {
  const params: Record<string, unknown> = {};

  if (settings.model !== undefined) {
    params.model = settings.model;
  }

  if (settings.permissionMode !== undefined) {
    params.approvalPolicy = mapPermissionMode(settings.permissionMode);
    const sandboxPolicy = mapSandboxPolicy(settings.permissionMode);
    if (sandboxPolicy) {
      params.sandboxPolicy = sandboxPolicy;
    }
  }

  if (settings.outputFormat?.type === 'json_schema') {
    params.outputSchema = settings.outputFormat.schema;
  }

  return params;
}

// ============================================================================
// Thread Config → AdapterSettings
// ============================================================================

/**
 * Parse thread/start response into AdapterSettings.
 *
 * Expected response shape:
 * ```json
 * {
 *   "thread": { "id": "...", "status": "..." },
 *   "model": "o3",
 *   "approvalPolicy": "on-request",
 *   "sandbox": false,
 *   "reasoningEffort": "medium"
 * }
 * ```
 */
export function mapThreadConfig(
  response: Record<string, unknown>,
  currentPermissionMode?: TurnSettings['permissionMode'],
): AdapterSettings {
  const approvalPolicy = response.approvalPolicy as string | undefined;
  const model = response.model as string | undefined;

  return {
    vendor: 'codex',
    model,
    permissionMode: approvalPolicy ? mapApprovalPolicy(approvalPolicy, currentPermissionMode) : undefined,
    allowDangerouslySkipPermissions: approvalPolicy === 'never',
    extraArgs: undefined,
  };
}

// ============================================================================
// Token Usage → ContextUsage
// ============================================================================

/**
 * Map Codex ThreadTokenUsage → Crispy ContextUsage.
 *
 * Uses `last` (per-turn usage for the most recent API call) as the context
 * occupancy signal — `last.inputTokens` reflects the full input context for
 * that turn, so it shrinks after compaction. `total` is cumulative and not
 * useful for a gauge. `modelContextWindow` provides the denominator.
 *
 * Expected usage shape from thread/tokenUsage/updated notification:
 * ```json
 * {
 *   "tokenUsage": {
 *     "total": { ... },
 *     "last": {
 *       "totalTokens": 1197,
 *       "inputTokens": 1120,
 *       "cachedInputTokens": 1040,
 *       "outputTokens": 77,
 *       "reasoningOutputTokens": 0
 *     },
 *     "modelContextWindow": 258400
 *   }
 * }
 * ```
 */
export function mapTokenUsage(usage: Record<string, unknown>): ContextUsage | null {
  const last = usage.last as Record<string, number> | undefined;
  if (!last) return null;

  const input = last.inputTokens ?? 0;
  const output = last.outputTokens ?? 0;
  const cacheRead = last.cachedInputTokens ?? 0;
  const totalTokens = input + output;
  const contextWindow = (usage.modelContextWindow as number) || 200_000;
  const percent = Math.min(Math.round((totalTokens / contextWindow) * 100), 100);

  return {
    tokens: { input, output, cacheCreation: 0, cacheRead },
    totalTokens,
    contextWindow,
    percent,
  };
}

// ============================================================================
// Message Content → UserInput[]
// ============================================================================

function isSkillNameStart(ch: string): boolean {
  return /^[a-z]$/.test(ch);
}

function isSkillNameChar(ch: string): boolean {
  return /^[a-z0-9-]$/.test(ch);
}

function isSkillBoundary(ch: string): boolean {
  return ch.length === 0 || !/[A-Za-z0-9_-]/.test(ch);
}

interface SkillToken {
  name: string;
  start: number;
  end: number;
}

function countRepeatedChars(text: string, start: number, ch: string): number {
  let end = start;
  while (end < text.length && text[end] === ch) {
    end++;
  }
  return end - start;
}

function findExplicitCodexSkillTokens(text: string): SkillToken[] {
  const tokens: SkillToken[] = [];
  let inFence: { ch: '`' | '~'; length: number } | null = null;
  let inlineCodeDelimiterLength: number | null = null;
  let atLineStart = true;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '\n') {
      atLineStart = true;
      continue;
    }

    if (atLineStart && (ch === ' ' || ch === '\t')) {
      continue;
    }

    const repeatedCount = (ch === '`' || ch === '~')
      ? countRepeatedChars(text, i, ch)
      : 0;

    if (atLineStart && repeatedCount >= 3 && (ch === '`' || ch === '~')) {
      if (inFence) {
        if (inFence.ch === ch && repeatedCount >= inFence.length) {
          inFence = null;
        }
      } else if (inlineCodeDelimiterLength === null) {
        inFence = { ch, length: repeatedCount };
      }
      atLineStart = false;
      i += repeatedCount - 1;
      continue;
    }

    atLineStart = false;

    if (inFence) {
      continue;
    }

    if (ch === '\\') {
      i += 1;
      continue;
    }

    if (ch === '`') {
      if (inlineCodeDelimiterLength === null) {
        inlineCodeDelimiterLength = repeatedCount;
      } else if (inlineCodeDelimiterLength === repeatedCount) {
        inlineCodeDelimiterLength = null;
      }
      i += repeatedCount - 1;
      continue;
    }

    if (inlineCodeDelimiterLength !== null || ch !== '$') {
      continue;
    }

    const prev = i > 0 ? text[i - 1] : '';
    if (!isSkillBoundary(prev)) {
      continue;
    }

    const nameStart = i + 1;
    if (nameStart >= text.length || !isSkillNameStart(text[nameStart])) {
      continue;
    }

    let end = nameStart + 1;
    while (end < text.length && isSkillNameChar(text[end])) {
      end++;
    }

    const next = end < text.length ? text[end] : '';
    if (!isSkillBoundary(next)) {
      continue;
    }

    tokens.push({
      name: text.slice(nameStart, end),
      start: i,
      end,
    });
    i = end - 1;
  }

  return tokens;
}

function createTextInput(text: string): UserInput {
  return {
    type: 'text',
    text,
    text_elements: [],
  };
}

function mapTextContent(
  text: string,
  resolveSkillReference?: CodexSkillReferenceResolver,
): UserInput[] {
  if (!resolveSkillReference) {
    return [createTextInput(text)];
  }

  const tokens = findExplicitCodexSkillTokens(text);
  if (tokens.length === 0) {
    return [createTextInput(text)];
  }

  const inputs: UserInput[] = [];
  let textBuffer = '';
  let cursor = 0;

  for (const token of tokens) {
    textBuffer += text.slice(cursor, token.start);

    const resolvedSkill = resolveSkillReference(token.name);
    if (!resolvedSkill) {
      textBuffer += text.slice(token.start, token.end);
      cursor = token.end;
      continue;
    }

    if (textBuffer.length > 0) {
      inputs.push(createTextInput(textBuffer));
      textBuffer = '';
    }

    // Send both the skill input (for Codex to potentially handle natively)
    // AND self-expand the content as text (Codex app-server doesn't currently
    // expand skill inputs, so the model never sees the SKILL.md instructions).
    inputs.push({
      type: 'skill',
      name: resolvedSkill.name,
      path: resolvedSkill.path,
    });
    if (resolvedSkill.content) {
      inputs.push(createTextInput(resolvedSkill.content));
    }

    cursor = token.end;
  }

  textBuffer += text.slice(cursor);
  if (textBuffer.length > 0) {
    inputs.push(createTextInput(textBuffer));
  }

  return inputs;
}

export function hasExplicitCodexSkillReference(content: MessageContent): boolean {
  if (typeof content === 'string') {
    return findExplicitCodexSkillTokens(content).length > 0;
  }

  return content.some((block) => block.type === 'text' && findExplicitCodexSkillTokens(block.text).length > 0);
}

/**
 * Transform Crispy MessageContent to Codex UserInput[].
 *
 * CRITICAL: Codex's UserInput text type requires `text_elements` field.
 *
 * String input:
 *   "hello" → [{ type: 'text', text: 'hello', text_elements: [] }]
 *
 * ContentBlock[] input with image:
 *   [
 *     { type: 'text', text: 'Look at this' },
 *     { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
 *   ]
 *   → [
 *     { type: 'text', text: 'Look at this', text_elements: [] },
 *     { type: 'image', url: 'data:image/png;base64,...' }
 *   ]
 *
 * When `resolveSkillReference` is provided, explicit `$skill-name` tokens in
 * text blocks are converted to Codex `skill` inputs. Unresolved references are
 * left untouched in the text.
 */
export function mapMessageContent(
  content: MessageContent,
  resolveSkillReference?: CodexSkillReferenceResolver,
): UserInput[] {
  // String input → single text element
  if (typeof content === 'string') {
    return mapTextContent(content, resolveSkillReference);
  }

  // Array of content blocks
  return content.flatMap((block): UserInput[] => {
    if (block.type === 'text') {
      return mapTextContent(block.text, resolveSkillReference);
    }

    if (block.type === 'image') {
      // Convert base64 source to data URL format
      const imageBlock = block as MessageContentBlock & { type: 'image' };
      const { media_type, data } = imageBlock.source;
      return [{
        type: 'image',
        url: `data:${media_type};base64,${data}`,
      }];
    }

    // Fallback for unknown block types — treat as text if possible
    return [createTextInput(JSON.stringify(block))];
  });
}
