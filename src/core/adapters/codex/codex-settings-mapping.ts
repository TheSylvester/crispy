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
 * Codex exposes cumulative `total` usage and per-turn `last` usage, but the
 * current app-server surface does not identify either field as compaction-aware
 * current context occupancy. Until it does, Crispy must not present this
 * payload as "context used".
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
export function mapTokenUsage(_usage: Record<string, unknown>): ContextUsage | null {
  return null;
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
