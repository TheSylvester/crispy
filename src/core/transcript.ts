/**
 * Universal Transcript Format
 *
 * Defines the canonical transcript format based on Claude's Agent SDK.
 * Other vendors (Codex, Gemini) adapt to these types.
 *
 * Key principles:
 * - Claude's field names and structures are canonical
 * - Tool inputs/outputs match the official Agent SDK types
 * - Vendor-specific extensions go in `metadata` bags
 *
 * @see https://platform.claude.com/docs/en/agent-sdk/typescript
 * @module transcript
 */

// Re-export SDK types for convenience
// Consumers can import from here instead of the SDK directly
export type {
  AgentInput,
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  NotebookEditInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
  AskUserQuestionInput,
  ExitPlanModeInput,
  TaskOutputInput,
  TaskStopInput,
  ListMcpResourcesInput,
  ReadMcpResourceInput,
  ConfigInput,
} from '@anthropic-ai/claude-agent-sdk/sdk-tools.js';

// Import for internal use
import type {
  AgentInput,
  BashInput,
  FileEditInput,
  FileReadInput,
  FileWriteInput,
  GlobInput,
  GrepInput,
  NotebookEditInput,
  TodoWriteInput,
  WebFetchInput,
  WebSearchInput,
  AskUserQuestionInput,
  ExitPlanModeInput,
  TaskOutputInput,
  TaskStopInput,
  ListMcpResourcesInput,
  ReadMcpResourceInput,
  ConfigInput,
} from '@anthropic-ai/claude-agent-sdk/sdk-tools.js';

// ============================================================================
// Vendor
// ============================================================================

/** Native vendors with compile-time exhaustive checks. */
export type NativeVendor = 'claude' | 'codex' | 'gemini';

/** Vendor identifier. Native vendors are literals; dynamic providers are arbitrary slugs. */
export type Vendor = NativeVendor | (string & {});

/** Runtime set of native vendor slugs. */
export const NATIVE_VENDORS = new Set<string>(['claude', 'codex', 'gemini']);

/** Type guard for native vendors. */
export function isNativeVendor(v: string): v is NativeVendor {
  return NATIVE_VENDORS.has(v);
}

// ============================================================================
// Entry Types
// ============================================================================

export type EntryType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'result'           // SDK turn completion (success/error)
  | 'stream_event'     // SDK partial streaming delta
  | 'summary'
  | 'progress'
  | 'queue-operation'
  | 'file-history-snapshot';

// ============================================================================
// Transcript Entry
// ============================================================================

export interface TranscriptEntry {
  type: EntryType;

  // Identity & tree structure
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  timestamp?: string;

  // Vendor
  vendor?: Vendor;

  // Message content
  message?: TranscriptMessage;

  // Sub-agent
  isSidechain?: boolean;
  agentId?: string;
  /** Links sub-agent entries to their parent Task tool_use_id */
  parentToolUseID?: string;

  // Working directory
  cwd?: string;

  // Structured tool result (for rich rendering)
  toolUseResult?: ToolResult;

  // Session display
  isMeta?: boolean;
  customTitle?: string;

  // Summary entries
  summary?: string;
  leafUuid?: string;

  // Tool result linking (Claude-specific, others use parentUuid traversal)
  sourceToolAssistantUuid?: string;

  // Vendor-specific extensions
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Message
// ============================================================================

export interface TranscriptMessage {
  role?: 'user' | 'assistant' | 'system' | 'tool';
  content: string | ContentBlock[];
  model?: string;
  usage?: Usage;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Content Blocks
// ============================================================================

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
  isSummary?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: ToolName | string;  // Known tools or MCP/custom tools
  input: ToolInput;
  label?: string;
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
  label?: string;
}

export interface ImageBlock {
  type: 'image';
  source: {
    type: string;
    media_type?: string;
    data?: string;
  };
}

// ============================================================================
// Message Content (Input-Only Subset)
// ============================================================================

/**
 * Content block for user-sent (input) messages.
 *
 * This is an input-only subset of {@link ContentBlock}:
 * - `ContentBlock` = full output content (text, thinking, tool_use, tool_result, image) — what agents produce
 * - `MessageContentBlock` = input-only subset (text, image) — what users send to agents
 */
export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };

/**
 * Message content type: either a plain string or an array of content blocks
 * for multimodal messages (text + images).
 */
export type MessageContent = string | MessageContentBlock[];

// ============================================================================
// Tool Names — Claude's canonical tool names
// ============================================================================

export type ToolName =
  // File operations
  | 'Read'
  | 'Write'
  | 'Edit'
  | 'MultiEdit'
  | 'Glob'
  | 'Grep'
  | 'LS'
  | 'NotebookEdit'
  // Execution
  | 'Bash'
  | 'TaskOutput'
  | 'TaskStop'
  // Agents
  | 'Task'
  // Web
  | 'WebFetch'
  | 'WebSearch'
  // Planning & interaction
  | 'TodoWrite'
  | 'AskUserQuestion'
  | 'EnterPlanMode'
  | 'ExitPlanMode'
  | 'Skill'
  // MCP
  | 'ListMcpResources'
  | 'ReadMcpResource';

// ============================================================================
// Tool Inputs — Union type matching SDK's ToolInputSchemas
// ============================================================================

export type ToolInput =
  | AgentInput           // Task tool
  | BashInput
  | TaskOutputInput
  | TaskStopInput
  | FileEditInput        // Edit tool
  | FileReadInput        // Read tool
  | FileWriteInput       // Write tool
  | GlobInput
  | GrepInput
  | NotebookEditInput
  | TodoWriteInput
  | WebFetchInput
  | WebSearchInput
  | AskUserQuestionInput
  | ExitPlanModeInput
  | ListMcpResourcesInput
  | ReadMcpResourceInput
  | ConfigInput
  | Record<string, unknown>;  // MCP/custom tools

// ============================================================================
// Tool Results — from JSONL format (what Claude writes to transcripts)
// ============================================================================

export type ToolResult =
  | string  // Error case (raw error message)
  | ReadResult
  | WriteResult
  | EditResult
  | BashResult
  | GlobResult
  | GrepResult
  | TaskResult
  | WebFetchResult
  | WebSearchResult
  | Record<string, unknown>;  // MCP/custom tools

// Read result — matches Claude JSONL toolUseResult for Read
export interface ReadResult {
  type: 'text';
  file: {
    filePath: string;
    content: string;
    numLines: number;
    startLine: number;
    totalLines: number;
  };
}

// Write result — matches Claude JSONL toolUseResult for Write
export interface WriteResult {
  type: 'create';
  filePath: string;
  content: string;
  structuredPatch?: unknown[];
  originalFile: string | null;
}

// Edit result — matches Claude JSONL toolUseResult for Edit
export interface EditResult {
  type: 'edit';
  filePath: string;
  oldString: string;
  newString: string;
  originalFile: string;
  structuredPatch?: unknown[];
  userModified?: boolean;
  replaceAll?: boolean;
}

// Bash result — from JSONL
export interface BashResult {
  output: string;
  exitCode: number;
  killed?: boolean;
  shellId?: string;
}

// Glob result — from JSONL
export interface GlobResult {
  matches: string[];
  count: number;
  search_path: string;
}

// Grep result — from JSONL (content mode)
export interface GrepResult {
  matches: Array<{
    file: string;
    line_number?: number;
    line: string;
    before_context?: string[];
    after_context?: string[];
  }>;
  total_matches: number;
}

// Task result — matches Claude JSONL toolUseResult for Task
export interface TaskResult {
  status: string;
  prompt: string;
  agentId: string;
  content: ContentBlock[];
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: Record<string, unknown>;
  subagentType?: string;
}

// WebFetch result — from JSONL
export interface WebFetchResult {
  response: string;
  url: string;
  final_url?: string;
  status_code?: number;
}

// WebSearch result — from JSONL
export interface WebSearchResult {
  results: Array<{
    title: string;
    url: string;
    snippet: string;
    metadata?: Record<string, unknown>;
  }>;
  total_results: number;
  query: string;
}

// ============================================================================
// Tool Categories
// ============================================================================

/**
 * Normalized tool categories for consistent UI rendering across vendors.
 * Used by the frontend to dispatch icons, colors, and specialized renderers.
 */
export type ToolCategory =
  | 'file_read'   // Read file contents
  | 'file_write'  // Create new file
  | 'file_edit'   // Modify existing file
  | 'shell'       // Command execution (Bash)
  | 'search'      // Content/file search (Grep, Glob, WebSearch)
  | 'agent'       // Sub-agent tasks (Task)
  | 'browser'     // Web fetching (WebFetch)
  | 'notebook'    // Jupyter notebook operations
  | 'planning'    // Planning tools (TodoWrite, ExitPlanMode, EnterPlanMode)
  | 'interaction' // User interaction (AskUserQuestion, Skill)
  | 'mcp'         // MCP tool calls
  | 'other';      // Fallback for unrecognized tools

/** Claude Code tool name → universal category */
export const CLAUDE_TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: 'file_read',
  Write: 'file_write',
  Edit: 'file_edit',
  MultiEdit: 'file_edit',
  Bash: 'shell',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  Task: 'agent',
  TaskOutput: 'agent',
  TaskStop: 'agent',
  WebFetch: 'browser',
  WebSearch: 'search',
  NotebookEdit: 'notebook',
  TodoWrite: 'planning',
  EnterPlanMode: 'planning',
  ExitPlanMode: 'planning',
  AskUserQuestion: 'interaction',
  Skill: 'interaction',
  ListMcpResources: 'mcp',
  ReadMcpResource: 'mcp',
};

/**
 * Resolve a tool name to its universal category.
 *
 * For MCP tools (prefixed with 'mcp__'), returns 'mcp'.
 * For known tools, looks up in vendor-specific maps.
 * Falls back to 'other' for unrecognized tools.
 */
export function resolveToolCategory(
  toolName: string,
  vendor: Vendor = 'claude'
): ToolCategory {
  // MCP tools are prefixed with 'mcp__'
  if (toolName.startsWith('mcp__')) {
    return 'mcp';
  }

  return CLAUDE_TOOL_CATEGORIES[toolName] ?? 'other';
}

// ============================================================================
// Usage — token consumption stats
// ============================================================================

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_tokens?: number;
  reasoning_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
  service_tier?: string;
  metadata?: Record<string, unknown>;
}

/** Cumulative context window utilization for a session. */
export interface ContextUsage {
  /** Token breakdown from the most recent assistant turn */
  tokens: {
    input: number;
    output: number;
    cacheCreation: number;
    cacheRead: number;
  };
  /** Sum of all token fields */
  totalTokens: number;
  /** Model's context window size in tokens */
  contextWindow: number;
  /** Where the contextWindow value came from */
  contextWindowSource: 'sdk' | 'default';
  /** Percentage of context used (0–100, capped) */
  percent: number;
  /** Total session cost in USD (from SDK result messages) */
  totalCostUsd?: number;
}

// ============================================================================
// Adapter Interface
// ============================================================================

export interface TranscriptAdapter {
  readonly vendor: Vendor;
  loadEntries(sessionPath: string): Promise<TranscriptEntry[]>;
}

// ============================================================================
// Type Guards
// ============================================================================

// --- Tool Input Type Guards ---

export function isFileReadInput(input: ToolInput): input is FileReadInput {
  return 'file_path' in input &&
         !('content' in input) &&
         !('old_string' in input) &&
         !('edits' in input);
}

export function isFileWriteInput(input: ToolInput): input is FileWriteInput {
  return 'file_path' in input &&
         'content' in input &&
         typeof (input as FileWriteInput).content === 'string' &&
         !('old_string' in input);
}

export function isFileEditInput(input: ToolInput): input is FileEditInput {
  return 'file_path' in input &&
         'old_string' in input &&
         'new_string' in input;
}

export function isBashInput(input: ToolInput): input is BashInput {
  return 'command' in input && typeof (input as BashInput).command === 'string';
}

export function isGlobInput(input: ToolInput): input is GlobInput {
  return 'pattern' in input &&
         !('output_mode' in input) &&
         !('type' in input) &&
         !('-A' in input) &&
         !('-B' in input) &&
         !('-C' in input) &&
         !('glob' in input);
}

export function isGrepInput(input: ToolInput): input is GrepInput {
  return 'pattern' in input &&
         ('output_mode' in input || 'type' in input || '-A' in input || '-B' in input || '-C' in input || 'glob' in input);
}

export function isAgentInput(input: ToolInput): input is AgentInput {
  return 'prompt' in input &&
         'subagent_type' in input &&
         'description' in input;
}

export function isTodoWriteInput(input: ToolInput): input is TodoWriteInput {
  return 'todos' in input && Array.isArray((input as TodoWriteInput).todos);
}

export function isWebFetchInput(input: ToolInput): input is WebFetchInput {
  return 'url' in input && 'prompt' in input && !('subagent_type' in input);
}

export function isWebSearchInput(input: ToolInput): input is WebSearchInput {
  return 'query' in input && !('url' in input);
}

// --- Tool Result Type Guards ---

export function isReadResult(result: ToolResult): result is ReadResult {
  return typeof result === 'object' &&
         result !== null &&
         'type' in result &&
         result.type === 'text' &&
         'file' in result;
}

export function isWriteResult(result: ToolResult): result is WriteResult {
  return typeof result === 'object' &&
         result !== null &&
         'type' in result &&
         result.type === 'create';
}

export function isEditResult(result: ToolResult): result is EditResult {
  return typeof result === 'object' &&
         result !== null &&
         'type' in result &&
         result.type === 'edit';
}

export function isBashResult(result: ToolResult): result is BashResult {
  return typeof result === 'object' &&
         result !== null &&
         'output' in result &&
         'exitCode' in result &&
         typeof (result as BashResult).exitCode === 'number';
}

export function isGlobResult(result: ToolResult): result is GlobResult {
  return typeof result === 'object' &&
         result !== null &&
         'matches' in result &&
         'count' in result &&
         'search_path' in result;
}

export function isGrepResult(result: ToolResult): result is GrepResult {
  return typeof result === 'object' &&
         result !== null &&
         'matches' in result &&
         'total_matches' in result &&
         !('search_path' in result);
}

export function isTaskResult(result: ToolResult): result is TaskResult {
  return typeof result === 'object' &&
         result !== null &&
         'status' in result &&
         'agentId' in result &&
         'content' in result;
}

export function isWebFetchResult(result: ToolResult): result is WebFetchResult {
  return typeof result === 'object' &&
         result !== null &&
         'response' in result &&
         'url' in result;
}

export function isWebSearchResult(result: ToolResult): result is WebSearchResult {
  return typeof result === 'object' &&
         result !== null &&
         'results' in result &&
         'total_results' in result &&
         'query' in result;
}

export function isErrorResult(result: ToolResult): result is string {
  return typeof result === 'string';
}

// --- Additional Input Type Guards (for tool rendering) ---

export function isAskUserQuestionInput(input: ToolInput): input is AskUserQuestionInput {
  return 'questions' in input && Array.isArray((input as AskUserQuestionInput).questions);
}

export function isExitPlanModeInput(input: ToolInput): input is ExitPlanModeInput {
  // ExitPlanMode has optional allowedPrompts array, so minimal check
  return typeof input === 'object' && input !== null && !('command' in input) && !('file_path' in input) && !('pattern' in input) && !('skill' in input) && !('query' in input);
}

export function isSkillInput(input: ToolInput): input is { skill: string; args?: string } {
  return 'skill' in input && typeof (input as { skill: string }).skill === 'string';
}

