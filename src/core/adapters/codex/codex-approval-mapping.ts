/**
 * codex-approval-mapping.ts
 *
 * Bidirectional mapping between Codex approval protocol and Crispy approval events.
 *
 * Responsibilities:
 * - Convert Codex server approval requests to Crispy AwaitingApprovalEvent fields
 * - Convert Crispy user responses back to Codex decision format
 *
 * Does NOT:
 * - Send/receive messages (adapter handles transport)
 * - Track pending approvals (adapter manages state)
 */

import type { ApprovalOption } from '../../channel-events.js';

// ============================================================================
// Codex Approval Method Constants
// ============================================================================

/** Server request method for command execution approval. */
export const COMMAND_APPROVAL_METHOD = 'item/commandExecution/requestApproval';
/** Server request method for file change (patch) approval. */
export const FILE_CHANGE_APPROVAL_METHOD = 'item/fileChange/requestApproval';
/** Server request method for user input (elicitation). */
export const USER_INPUT_METHOD = 'item/tool/requestUserInput';

// ============================================================================
// Forward Mapping: Codex Server Request -> Crispy Approval Event
// ============================================================================

/** Result of converting a Codex approval request to Crispy event fields. */
export interface CodexApprovalEventFields {
  toolUseId: string;
  toolName: string;
  input: unknown;
  reason?: string;
  options: ApprovalOption[];
  /** Stashed for response — amendment data from the original request. */
  proposedAmendment?: unknown;
}

/**
 * Standard approval options for command/file change approvals.
 * These map to Codex's ReviewDecision variants.
 */
const STANDARD_APPROVAL_OPTIONS: ApprovalOption[] = [
  { id: 'allow', label: 'Allow once' },
  { id: 'allow_session', label: 'Always allow', description: 'Remember this permission' },
  { id: 'deny', label: 'Deny' },
];

/**
 * Convert a Codex server approval request to Crispy approval event fields.
 *
 * @param method - The server request method (e.g., 'item/commandExecution/requestApproval')
 * @param params - The request parameters from the server
 * @returns Approval event fields for Crispy, or null if method is not recognized
 */
export function codexApprovalToEvent(
  method: string,
  params: Record<string, unknown>,
): CodexApprovalEventFields | null {
  switch (method) {
    case COMMAND_APPROVAL_METHOD:
      return mapCommandApproval(params);
    case FILE_CHANGE_APPROVAL_METHOD:
      return mapFileChangeApproval(params);
    case USER_INPUT_METHOD:
      return mapUserInputRequest(params);
    default:
      return null;
  }
}

/**
 * Map command execution approval request.
 *
 * Server request shape:
 * ```json
 * {
 *   "itemId": "call_xxx",
 *   "command": "/bin/bash -lc \"pwd\"",
 *   "cwd": "/path/to/dir",
 *   "reason": "Do you want to allow...",
 *   "commandActions": [...],
 *   "proposedExecpolicyAmendment": ["/bin/bash", "-lc", "pwd"]
 * }
 * ```
 */
function mapCommandApproval(params: Record<string, unknown>): CodexApprovalEventFields {
  const itemId = params.itemId as string;
  const command = params.command as string;
  const cwd = params.cwd as string;
  const reason = params.reason as string | undefined;
  const proposedAmendment = params.proposedExecpolicyAmendment as unknown;

  return {
    toolUseId: itemId,
    toolName: 'Bash',
    input: { command, cwd },
    reason: reason ?? undefined,
    options: [...STANDARD_APPROVAL_OPTIONS],
    proposedAmendment,
  };
}

/**
 * Map file change (patch) approval request.
 *
 * Server request shape:
 * ```json
 * {
 *   "itemId": "call_xxx",
 *   "changes": { "/path/to/file": { "type": "update", "unified_diff": "..." } },
 *   "reason": "..."
 * }
 * ```
 */
function mapFileChangeApproval(params: Record<string, unknown>): CodexApprovalEventFields {
  const itemId = params.itemId as string;
  const changes = params.changes as Record<string, unknown> | undefined;
  const reason = params.reason as string | undefined;

  return {
    toolUseId: itemId,
    toolName: 'Edit',
    input: { changes },
    reason: reason ?? undefined,
    options: [...STANDARD_APPROVAL_OPTIONS],
  };
}

/**
 * Map user input request (elicitation).
 *
 * Server request shape:
 * ```json
 * {
 *   "itemId": "call_xxx",
 *   "message": "Please provide...",
 *   "commandActions": [{ "text": "Yes", "command": "yes" }, ...]
 * }
 * ```
 *
 * If commandActions are provided, convert them to options.
 * Otherwise, use simple confirm/cancel.
 */
function mapUserInputRequest(params: Record<string, unknown>): CodexApprovalEventFields {
  const itemId = params.itemId as string ?? params.id as string;
  const message = params.message as string | undefined;
  const commandActions = params.commandActions as Array<{ text: string; command: string }> | undefined;

  // Build options from commandActions if available
  let options: ApprovalOption[];
  if (commandActions && commandActions.length > 0) {
    options = commandActions.map((action) => ({
      id: action.command,
      label: action.text,
    }));
  } else {
    // Default confirm/cancel for user input without explicit actions
    options = [
      { id: 'confirm', label: 'Confirm' },
      { id: 'cancel', label: 'Cancel' },
    ];
  }

  return {
    toolUseId: itemId,
    toolName: 'AskUserQuestion',
    input: params,
    reason: message,
    options,
  };
}

// ============================================================================
// Reverse Mapping: Crispy User Response -> Codex Decision
// ============================================================================

/** Extra data passed with user response. */
export interface ResponseExtra {
  message?: string;
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
}

/**
 * Convert a Crispy user response to a Codex decision object.
 *
 * The returned object is sent as the JSON-RPC result to the server's
 * request (identified by the original request's `id`).
 *
 * @param method - The original server request method
 * @param optionId - The user's chosen option ID
 * @param extra - Optional extra data (message, updatedInput, etc.)
 * @param stashedAmendment - The proposedAmendment from the original request
 * @returns Codex decision object to send as response
 */
export function crispyResponseToCodexDecision(
  method: string,
  optionId: string,
  extra?: ResponseExtra,
  stashedAmendment?: unknown,
): Record<string, unknown> {
  // User input requests have different response format
  if (method === USER_INPUT_METHOD) {
    return mapUserInputResponse(extra);
  }

  // Command and file change approvals use ReviewDecision
  return mapReviewDecision(method, optionId, stashedAmendment);
}

/**
 * Map Crispy option to Codex ReviewDecision.
 *
 * Wire format decision variants:
 * - "accept" - Allow once
 * - { acceptWithExecpolicyAmendment: { execpolicy_amendment: [...] } } - Always allow (command with amendment)
 * - "acceptForSession" - Always allow (fallback)
 * - "decline" - Deny
 * - "cancel" - Cancel/abort turn
 */
function mapReviewDecision(
  method: string,
  optionId: string,
  amendment?: unknown,
): Record<string, unknown> {
  switch (optionId) {
    case 'allow':
      return { decision: 'accept' };

    case 'allow_session':
      // For command execution, if we have a stashed amendment, use it
      if (method === COMMAND_APPROVAL_METHOD && amendment) {
        return {
          decision: {
            acceptWithExecpolicyAmendment: {
              execpolicy_amendment: amendment,
            },
          },
        };
      }
      // Fallback to session-level approval
      return { decision: 'acceptForSession' };

    case 'deny':
      return { decision: 'decline' };

    case 'abort':
      return { decision: 'cancel' };

    default:
      // Unknown option ID — treat as decline for safety
      return { decision: 'decline' };
  }
}

/**
 * Map user input response.
 *
 * For user input requests, we pass extra.updatedInput as the response.
 */
function mapUserInputResponse(extra?: ResponseExtra): Record<string, unknown> {
  // Return updatedInput if provided
  if (extra?.updatedInput) {
    return extra.updatedInput;
  }

  // Return empty object if no input provided
  return {};
}

// ============================================================================
// Utility: Check if a method is an approval request
// ============================================================================

/** All approval request methods. */
const APPROVAL_METHODS = new Set([
  COMMAND_APPROVAL_METHOD,
  FILE_CHANGE_APPROVAL_METHOD,
  USER_INPUT_METHOD,
]);

/**
 * Check if a server request method is an approval request.
 *
 * @param method - The server request method
 * @returns true if the method requires user approval
 */
export function isApprovalRequest(method: string): boolean {
  return APPROVAL_METHODS.has(method);
}
