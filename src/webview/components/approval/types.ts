/**
 * Approval Types — shared type definitions for approval components
 *
 * Webview-side types that mirror the core channel events but are
 * scoped to approval rendering. Tool input shapes for structured
 * approvals (AskUserQuestion, ExitPlanMode) are typed here.
 *
 * @module approval/types
 */

import type { ApprovalOption } from '../../../core/channel-events.js';

/** Webview-side approval request (from SubscriberEvent). */
export interface ApprovalRequest {
  toolUseId: string;
  toolName: string;
  input: unknown;
  reason?: string;
  options: ApprovalOption[];
}

/** AskUserQuestion tool input shape. */
export interface AskUserQuestionInput {
  questions: AskUserQuestionItem[];
  answers?: Record<string, string>;
}

export interface AskUserQuestionItem {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}

/** ExitPlanMode tool input shape. */
export interface ExitPlanModeInput {
  allowedPrompts?: Array<{ tool: string; prompt: string }>;
  pushToRemote?: boolean;
  remoteSessionId?: string;
  remoteSessionUrl?: string;
  plan?: string;
}
