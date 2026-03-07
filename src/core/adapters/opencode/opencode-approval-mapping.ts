/**
 * opencode-approval-mapping.ts
 *
 * Bidirectional mapping between OpenCode permissions/questions and Crispy
 * approval events.
 *
 * Responsibilities:
 * - Convert OpenCode permission.updated events to Crispy AwaitingApprovalEvent fields
 * - Convert Crispy user responses back to OpenCode POST body format
 *
 * Does NOT:
 * - Send/receive messages (adapter handles transport)
 * - Track pending approvals (adapter manages state)
 */

import type { ApprovalOption } from '../../channel-events.js';
import type { Permission } from '@opencode-ai/sdk/client';

// ============================================================================
// Permission Type → Crispy Tool Name
// ============================================================================

/** Map OpenCode permission types to Crispy-style tool names. */
const PERMISSION_TOOL_MAP: Record<string, string> = {
  bash: 'Bash',
  edit: 'Edit',
  read: 'Read',
  write: 'Write',
  mcp: 'MCP',
};

function permissionToToolName(permissionType: string): string {
  return PERMISSION_TOOL_MAP[permissionType] ?? permissionType;
}

// ============================================================================
// Forward Mapping: OpenCode Permission → Crispy Approval Event
// ============================================================================

/** Result of converting an OpenCode permission to Crispy event fields. */
export interface OpenCodeApprovalEventFields {
  toolUseId: string;
  toolName: string;
  input: unknown;
  reason?: string;
  options: ApprovalOption[];
}

/**
 * Standard approval options for permission requests.
 * These map to OpenCode's "once" | "always" | "reject" replies.
 */
function buildPermissionOptions(permission: Permission): ApprovalOption[] {
  const options: ApprovalOption[] = [
    { id: 'allow', label: 'Allow once' },
    {
      id: 'allow_session',
      label: 'Always allow',
      ...(permission.pattern && {
        description: `Grants: ${Array.isArray(permission.pattern) ? permission.pattern.join(', ') : permission.pattern}`,
      }),
    },
    { id: 'deny', label: 'Deny' },
  ];
  return options;
}

/**
 * Convert an OpenCode permission.updated event to Crispy approval event fields.
 */
export function permissionToApprovalEvent(permission: Permission): OpenCodeApprovalEventFields {
  return {
    toolUseId: permission.id,
    toolName: permissionToToolName(permission.type),
    input: {
      ...permission.metadata,
      ...(permission.pattern && { pattern: permission.pattern }),
      ...(permission.callID && { callID: permission.callID }),
    },
    reason: permission.title,
    options: buildPermissionOptions(permission),
  };
}

// ============================================================================
// Reverse Mapping: Crispy Response → OpenCode POST Body
// ============================================================================

/**
 * Convert a Crispy user response to OpenCode permission reply body.
 *
 * @param optionId - The user's chosen option ID ('allow', 'allow_session', 'deny')
 * @param extra - Optional extra data (message for deny)
 * @returns Body for POST /session/:id/permissions/:permissionID
 */
export function crispyResponseToPermissionReply(
  optionId: string,
  _extra?: { message?: string },
): { response: 'once' | 'always' | 'reject' } {
  switch (optionId) {
    case 'allow':
      return { response: 'once' };
    case 'allow_session':
      return { response: 'always' };
    case 'deny':
      return { response: 'reject' };
    default:
      // Unknown option — treat as reject for safety
      return { response: 'reject' };
  }
}
