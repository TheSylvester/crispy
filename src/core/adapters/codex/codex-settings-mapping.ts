/**
 * codex-settings-mapping.ts
 *
 * Bidirectional mapping between Crispy settings and Codex protocol parameters.
 *
 * Responsibilities:
 * - Map permission modes ↔ approval policies
 * - Convert TurnSettings to Codex params
 * - Parse thread config into AdapterSettings
 * - Convert token usage to ContextUsage
 * - Transform MessageContent to UserInput[]
 *
 * Does NOT:
 * - Make RPC calls
 * - Manage session state
 */

import type { AdapterSettings, TurnSettings } from '../../agent-adapter.js';
import type { ContextUsage, MessageContent, MessageContentBlock } from '../../transcript.js';
import type { AskForApproval } from './protocol/v2/AskForApproval.js';
import type { UserInput } from './protocol/v2/UserInput.js';

// ============================================================================
// Permission Mode ↔ Approval Policy Mapping
// ============================================================================

/**
 * Map Crispy permissionMode → Codex approvalPolicy.
 *
 * | Crispy permissionMode | → Codex approvalPolicy |
 * |---|---|
 * | 'default' | 'on-request' |
 * | 'acceptEdits' | 'on-failure' |
 * | 'bypassPermissions' | 'never' |
 * | 'plan' | 'on-request' |
 */
export function mapPermissionMode(mode: string): AskForApproval {
  switch (mode) {
    case 'default':
      return 'on-request';
    case 'acceptEdits':
      return 'on-failure';
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
 * | 'on-request' | 'default' |
 * | 'on-failure' | 'acceptEdits' |
 * | 'never' | 'bypassPermissions' |
 * | 'untrusted' | 'default' (closest match) |
 */
export function mapApprovalPolicy(policy: string): TurnSettings['permissionMode'] {
  switch (policy) {
    case 'on-request':
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
export function mapThreadConfig(response: Record<string, unknown>): AdapterSettings {
  const approvalPolicy = response.approvalPolicy as string | undefined;
  const model = response.model as string | undefined;

  return {
    vendor: 'codex',
    model,
    permissionMode: approvalPolicy ? mapApprovalPolicy(approvalPolicy) : undefined,
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
 * Expected usage shape from thread/tokenUsage/updated notification:
 * ```json
 * {
 *   "tokenUsage": {
 *     "total": {
 *       "totalTokens": 8447,
 *       "inputTokens": 8422,
 *       "cachedInputTokens": 7552,
 *       "outputTokens": 25,
 *       "reasoningOutputTokens": 14
 *     },
 *     "modelContextWindow": 258400
 *   }
 * }
 * ```
 */
export function mapTokenUsage(usage: Record<string, unknown>): ContextUsage {
  // Handle both nested (from notification params) and direct shape
  const tokenUsage = (usage.tokenUsage ?? usage) as Record<string, unknown>;
  const total = (tokenUsage.total ?? {}) as Record<string, number>;
  const modelContextWindow = (tokenUsage.modelContextWindow as number) ?? 200000;

  const inputTokens = total.inputTokens ?? 0;
  const outputTokens = total.outputTokens ?? 0;
  const cachedInputTokens = total.cachedInputTokens ?? 0;
  const totalTokens = total.totalTokens ?? (inputTokens + outputTokens);

  return {
    tokens: {
      input: inputTokens,
      output: outputTokens,
      cacheCreation: 0,  // Codex doesn't report cache creation tokens
      cacheRead: cachedInputTokens,
    },
    totalTokens,
    contextWindow: modelContextWindow,
    contextWindowSource: 'sdk',
    percent: Math.min(Math.round((totalTokens / modelContextWindow) * 100), 100),
    // totalCostUsd: omitted — Codex doesn't provide cost information
  };
}

// ============================================================================
// Message Content → UserInput[]
// ============================================================================

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
 */
export function mapMessageContent(content: MessageContent): UserInput[] {
  // String input → single text element
  if (typeof content === 'string') {
    return [{
      type: 'text',
      text: content,
      text_elements: [],
    }];
  }

  // Array of content blocks
  return content.map((block): UserInput => {
    if (block.type === 'text') {
      return {
        type: 'text',
        text: block.text,
        text_elements: [],
      };
    }

    if (block.type === 'image') {
      // Convert base64 source to data URL format
      const imageBlock = block as MessageContentBlock & { type: 'image' };
      const { media_type, data } = imageBlock.source;
      return {
        type: 'image',
        url: `data:${media_type};base64,${data}`,
      };
    }

    // Fallback for unknown block types — treat as text if possible
    return {
      type: 'text',
      text: JSON.stringify(block),
      text_elements: [],
    };
  });
}
