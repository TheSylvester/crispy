/**
 * Provenance Scanner — Extract file mutations from JSONL transcripts
 *
 * Scans Claude Code JSONL session files for Edit, Write, and Bash tool_uses
 * that mutate files or interact with git. Uses chunked byte-offset reading
 * for incremental scanning (same pattern as jsonl-reader.ts).
 *
 * Fast-path string filters avoid JSON.parse on irrelevant lines.
 *
 * @module provenance/scanner
 */

import * as fs from 'node:fs';
import { createHash } from 'node:crypto';
import type { RawMutation, GitCommitCommand, BashCategory, ScanResult } from './types.js';

const READ_BUFFER_SIZE = 256 * 1024; // 256KB chunks

// Pre-compiled regexes — avoid recompilation in hot loops
const RE_GIT_CMD = /\bgit\s/;
const RE_GIT_COMMIT = /\bgit\s+commit\b/;
const RE_GIT_BRANCH_OP = /\bgit\s+(checkout|rebase|merge|cherry-pick)\b/;
const RE_GIT_RESET = /\bgit\s+reset\b/;
const RE_GIT_READONLY = /\bgit\s+(status|log|diff|branch|show|stash|fetch|pull|push|remote|tag|blame|rev-parse|ls-files|describe|shortlog|reflog|config|init|clone|add|rm\s+--cached|restore\s+--staged)\b/;
const RE_SED_I = /\bsed\s+-i\b/;
const RE_RM = /\brm\s/;
const RE_RM_CACHED = /\brm\s+--cached\b/;
const RE_MV = /\bmv\s/;
const RE_AMEND = /--amend/;
const RE_COMMIT_MSG = /\bgit\s+commit\b.*?-m\s+(?:"([^"]*(?:\\.[^"]*)*)"|'([^']*)')/s;
const RE_HEREDOC = /<<\s*'?EOF'?\s*\n([\s\S]*?)\n\s*EOF/;

// ============================================================================
// Tool_use Extraction Helper
// ============================================================================

interface ExtractionContext {
  mutations: RawMutation[];
  gitCommitCommands: GitCommitCommand[];
}

/**
 * Extract mutations and git commit commands from a parsed JSONL entry's
 * content blocks. Shared between main loop and remainder handler.
 */
function extractToolUses(
  content: unknown[],
  timestamp: string | null,
  messageUuid: string | null,
  lineStartOffset: number,
  ctx: ExtractionContext,
): void {
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type !== 'tool_use') continue;

    const toolName = b.name as string;
    const input = (b.input || {}) as Record<string, unknown>;
    const toolUseId = (b.id as string) || `${lineStartOffset}-${toolName}`;

    if (toolName === 'Edit') {
      ctx.mutations.push({
        tool: 'Edit',
        filePath: (input.file_path as string) || null,
        timestamp,
        messageUuid,
        toolUseId,
        byteOffset: lineStartOffset,
        oldHash: input.old_string ? sha256(input.old_string as string) : undefined,
        newHash: input.new_string ? sha256(input.new_string as string) : undefined,
      });
    } else if (toolName === 'Write') {
      ctx.mutations.push({
        tool: 'Write',
        filePath: (input.file_path as string) || null,
        timestamp,
        messageUuid,
        toolUseId,
        byteOffset: lineStartOffset,
      });
    } else if (toolName === 'Bash') {
      const command = (input.command as string) || '';
      const classified = classifyBashCommand(command);
      if (!classified) continue;

      if (classified.category === 'git-commit') {
        ctx.gitCommitCommands.push({
          timestamp,
          messageUuid,
          toolUseId,
          byteOffset: lineStartOffset,
          command,
          extractedMessage: extractCommitMessage(command),
        });
      }

      ctx.mutations.push({
        tool: 'Bash',
        bashCategory: classified.category,
        filePath: classified.filePaths[0] || null,
        timestamp,
        messageUuid,
        toolUseId,
        byteOffset: lineStartOffset,
        command,
      });
    }
  }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Scan a JSONL transcript for file-mutating tool_uses.
 *
 * Returns mutations (Edit/Write/Bash file ops), git commit commands,
 * and metadata (sessionId, cwd) extracted from the file.
 */
export function scanProvenanceEntries(filepath: string, startOffset = 0): ScanResult {
  const ctx: ExtractionContext = { mutations: [], gitCommitCommands: [] };
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let fd: number | null = null;

  try {
    fd = fs.openSync(filepath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (startOffset >= fileSize) {
      return { ...ctx, offset: startOffset, sessionId, cwd };
    }

    const buffer = Buffer.alloc(READ_BUFFER_SIZE);
    let currentOffset = startOffset;
    let remainder = '';
    let lastCompleteLineOffset = startOffset;
    let lineStartOffset = startOffset;

    while (currentOffset < fileSize) {
      const chunkSize = Math.min(READ_BUFFER_SIZE, fileSize - currentOffset);
      const bytesRead = fs.readSync(fd, buffer, 0, chunkSize, currentOffset);
      if (bytesRead === 0) break;

      const chunk = remainder + buffer.toString('utf-8', 0, bytesRead);
      const lines = chunk.split('\n');
      remainder = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        const lineBytes = Buffer.byteLength(line, 'utf-8') + 1;

        if (!trimmed) {
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
          continue;
        }

        // Fast-path: must be assistant message with tool_use
        if (!trimmed.includes('"type":"assistant"')) {
          // But capture sessionId/cwd from any entry that has them
          if (!sessionId && trimmed.includes('"sessionId"')) {
            try {
              const entry = JSON.parse(trimmed);
              if (entry.sessionId) sessionId = entry.sessionId;
              if (entry.cwd) cwd = entry.cwd;
            } catch { /* skip */ }
          }
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
          continue;
        }

        // Fast-path: must contain Edit, Write, or Bash
        if (
          !trimmed.includes('"name":"Edit"') &&
          !trimmed.includes('"name":"Write"') &&
          !trimmed.includes('"name":"Bash"')
        ) {
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
          continue;
        }

        try {
          const entry = JSON.parse(trimmed);
          if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
          if (!cwd && entry.cwd) cwd = entry.cwd;

          const content = entry.message?.content;
          if (Array.isArray(content)) {
            extractToolUses(
              content,
              entry.timestamp || null,
              entry.uuid || null,
              lineStartOffset,
              ctx,
            );
          }

          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
        } catch {
          lineStartOffset += lineBytes;
          lastCompleteLineOffset = lineStartOffset;
        }
      }

      currentOffset += bytesRead;
    }

    // Handle remainder (final line without trailing newline)
    if (remainder.trim()) {
      const trimmed = remainder.trim();
      if (
        trimmed.includes('"type":"assistant"') &&
        (trimmed.includes('"name":"Edit"') ||
         trimmed.includes('"name":"Write"') ||
         trimmed.includes('"name":"Bash"'))
      ) {
        try {
          const entry = JSON.parse(trimmed);
          if (!sessionId && entry.sessionId) sessionId = entry.sessionId;
          if (!cwd && entry.cwd) cwd = entry.cwd;

          const content = entry.message?.content;
          if (Array.isArray(content)) {
            extractToolUses(
              content,
              entry.timestamp || null,
              entry.uuid || null,
              lineStartOffset,
              ctx,
            );
          }

          lastCompleteLineOffset += Buffer.byteLength(remainder, 'utf-8');
        } catch {
          // Incomplete JSON at EOF — don't advance offset
        }
      } else {
        lastCompleteLineOffset += Buffer.byteLength(remainder, 'utf-8');
      }
    }

    return { ...ctx, offset: lastCompleteLineOffset, sessionId, cwd };
  } catch {
    return { mutations: [], gitCommitCommands: [], offset: startOffset, sessionId: null, cwd: null };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

// ============================================================================
// Bash Command Classification
// ============================================================================

interface BashClassification {
  category: BashCategory;
  filePaths: string[];
}

/** Check if a command is a git commit */
export function isGitCommitCommand(cmd: string): boolean {
  return RE_GIT_COMMIT.test(cmd);
}

/** Extract commit message from a git commit command */
export function extractCommitMessage(cmd: string): string | null {
  // Heredoc pattern first — -m "$(cat <<'EOF'\n...\nEOF\n)"
  // Must check before -m because RE_COMMIT_MSG's [^"]* greedily captures
  // the entire heredoc construct as a single string (garbage).
  const heredoc = cmd.match(RE_HEREDOC);
  if (heredoc) return heredoc[1]?.trim() ?? null;

  // -m "message" or -m 'message'
  const mFlag = cmd.match(RE_COMMIT_MSG);
  if (mFlag) {
    const msg = mFlag[1] ?? mFlag[2] ?? null;
    // Reject subshell captures that slipped through (e.g., "$(...")
    if (msg && !msg.startsWith('$(')) return msg;
  }

  // --amend without -m — no extractable message
  if (RE_AMEND.test(cmd)) return null;

  return null;
}

/**
 * Classify a Bash command for provenance tracking.
 * Returns null for read-only or irrelevant commands.
 */
export function classifyBashCommand(cmd: string): BashClassification | null {
  const trimmed = cmd.trim();

  // Skip empty commands
  if (!trimmed) return null;

  // Git commands
  if (RE_GIT_CMD.test(trimmed)) {
    if (RE_GIT_COMMIT.test(trimmed)) {
      return { category: 'git-commit', filePaths: [] };
    }
    if (RE_GIT_BRANCH_OP.test(trimmed)) {
      return { category: 'git-branch-op', filePaths: [] };
    }
    if (RE_GIT_RESET.test(trimmed)) {
      return { category: 'git-reset', filePaths: [] };
    }
    // Read-only git commands — skip
    if (RE_GIT_READONLY.test(trimmed)) {
      return null;
    }
    // Other git commands — skip by default
    return null;
  }

  // sed -i
  if (RE_SED_I.test(trimmed)) {
    const paths = extractSedPaths(trimmed);
    return { category: 'file-mutation', filePaths: paths };
  }

  // rm (but not rm --cached)
  if (RE_RM.test(trimmed) && !RE_RM_CACHED.test(trimmed)) {
    const paths = extractRmPaths(trimmed);
    if (paths.length > 0) return { category: 'file-deletion', filePaths: paths };
  }

  // mv
  if (RE_MV.test(trimmed)) {
    const paths = extractMvPaths(trimmed);
    if (paths.length > 0) return { category: 'file-rename', filePaths: paths };
  }

  return null;
}

// ============================================================================
// File Path Extraction Helpers
// ============================================================================

/** Extract file paths from sed -i command (last non-flag argument) */
function extractSedPaths(cmd: string): string[] {
  // Split by pipes/semicolons — only process the sed part
  const sedPart = cmd.split(/[|;]/).find(p => RE_SED_I.test(p));
  if (!sedPart) return [];

  // Remove the sed command and flags, take remaining non-flag args
  const args = splitArgs(sedPart.trim());
  const nonFlagArgs: string[] = [];
  let skipNext = false;

  for (let i = 0; i < args.length; i++) {
    if (skipNext) { skipNext = false; continue; }
    if (args[i] === 'sed' || args[i] === '-i') continue;
    if (args[i]?.startsWith('-')) {
      // Some flags take a value
      if (args[i] === '-e' || args[i] === '-f') skipNext = true;
      continue;
    }
    nonFlagArgs.push(args[i]!);
  }

  // Last non-flag args are file paths (first is the expression)
  return nonFlagArgs.slice(1);
}

/** Extract file paths from rm command */
function extractRmPaths(cmd: string): string[] {
  const args = splitArgs(cmd.trim());
  const paths: string[] = [];

  let pastCommand = false;
  for (const arg of args) {
    if (!pastCommand) {
      if (arg === 'rm') { pastCommand = true; continue; }
      continue;
    }
    if (arg.startsWith('-')) continue;
    paths.push(arg);
  }

  return paths;
}

/** Extract src and dst from mv command */
function extractMvPaths(cmd: string): string[] {
  const args = splitArgs(cmd.trim());
  const paths: string[] = [];

  let pastCommand = false;
  for (const arg of args) {
    if (!pastCommand) {
      if (arg === 'mv') { pastCommand = true; continue; }
      continue;
    }
    if (arg.startsWith('-')) continue;
    paths.push(arg);
  }

  // mv src dst — return both
  return paths.slice(-2);
}

/** Simple argument splitter respecting quotes */
function splitArgs(cmd: string): string[] {
  const args: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (const ch of cmd) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (ch === ' ' && !inSingle && !inDouble) {
      if (current) args.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) args.push(current);
  return args;
}

/** SHA-256 hash helper */
function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
