/**
 * Rosie Bot Hook — Independent summarize + persistent tracker subsystems
 *
 * Two independent subsystems registered on onResponseCompleteAfter:
 *
 *   Rosie.summarize — Stateless. Dispatches a fresh child session per turn,
 *     extracts XML (goal/title/summary/status), writes rosie-meta, discards.
 *
 *   Rosie.tracker — Persistent observer. Dispatches a child session on first
 *     turn, resumes it on every subsequent turn with stripped turn content +
 *     current project state. Fresh start on error or session reopen.
 *
 * @module rosie/rosie-bot-hook
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { onResponseCompleteAfter } from '../lifecycle-hooks.js';
import type { AgentDispatch } from '../../host/agent-dispatch.js';
import { getSettingsSnapshotInternal } from '../settings/index.js';
import { parseModelOption, getContextWindowTokens } from '../model-utils.js';
import type { Vendor, TranscriptEntry, ContentBlock } from '../transcript.js';
import { appendActivityEntries, getLatestRosieMeta, getAllRosieMetas } from '../activity-index.js';
import { refreshAndNotify } from '../session-list-manager.js';
import { closeSession } from '../session-manager.js';
import { pushRosieLog } from './debug-log.js';
import { extractTag } from './xml-utils.js';
import { getProjectsForPrompt, recordTrackerOutcome, runDedupSweep } from './tracker/db-writer.js';
import { pushTrackerNotification } from './tracker/tracker-notifications.js';
import { buildInternalMcpConfig } from '../../mcp/servers/external.js';
import type { TrackerDecision } from '../../mcp/servers/internal.js';
import type { InternalServerPaths } from './tracker/types.js';
import { VALID_STAGES, VALID_TYPES } from './tracker/types.js';
import { readSessionMessages, getSessionMessageCount, inferRole } from '../recall/message-store.js';

// ============================================================================
// Module State
// ============================================================================

let dispatch: AgentDispatch | null = null;
let serverPaths: InternalServerPaths | null = null;
const unsubscribers: Array<() => void> = [];

// Summarize concurrency guard — one per parent session
const summarizeInflight = new Set<string>();

// Tracker state — persistent session per parent, turn counter
const trackerSessions = new Map<string, string>();  // parentSessionId → trackerChildSessionId
const trackerTurnCounts = new Map<string, number>(); // parentSessionId → turn number
const trackerDecisionsFiles = new Map<string, string>(); // parentSessionId → decisions file path
const trackerInflight = new Set<string>();            // concurrency guard

// ============================================================================
// Lifecycle
// ============================================================================

export function initRosieBot(d: AgentDispatch, paths: InternalServerPaths): void {
  dispatch = d;
  serverPaths = paths;
  initRosieSummarize(d, paths);
  initRosieTracker(d, paths);
}

export function shutdownRosieBot(): void {
  for (const unsub of unsubscribers) unsub();
  unsubscribers.length = 0;
  dispatch = null;
  serverPaths = null;
  // Close all live tracker child sessions before clearing state
  for (const [parentId] of trackerSessions) {
    evictTrackerSession(parentId);
  }
  // Clean up any remaining decisions files
  for (const file of trackerDecisionsFiles.values()) {
    try { unlinkSync(file); } catch { /* best-effort */ }
  }
  trackerDecisionsFiles.clear();
}

// ============================================================================
// Rosie.summarize — Stateless XML extraction
// ============================================================================

function initRosieSummarize(d: AgentDispatch, _paths: InternalServerPaths): void {
  const unsub = onResponseCompleteAfter(async (sessionId: string) => {
    if (!dispatch) return;
    const snap = getSettingsSnapshotInternal();
    if (!snap.settings.rosie.bot.enabled) return;
    if (sessionId.startsWith('pending:')) return;
    if (summarizeInflight.has(sessionId)) return;

    const info = await d.findSession(sessionId);
    if (!info) return;

    const rosieModel = snap.settings.rosie.bot.model;
    summarizeInflight.add(sessionId);
    try {
      await runSummarize(d, sessionId, info.path, info.vendor, rosieModel);
    } catch (err) {
      pushRosieLog({ source: 'rosie-bot:summarize', level: 'error',
        summary: `Summarize error: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      summarizeInflight.delete(sessionId);
    }
  });
  unsubscribers.push(unsub);
}

// ============================================================================
// Rosie.tracker — Persistent observer session
// ============================================================================

function initRosieTracker(d: AgentDispatch, _paths: InternalServerPaths): void {
  const unsub = onResponseCompleteAfter(async (sessionId: string) => {
    if (!dispatch) return;
    const snap = getSettingsSnapshotInternal();
    if (!snap.settings.rosie.bot.enabled) return;
    if (sessionId.startsWith('pending:')) return;
    if (trackerInflight.has(sessionId)) return;

    const info = await d.findSession(sessionId);
    if (!info) return;

    const rosieModel = snap.settings.rosie.bot.model;
    trackerInflight.add(sessionId);
    try {
      await runTracker(d, sessionId, info.path, info.vendor, rosieModel);
    } catch (err) {
      pushRosieLog({ source: 'rosie-bot:tracker', level: 'error',
        summary: `Tracker error: ${err instanceof Error ? err.message : String(err)}` });
      // On any error, invalidate the tracker session so next turn starts fresh
      evictTrackerSession(sessionId);
    } finally {
      trackerInflight.delete(sessionId);
    }
  });
  unsubscribers.push(unsub);
}

// ============================================================================
// Summarize Implementation
// ============================================================================

async function runSummarize(
  d: AgentDispatch,
  sessionId: string,
  sessionPath: string,
  parentVendor: string,
  modelOverride?: string,
): Promise<void> {
  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;

  const transcript = assembleBookendTranscript(sessionId, sessionPath, vendor as Vendor, model);
  if (!transcript) {
    pushRosieLog({ source: 'rosie-bot:summarize', level: 'info', summary: 'Summarize: skipped (no messages indexed yet)' });
    return;
  }

  const prompt = buildSummarizePrompt(transcript);

  for (let attempt = 1; attempt <= MAX_SUMMARIZE_ATTEMPTS; attempt++) {
    try {
      const result = await d.dispatchChild({
        parentSessionId: sessionId,
        vendor,
        parentVendor,
        prompt,
        settings: {
          ...(model && { model }),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
        forceNew: true,
        skipPersistSession: true,
        autoClose: true,
        env: {
          CLAUDECODE: '',
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '30000',
        },
        timeoutMs: 90_000,
      });

      if (!result) {
        pushRosieLog({ source: 'rosie-bot:summarize', level: 'warn',
          summary: `Summarize failed: no response (attempt ${attempt})` });
        continue;
      }

      // Log token usage
      if (result.contextUsage) {
        pushRosieLog({ source: 'rosie-bot:summarize', level: 'info',
          summary: `Summarize tokens: ${result.contextUsage.inputTokens}in / ${result.contextUsage.outputTokens}out`,
          data: result.contextUsage });
        recordTrackerOutcome(sessionPath, 'tracked', attempt, undefined, {
          subsystem: 'summarize',
          inputTokens: result.contextUsage.inputTokens,
          outputTokens: result.contextUsage.outputTokens,
          cachedTokens: result.contextUsage.cacheReadTokens,
          model: model,
          costUsd: result.contextUsage.totalCostUsd,
        });
      }

      const fields = parseSummarizeResponse(result.text);
      if (!fields) {
        pushRosieLog({ source: 'rosie-bot:summarize', level: 'warn',
          summary: `Summarize failed: XML parse error (attempt ${attempt})`,
          data: { responseSnippet: result.text.slice(0, 300) } });
        continue;
      }

      appendActivityEntries([{
        timestamp: new Date().toISOString(),
        kind: 'rosie-meta',
        file: sessionPath,
        preview: fields.quest,
        offset: 0,
        quest: fields.quest,
        summary: fields.summary,
        title: fields.title,
        status: fields.status,
        entities: '[]',
      }]);

      refreshAndNotify(sessionId);

      pushRosieLog({ source: 'rosie-bot:summarize', level: 'info',
        summary: `Summarize: ${fields.title || fields.quest}`,
        data: { quest: fields.quest, title: fields.title, status: fields.status } });
      return;
    } catch (err) {
      pushRosieLog({ source: 'rosie-bot:summarize', level: 'error',
        summary: `Summarize error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  pushRosieLog({ source: 'rosie-bot:summarize', level: 'warn',
    summary: `Summarize: all ${MAX_SUMMARIZE_ATTEMPTS} attempts failed` });
}

// ============================================================================
// Tracker Implementation
// ============================================================================

async function runTracker(
  d: AgentDispatch,
  sessionId: string,
  sessionPath: string,
  parentVendor: string,
  modelOverride?: string,
): Promise<void> {
  const paths = serverPaths;
  if (!paths) return;

  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;

  // Build turn content from the parent session's latest entries
  const turnNumber = (trackerTurnCounts.get(sessionId) ?? 0) + 1;
  const turnContent = await buildTurnContent(d, sessionId);
  if (!turnContent) {
    pushRosieLog({ source: 'rosie-bot:tracker', level: 'info', summary: 'Tracker: skipped (no turn content)' });
    return;
  }

  // Build project state
  const projectState = getProjectsForPrompt();

  // Build the per-turn injection
  const injection = buildPerTurnInjection(projectState, turnContent, turnNumber);

  // Get or create the decisions sidecar for this tracker session.
  // On turn 1 we create a fresh file and store it; on resume turns the
  // MCP sidecar is still bound to the original file, so we reuse it.
  const existingTrackerSessionId = trackerSessions.get(sessionId);
  let decisionsFile = existingTrackerSessionId
    ? trackerDecisionsFiles.get(sessionId)
    : undefined;

  // Truncate existing file so only this turn's decisions are present,
  // or create a new one for the first turn.
  if (decisionsFile) {
    try { writeFileSync(decisionsFile, ''); } catch { /* best-effort */ }
  } else {
    decisionsFile = createDecisionsFile();
  }

  try {
    let trackerResult: Awaited<ReturnType<typeof d.dispatchChild>> = null;

    if (existingTrackerSessionId) {
      // Resume existing tracker session
      pushRosieLog({ source: 'rosie-bot:tracker', level: 'info',
        summary: `Tracker: resuming turn ${turnNumber} for ${sessionId.slice(0, 12)}…` });

      trackerResult = await d.resumeChild({
        sessionId: existingTrackerSessionId,
        prompt: injection,
        settings: {
          ...(model && { model }),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
        autoClose: false,
        timeoutMs: 0,
      });

      if (!trackerResult) {
        pushRosieLog({ source: 'rosie-bot:tracker', level: 'warn',
          summary: `Tracker: resume failed (null result) — will start fresh next turn` });
        evictTrackerSession(sessionId);
        return;
      }
    } else {
      // First turn — dispatch new tracker child session
      pushRosieLog({ source: 'rosie-bot:tracker', level: 'info',
        summary: `Tracker: dispatching new session (turn 1) for ${sessionId.slice(0, 12)}…` });

      trackerResult = await d.dispatchChild({
        parentSessionId: sessionId,
        vendor,
        parentVendor,
        prompt: injection,
        systemPrompt: buildTrackerSystemPrompt(),
        settings: {
          ...(model && { model }),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
        forceNew: true,
        skipPersistSession: true,
        autoClose: false,
        sessionKind: 'system',
        mcpServers: buildInternalMcpConfig(paths.command, paths.args, [
          `--session-file=${sessionPath}`,
          `--decisions-file=${decisionsFile}`,
          `--parent-session-id=${sessionId}`,
        ]),
        env: {
          CLAUDECODE: '',
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '30000',
        },
        timeoutMs: 0,
      });

      if (!trackerResult) {
        pushRosieLog({ source: 'rosie-bot:tracker', level: 'warn',
          summary: 'Tracker: dispatch failed (null result)' });
        try { unlinkSync(decisionsFile); } catch { /* best-effort */ }
        return;
      }

      // Store the tracker session ID and decisions file for future resumes
      trackerSessions.set(sessionId, trackerResult.sessionId);
      trackerDecisionsFiles.set(sessionId, decisionsFile);
    }

    // Log token usage
    if (trackerResult.contextUsage) {
      pushRosieLog({ source: 'rosie-bot:tracker', level: 'info',
        summary: `Tracker tokens: ${trackerResult.contextUsage.inputTokens}in / ${trackerResult.contextUsage.outputTokens}out`,
        data: trackerResult.contextUsage });
    }

    // Record turn number
    trackerTurnCounts.set(sessionId, turnNumber);

    // Read decisions from sidecar
    const decisions = readDecisions(decisionsFile);
    if (decisions.length > 0) {
      logDecisions(decisions, sessionId);

      // Record outcome with token data
      const outcome = decisions.some(dec => dec.tool === 'mark_trivial' && !decisions.some(d2 => d2.tool === 'create_project' || d2.tool === 'track_project'))
        ? 'trivial' as const : 'tracked' as const;
      recordTrackerOutcome(sessionPath, outcome, turnNumber, undefined, {
        subsystem: 'tracker',
        inputTokens: trackerResult.contextUsage?.inputTokens,
        outputTokens: trackerResult.contextUsage?.outputTokens,
        cachedTokens: trackerResult.contextUsage?.cacheReadTokens,
        model: model,
        costUsd: trackerResult.contextUsage?.totalCostUsd,
      });

      runDedupSweep(d.dispatchChild).catch((err) => {
        console.warn('[rosie-bot:tracker] Dedup sweep failed:', err);
      });
    } else {
      pushRosieLog({ source: 'rosie-bot:tracker', level: 'warn',
        summary: `Tracker: no tool calls on turn ${turnNumber}` });
      recordTrackerOutcome(sessionPath, 'failed', turnNumber, 'no tool calls', {
        subsystem: 'tracker',
        inputTokens: trackerResult.contextUsage?.inputTokens,
        outputTokens: trackerResult.contextUsage?.outputTokens,
        cachedTokens: trackerResult.contextUsage?.cacheReadTokens,
        model: model,
        costUsd: trackerResult.contextUsage?.totalCostUsd,
      });
    }
  } catch (err) {
    pushRosieLog({ source: 'rosie-bot:tracker', level: 'error',
      summary: `Tracker error: ${err instanceof Error ? err.message : String(err)}` });
    evictTrackerSession(sessionId);
  }
}

/** Remove a tracker session from the registry and close it. */
function evictTrackerSession(parentSessionId: string): void {
  const trackerSessionId = trackerSessions.get(parentSessionId);
  if (trackerSessionId) {
    closeSession(trackerSessionId);
    trackerSessions.delete(parentSessionId);
  }
  const file = trackerDecisionsFiles.get(parentSessionId);
  if (file) {
    try { unlinkSync(file); } catch { /* best-effort */ }
    trackerDecisionsFiles.delete(parentSessionId);
  }
  trackerTurnCounts.delete(parentSessionId);
}

// ============================================================================
// Turn Content Stripper
// ============================================================================

/**
 * Build stripped turn content from the latest entries in the parent session.
 * Extracts the most recent user message and assistant response, formatting
 * tool calls as one-liners and omitting tool results entirely.
 */
async function buildTurnContent(d: AgentDispatch, sessionId: string): Promise<string | null> {
  let entries: TranscriptEntry[];
  try {
    entries = await d.loadSession(sessionId);
  } catch (err) {
    pushRosieLog({ source: 'rosie-bot:tracker', level: 'warn',
      summary: `buildTurnContent: loadSession threw: ${err instanceof Error ? err.message : String(err)}` });
    return null;
  }
  if (entries.length === 0) {
    pushRosieLog({ source: 'rosie-bot:tracker', level: 'warn',
      summary: `buildTurnContent: loadSession returned 0 entries for ${sessionId.slice(0, 12)}…` });
    return null;
  }

  // Diagnostic: log entry type distribution
  const typeCounts: Record<string, number> = {};
  for (const e of entries) typeCounts[e.type] = (typeCounts[e.type] ?? 0) + 1;
  pushRosieLog({ source: 'rosie-bot:tracker', level: 'info',
    summary: `buildTurnContent: ${entries.length} entries — ${JSON.stringify(typeCounts)}` });

  // Find the last user entry that contains real text (not just tool_result blocks).
  // In Claude transcripts, most `type: 'user'` entries are tool-result continuations
  // with content like [{ type: 'tool_result', ... }]. The actual human prompt is
  // typically a string or has text blocks.
  let lastUserIdx = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === 'user' && !entries[i]!.isMeta && extractEntryText(entries[i]!) !== null) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) {
    pushRosieLog({ source: 'rosie-bot:tracker', level: 'warn',
      summary: `buildTurnContent: no user entry with text in ${entries.length} entries` });
    return null;
  }

  const userEntry = entries[lastUserIdx]!;
  const assistantEntries = entries.slice(lastUserIdx + 1);

  const userText = extractEntryText(userEntry)!;

  // Extract assistant text and tool calls
  const toolCalls: string[] = [];
  let assistantText = '';

  for (const entry of assistantEntries) {
    if (entry.type === 'assistant' && entry.message) {
      const content = entry.message.content;
      if (typeof content === 'string') {
        assistantText += content;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            assistantText += (block as { text: string }).text;
          } else if (block.type === 'tool_use') {
            const tb = block as { name: string; input?: Record<string, unknown> };
            const params = tb.input ? summarizeToolInput(tb.input) : '';
            toolCalls.push(`- ${tb.name}${params ? ' ' + params : ''}`);
          }
        }
      }
    }
  }

  // Build the TURN template
  let result = `user: ${userText}`;

  if (toolCalls.length > 0) {
    result += `\nassistant_tools:\n${toolCalls.join('\n')}`;
  }

  if (assistantText.trim()) {
    result += `\nassistant_text: ${assistantText.trim()}`;
  }

  return result;
}

/** Extract plain text from a transcript entry. */
function extractEntryText(entry: TranscriptEntry): string | null {
  if (!entry.message) return null;
  const content = entry.message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = (content as ContentBlock[])
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map(b => b.text);
    return texts.length > 0 ? texts.join('\n') : null;
  }
  return null;
}

/** Summarize tool input as key params for the one-liner format. */
function summarizeToolInput(input: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value.length <= 100) {
      parts.push(value);
    } else if (typeof value === 'string') {
      parts.push(value.slice(0, 80) + '…');
    }
    if (parts.length >= 2) break;
  }
  return parts.join(' ');
}

// ============================================================================
// Tracker System Prompt (v4)
// ============================================================================

function buildTrackerSystemPrompt(): string {
  const types = VALID_TYPES.join(', ');
  const stages = VALID_STAGES.join(', ');

  return TRACKER_SYSTEM_PROMPT_TEMPLATE
    .replace('{{TYPES}}', types)
    .replace('{{STAGES}}', stages);
}

const TRACKER_SYSTEM_PROMPT_TEMPLATE = `You are Rosie Tracker. You silently observe a developer's coding session
and maintain a project board using tool calls only.

## Output Contract

- Respond ONLY with tool calls. Never emit text, commentary, or markdown.
- Every turn must end with at least one tool call.
- Call mark_trivial only if no items were tracked or created for this turn.

## What Counts as Work

Real work means: code or assets changed, a durable artifact was created,
or a concrete technical decision was made. Reading files, inspecting
state, running exploratory commands, or answering questions without
advancing the work is not enough by itself.

Incidental edits (tests, renames, formatting, refactors) done in service
of a primary task belong to that task — do not create separate items for
them unless they were an independent user-requested goal.

## Decision Tree

For each turn:

0. If the user explicitly says not to track this turn or session (e.g.
   "don't track this", "scratch session", "just experimenting"), call
   mark_trivial with the user's reason. Skip the rest.
1. Identify all distinct work items in the turn.
2. For each item: does it match an existing item in CURRENT_PROJECTS?
   Match if: (a) title/goal aligns, (b) entity overlap, or (c) continues
   an existing item's trajectory. Check in that order.
   → call track_project.
   If both a parent and child match, track the most specific (child).
3. For each remaining unmatched item where real work happened:
   → call create_project.
4. If no items qualify after steps 1-3, call mark_trivial with a reason.

**Default bias: prefer track_project over create_project.** Diagnosis →
root cause → fix is ONE project, not three. Only create when no existing
item is a reasonable match.

**Archived items:** Do not reopen archived projects on weak evidence
(e.g. shared file alone). Prefer creating a new item — the post-write
validation will flag true duplicates. Only reopen an archived item if
the title AND goal clearly match the new work.

**Multiple items:** A turn may touch several distinct workstreams. If
tools touch files in different domains, or the user describes unrelated
topics (look for "+", "&", or topic shifts), evaluate each independently.
Emit one tool call per distinct item.

## Tools

### create_project
Creates a new item on the board.
Required: title, type, stage, status, summary, icon, entities.
Optional: parent_id (for tasks/nested items), blocked_by (when paused),
files (non-code artifacts only — e.g. plans, specs, design docs),
branch.

### track_project
Updates an existing item.
Required: project_id (exact ID from CURRENT_PROJECTS), status.
Optional only if changed: stage, blocked_by, entities, files, branch.
Do not resend unchanged stage, title, summary, or icon.
Entities are appended to the existing list server-side — include only
NEW entities from this turn.

### merge_project
Combines a duplicate into an existing item.
Required: keep_id (the established item), remove_id (the duplicate).
Call when create_project returns a similarity warning in its response.

### mark_trivial
Marks the turn as not warranting any tracking. Include a brief reason.
Trivial signals: turn dominated by "recall", "status check", "recap",
"what was", "did we discuss", "refresh understanding", or retrieving
information without advancing any work.

## Schema

Valid type values: {{TYPES}}
Valid stage values: {{STAGES}}

Use exactly these values. Never invent a type or stage.
stage=idea is only valid when type=idea. When an idea becomes real
work, create a new project and archive the idea — do not mutate
the idea's type.

## Field Rules

- **type**: What the item IS.
  project = top-level initiative.
  task = sub-work under a project (must have parent_id).
  idea = explored but not committed to.
- **stage**: Lifecycle phase. Changes rarely — only when work actually
  moves between phases (started, paused, completed, abandoned).
  Do not change stage just because files were edited.
- **status**: What is true RIGHT NOW in plain English. Changes often.
  1-2 sentences.
- **summary**: What the project IS. Set once on create, rarely changed.
- **title**: Short, descriptive. Stable — do not rename every turn.
- **icon**: Single emoji for the domain.
- **entities**: Top 5-10 files, branches, key concepts. Ignore stable
  infrastructure files unless this session specifically modified them.
- **files**: Non-code artifacts only — plans, specs, design docs
  (e.g. ".ai-reference/plans/auth-design.md"). Source code (*.ts,
  *.css, *.rs, etc.) belongs in entities. Omit if none.
- **parent_id**: Only set when the parent already exists in
  CURRENT_PROJECTS. Do not create parent and child in the same turn.
  Create the parent first; child tasks can be added on subsequent turns.
- **blocked_by**: Set when stage is paused. Plain text reason.

## Extraction Guidance

### Commitments
Create items only when there is clear commitment or real work happened.
Do NOT create items for passing mentions, jokes, or one-off speculation.

### Ideas
Create as type=idea only when the conversation seriously explores a
possible future path that is then set aside without commitment. Not
every "what if" is worth tracking.

### Blockers
If the developer says something is blocked ("can't do X until Y",
"waiting on Z"), set that item's stage to paused and blocked_by to
the reason.

### Lifecycle
- Work completed or abandoned → stage=archived
- Work paused or blocked → stage=paused
- Work resumed → stage=active
- New planning discussion → stage=planning

## Worked Examples

### Example 1: Track existing + create new (multi-item turn)

Given CURRENT_PROJECTS:
id=p1 | type=project | stage=active | parent=- | title=Auth Rewrite | status=Designing token schema | entities=["src/middleware/auth.ts","jwt"]

Given TURN:
user: Let's implement the JWT middleware now. Also, the sidebar CSS is
broken on mobile — can you look at that too?
assistant_tools:
- Read src/middleware/auth.ts
- Write src/middleware/jwt-verify.ts
- Read src/components/Sidebar.css
- Edit src/components/Sidebar.css
assistant_text: Created the JWT verification middleware and fixed the
sidebar overflow on mobile viewports.

Expected tool calls:

track_project(
  project_id="p1",
  status="JWT middleware implemented in jwt-verify.ts",
  entities=["src/middleware/jwt-verify.ts"]
)

create_project(
  type="project",
  title="Fix sidebar mobile overflow",
  stage="archived",
  status="Fixed — CSS overflow corrected",
  summary="Sidebar broke on mobile viewports due to missing overflow rule",
  icon="🎨",
  entities=["src/components/Sidebar.css"]
)

The sidebar fix is unrelated to Auth Rewrite — it gets its own top-level
project. Created as archived because the fix is already complete.

### Example 2: Track a child task (most specific match)

Given CURRENT_PROJECTS:
id=p1 | type=project | stage=active | parent=- | title=Auth Rewrite | status=JWT middleware done | entities=["src/middleware/auth.ts","jwt"]
id=t1 | type=task | stage=active | parent=p1 | title=Write refresh token rotation | status=Started | entities=["src/middleware/refresh.ts"]

Given TURN:
user: Continue with the refresh token rotation — add the expiry check.
assistant_tools:
- Read src/middleware/refresh.ts
- Write src/middleware/token-expiry.ts
- Edit src/middleware/refresh.ts
assistant_text: Added expiry validation. Extracted the expiry logic
into a separate token-expiry module for reuse.

Expected tool calls:

track_project(
  project_id="t1",
  status="Added expiry validation, extracted token-expiry module",
  entities=["src/middleware/token-expiry.ts"]
)

Both p1 and t1 match, but t1 is the most specific — track the child.
Only the new file (token-expiry.ts) is sent as an entity since
refresh.ts is already tracked. Do not also update the parent unless
its status meaningfully changed.

### Example 3: Trivial turn

Given TURN:
user: What did we decide about the token schema last time?
assistant_tools:
- Read .ai-reference/plans/auth-design.md
assistant_text: Last session we decided on opaque refresh tokens with
a 7-day sliding window.

Expected tool calls:

mark_trivial(reason="Recall of prior decision, no new work")

The turn retrieved information but made no changes or decisions.`;

// ============================================================================
// Per-Turn Injection Builder
// ============================================================================

function buildPerTurnInjection(projectState: string, turnContent: string, turnNumber: number): string {
  const projectsSection = projectState
    ? `CURRENT_PROJECTS\n${projectState}`
    : 'CURRENT_PROJECTS\n(none)';

  return `${projectsSection}\n\nTURN ${turnNumber}\n${turnContent}\n\nUpdate your tracking.`;
}

// ============================================================================
// Bookend Transcript Assembly (for Summarize)
// ============================================================================

/** 30% of model context window, ~3 chars per token. */
function transcriptBudget(vendor: Vendor, model?: string): number {
  return Math.floor(getContextWindowTokens(vendor, model) * 0.3 * 3);
}

function assembleBookendTranscript(sessionId: string, sessionPath: string, vendor?: Vendor, model?: string): string | null {
  const budget = transcriptBudget((vendor ?? 'claude') as Vendor, model);
  const total = getSessionMessageCount(sessionId);
  if (total === 0) return null;

  const firstN = 2;
  const lastM = 3;

  const firstPage = readSessionMessages(sessionId, 0, firstN);
  if (!firstPage) return null;
  const first = firstPage.messages;

  const lastOffset = Math.max(firstN, total - lastM);
  const last = total > firstN
    ? (readSessionMessages(sessionId, lastOffset, lastM)?.messages ?? [])
    : [];

  const metas = getAllRosieMetas(sessionPath);

  let metasSection = '';
  if (metas.length > 0) {
    metasSection += '## Intermediate turn summaries (from prior analysis)\n\n';
    for (const m of metas) {
      metasSection += `- **${m.title}** — ${m.quest}\n  Status: ${m.status}\n\n`;
    }
  }

  let lastSection = '';
  if (last.length > 0) {
    lastSection += '## Final turns (verbatim)\n\n';
    for (const m of last) {
      const role = inferRole(m.role, m.message_seq);
      lastSection += `**${role}:** ${m.text || ''}\n\n`;
    }
  }

  const sacredLen = metasSection.length + lastSection.length;
  const openingBudget = Math.max(0, budget - sacredLen);

  let openingSection = '## Opening turns (verbatim)\n\n';
  let openingUsed = openingSection.length;
  for (const m of first) {
    const role = inferRole(m.role, m.message_seq);
    const text = m.text || '';
    const entry = `**${role}:** ${text}\n\n`;
    if (openingUsed + entry.length <= openingBudget) {
      openingSection += entry;
      openingUsed += entry.length;
    } else {
      const remaining = openingBudget - openingUsed;
      if (remaining > 50) {
        const truncated = text.slice(0, remaining - `**${role}:** \n\n…\n\n`.length);
        openingSection += `**${role}:** ${truncated}\n\n…\n\n`;
      }
      break;
    }
  }

  return openingSection + metasSection + lastSection;
}

// ============================================================================
// Summarize Prompt & Parsing
// ============================================================================

export const SUMMARIZE_PROMPT = `Consider this session transcript.
What is the stated or apparent goal of this particular conversation?
How would you label this conversation in a short sentence for a user to best remember what this session was for?
Summarize the last turn: Describe the User Request and your Response; including any work completed.
What is the current status of the work in this conversation? Describe where things stand right now — what's done, what's in progress, what's blocked or paused.

Provide your output in this format:
<goal>The goal of this conversation</goal>
<title>Label the conversation</title>
<summary>Turn summary</summary>
<status>Current status of the work</status>`;

function buildSummarizePrompt(transcript: string): string {
  return `${transcript}\n---\n\nBased on the conversation above:\n\n${SUMMARIZE_PROMPT}`;
}

function parseSummarizeResponse(text: string): {
  quest: string;
  title: string;
  summary: string;
  status: string;
} | null {
  const quest = extractTag(text, 'goal');
  const title = extractTag(text, 'title');
  const summary = extractTag(text, 'summary');
  const status = extractTag(text, 'status');

  if (quest && summary) return { quest, title, summary, status };
  return null;
}

const MAX_SUMMARIZE_ATTEMPTS = 2;

// ============================================================================
// Tracker Prompt (legacy, kept for export compatibility)
// ============================================================================

export function buildTrackerPrompt(
  meta: { quest?: string; title?: string; summary?: string; status?: string },
  projects: { id: string; title: string; stage: string; status: string | null; icon: string | null; entities: string }[],
): string {
  const projectList = projects.length > 0
    ? projects.map((p) => `[${p.id}] ${p.icon ?? ''} ${p.title} [${p.stage}] ${p.status ?? ''} — entities: ${p.entities}`).join('\n')
    : 'No existing projects yet.';

  const summaryLine = meta.summary ? `Summary: ${meta.summary}\n` : '';

  return `Title: ${meta.title ?? ''}
Quest: ${meta.quest ?? ''}
${summaryLine}Status: ${meta.status ?? ''}

## Existing Projects

${projectList}`;
}

// ============================================================================
// Decision Sidecar
// ============================================================================

function createDecisionsFile(): string {
  const file = join(tmpdir(), `crispy-tracker-${randomUUID()}.jsonl`);
  writeFileSync(file, '');
  return file;
}

function readDecisions(file: string): TrackerDecision[] {
  try {
    const raw = readFileSync(file, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line) as TrackerDecision);
  } catch (err) {
    pushRosieLog({ source: 'rosie-bot:tracker', level: 'warn', summary: 'Tracker: decisions file parse error', data: { file, error: String(err) } });
    return [];
  }
}

/**
 * Filter contradictory mark_trivial decisions.
 * If mark_trivial was called alongside create_project or track_project in the
 * same turn, the trivial call is discarded — the other tools take priority.
 */
function filterContradictoryTrivials(decisions: TrackerDecision[]): TrackerDecision[] {
  const hasSubstantive = decisions.some(d => d.tool === 'create_project' || d.tool === 'track_project' || d.tool === 'merge_project');
  const hasTrivial = decisions.some(d => d.tool === 'mark_trivial');

  if (hasSubstantive && hasTrivial) {
    pushRosieLog({ source: 'tracker', level: 'warn', summary: 'Discarded mark_trivial — other tools called in same turn' });
    return decisions.filter(d => d.tool !== 'mark_trivial');
  }

  return decisions;
}

function logDecisions(decisions: TrackerDecision[], sessionId: string): void {
  decisions = filterContradictoryTrivials(decisions);
  for (const d of decisions) {
    if (d.tool === 'create_project') {
      pushRosieLog({
        source: 'rosie-bot:tracker',
        level: 'info',
        summary: `Tracker: created "${d.title}" [${d.stage}] ${d.status ?? ''}`,
        data: { sessionId, ...d },
      });
      pushTrackerNotification({
        kind: 'project_created',
        projectTitle: d.title,
        icon: d.icon,
        newStage: d.stage,
        status: d.status,
      });
    } else if (d.tool === 'track_project') {
      pushRosieLog({
        source: 'rosie-bot:tracker',
        level: 'info',
        summary: `Tracker: updated "${d.title}" ${d.stage ? `[${d.stage}]` : ''} ${d.status ?? ''}`,
        data: { sessionId, ...d },
      });
      pushTrackerNotification({
        kind: d.stage ? 'stage_change' : 'project_matched',
        projectTitle: d.title,
        icon: d.icon,
        newStage: d.stage,
        status: d.status,
      });
    } else if (d.tool === 'merge_project') {
      pushRosieLog({
        source: 'rosie-bot:tracker',
        level: 'info',
        summary: `Tracker: merged project "${d.title}" (kept ${d.keep_id}, removed ${d.remove_id})`,
        data: { sessionId, ...d },
      });
    } else if (d.tool === 'mark_trivial') {
      pushRosieLog({
        source: 'rosie-bot:tracker',
        level: 'info',
        summary: `Tracker: marked trivial — ${d.reason}`,
        data: { sessionId, ...d },
      });
      pushTrackerNotification({
        kind: 'trivial',
        status: d.reason,
      });
    }
  }
  const creates = decisions.filter(d => d.tool === 'create_project').length;
  const tracks = decisions.filter(d => d.tool === 'track_project').length;
  const merges = decisions.filter(d => d.tool === 'merge_project').length;
  const trivials = decisions.filter(d => d.tool === 'mark_trivial').length;
  pushRosieLog({ source: 'rosie-bot:tracker', level: 'info', summary: `Tracker: ${decisions.length} decisions (${creates} create, ${tracks} track, ${merges} merge, ${trivials} trivial)`, data: { sessionId, total: decisions.length, creates, tracks, merges, trivials } });
}
