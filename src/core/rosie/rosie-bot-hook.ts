/**
 * Rosie Bot Hook — Gen 3 single-call tracker
 *
 * Dispatches a persistent child session that observes developer turns and
 * maintains a project board using the crispy-tracker CLI (via Bash).
 * No separate summarize step — the tracker handles session titles directly
 * via RPC. Notifications fire from the RPC write handlers in
 * client-connection.ts, not from a sidecar.
 *
 * @module rosie/rosie-bot-hook
 */

import { onResponseCompleteAfter } from '../lifecycle-hooks.js';
import type { AgentDispatch } from '../agent-dispatch-types.js';
import { getSettingsSnapshotInternal } from '../settings/index.js';
import type { ArbiterPolicy } from '../arbiter/types.js';
import { parseModelOption } from '../model-utils.js';
import { closeSession } from '../session-manager.js';
import { log } from '../log.js';
import { recordTrackerOutcome, getStagesForPrompt, getCompactProjectsForPrompt } from './tracker/db-writer.js';
import { VALID_TYPES } from './tracker/types.js';
import { extractTurnsFromMessages, formatTurnContent } from './tracker/turn-extractor.js';
import { readSessionMessages, getSessionMessageCount } from '../recall/message-store.js';
import { getSessionTitleFromDb } from '../activity-index.js';

// ============================================================================
// Module State
// ============================================================================

let dispatch: AgentDispatch | null = null;
const unsubscribers: Array<() => void> = [];

/** Resolved paths for the tracker child session. */
let trackerScriptPath = '';
let ipcSocketPath = '';
let cachedTrackerPolicy: ArbiterPolicy | null = null;

// Tracker state — persistent session per parent, turn counter
const trackerSessions = new Map<string, string>();  // parentSessionId → trackerChildSessionId
const trackerTurnCounts = new Map<string, number>(); // parentSessionId → turn number
const trackerInflight = new Set<string>();            // concurrency guard

// ============================================================================
// Lifecycle
// ============================================================================

export interface RosieBotConfig {
  /** Absolute path to the crispy-tracker.mjs script. */
  trackerScript: string;
  /** Absolute path to the IPC socket (or named pipe on Windows). */
  ipcSocket: string;
}

export function initRosieBot(d: AgentDispatch, config: RosieBotConfig): void {
  dispatch = d;
  trackerScriptPath = config.trackerScript;
  ipcSocketPath = config.ipcSocket;
  cachedTrackerPolicy = buildTrackerPolicy();
  initRosieTracker(d);
}

export function shutdownRosieBot(): void {
  for (const unsub of unsubscribers) unsub();
  unsubscribers.length = 0;
  dispatch = null;
  cachedTrackerPolicy = null;
  // Close all live tracker child sessions before clearing state
  for (const [parentId] of trackerSessions) {
    evictTrackerSession(parentId);
  }
}

// ============================================================================
// Tracker Arbiter Policy
// ============================================================================

function buildTrackerPolicy(): ArbiterPolicy {
  return {
    deny: [
      'Write', 'Edit', 'Agent', 'WebFetch',
      'Bash(rm *)', 'Bash(git push*)', 'Bash(git commit*)',
      'Bash(git checkout*)', 'Bash(git reset*)',
      'Bash(curl *)', 'Bash(wget *)',
    ],
    allow: [
      `Bash(${trackerScriptPath} *)`,
      `Bash(node ${trackerScriptPath} *)`,
      'Bash(crispy-dispatch rpc *)',
      'Bash(git status)', 'Bash(git log *)',
      'Read(*)', 'Glob(*)', 'Grep(*)',
    ],
    fallback: 'deny',
    bashMode: 'strict',
  };
}

// ============================================================================
// Rosie.tracker — Persistent observer session (Gen 3)
// ============================================================================

function initRosieTracker(d: AgentDispatch): void {
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
      await runTracker(d, sessionId, info.path, info.vendor, rosieModel, info.projectPath);
    } catch (err) {
      log({ source: 'rosie-bot:tracker', level: 'error',
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
// Tracker Implementation (Gen 3)
// ============================================================================

async function runTracker(
  d: AgentDispatch,
  sessionId: string,
  sessionPath: string,
  parentVendor: string,
  modelOverride?: string,
  projectPath?: string,
): Promise<void> {
  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;

  // Build turn content from the parent session's latest entries
  const turnNumber = (trackerTurnCounts.get(sessionId) ?? 0) + 1;

  // Read only the last 20 messages from the DB instead of loading the full transcript
  const totalMessages = getSessionMessageCount(sessionId);
  if (totalMessages === 0) {
    log({ source: 'rosie-bot:tracker', level: 'info', summary: 'Tracker: skipped (no messages)' });
    return;
  }

  const page = readSessionMessages(sessionId, Math.max(0, totalMessages - 20), 20);
  if (!page || page.messages.length === 0) {
    log({ source: 'rosie-bot:tracker', level: 'info', summary: 'Tracker: skipped (no messages)' });
    return;
  }

  const turns = extractTurnsFromMessages(page.messages);
  const latestTurn = turns.length > 0 ? turns[turns.length - 1]! : null;
  if (!latestTurn) {
    log({ source: 'rosie-bot:tracker', level: 'info', summary: 'Tracker: skipped (no turn content)' });
    return;
  }
  const turnContent = formatTurnContent(latestTurn);

  // Build compact project state
  const projectState = getCompactProjectsForPrompt(projectPath);

  // Read current session title
  const sessionTitle = getSessionTitleFromDb(sessionId);

  // Build the per-turn injection
  const injection = buildPerTurnInjection(projectState, turnContent, turnNumber, sessionTitle);

  const existingTrackerSessionId = trackerSessions.get(sessionId);

  try {
    let trackerResult: Awaited<ReturnType<typeof d.dispatchChild>> = null;

    if (existingTrackerSessionId) {
      // Resume existing tracker session
      log({ source: 'rosie-bot:tracker', level: 'info',
        summary: `Tracker: resuming turn ${turnNumber} for ${sessionId.slice(0, 12)}…` });

      trackerResult = await d.resumeChild({
        sessionId: existingTrackerSessionId,
        prompt: injection,
        settings: {
          ...(model && { model }),
          permissionMode: 'default',
        },
        autoClose: false,
        timeoutMs: 0,
      });

      if (!trackerResult) {
        log({ source: 'rosie-bot:tracker', level: 'warn',
          summary: `Tracker: resume failed (null result) — will start fresh next turn` });
        evictTrackerSession(sessionId);
        return;
      }
    } else {
      // First turn — dispatch new tracker child session
      log({ source: 'rosie-bot:tracker', level: 'info',
        summary: `Tracker: dispatching new session (turn 1) for ${sessionId.slice(0, 12)}…` });

      trackerResult = await d.dispatchChild({
        parentSessionId: sessionId,
        vendor,
        parentVendor,
        prompt: injection,
        systemPrompt: buildTrackerSystemPrompt(),
        settings: {
          ...(model && { model }),
          // arbiterPolicy requires approval events — dispatchChildSession forces permissionMode: 'default'
        },
        forceNew: true,
        skipPersistSession: false,
        autoClose: false,
        sessionKind: 'system',
        env: {
          CLAUDECODE: '',
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '30000',
          CRISPY_TRACKER: trackerScriptPath,
          CRISPY_SOCK: ipcSocketPath,
          CRISPY_PARENT_SESSION_ID: sessionId,
          CRISPY_PROJECT_PATH: projectPath ?? '',
        },
        timeoutMs: 0,
        arbiterPolicy: cachedTrackerPolicy!,
      });

      if (!trackerResult) {
        log({ source: 'rosie-bot:tracker', level: 'warn',
          summary: 'Tracker: dispatch failed (null result)' });
        return;
      }

      // Store the tracker session ID for future resumes
      trackerSessions.set(sessionId, trackerResult.sessionId);
    }

    // Log token usage
    if (trackerResult.contextUsage) {
      log({ source: 'rosie-bot:tracker', level: 'info',
        summary: `Tracker tokens: ${trackerResult.contextUsage.inputTokens}in / ${trackerResult.contextUsage.outputTokens}out`,
        data: trackerResult.contextUsage });
    }

    // Record turn number
    trackerTurnCounts.set(sessionId, turnNumber);

    // Record outcome with token data.
    // Gen 3 tracker writes directly via RPCs — notifications fire there.
    // We can't inspect individual decisions, so we record based on
    // whether the tracker produced any output at all.
    recordTrackerOutcome(sessionPath, 'tracked', turnNumber, undefined, {
      subsystem: 'tracker',
      inputTokens: trackerResult.contextUsage?.inputTokens,
      outputTokens: trackerResult.contextUsage?.outputTokens,
      cachedTokens: trackerResult.contextUsage?.cacheReadTokens,
      model: model,
      costUsd: trackerResult.contextUsage?.totalCostUsd,
    });

  } catch (err) {
    log({ source: 'rosie-bot:tracker', level: 'error',
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
  trackerTurnCounts.delete(parentSessionId);
}

// ============================================================================
// Gen 3 System Prompt
// ============================================================================

function buildTrackerSystemPrompt(): string {
  const types = VALID_TYPES.join(', ');
  const stages = getStagesForPrompt();

  return GEN3_SYSTEM_PROMPT_TEMPLATE
    .replace('{{TYPES}}', types)
    .replace('{{STAGES}}', stages);
}

const GEN3_SYSTEM_PROMPT_TEMPLATE = `You are Rosie Tracker. You observe a developer's coding session
and maintain a project board by calling the tracker CLI.

## Reasoning

Think through your decisions before acting. Explain your reasoning,
then make your tool calls.

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
   \`$CRISPY_TRACKER trivial\` with the user's reason. Skip the rest.
1. Identify all distinct work items in the turn.
2. For each item: does it match an existing item in CURRENT_PROJECTS?
   Match if: (a) title/goal aligns, (b) entity overlap, or (c) continues
   an existing item's trajectory. Check in that order.
   → call \`$CRISPY_TRACKER track\`.
   If both a parent and child match, track the most specific (child).
3. For each remaining unmatched item where real work happened:
   → call \`$CRISPY_TRACKER create\`.
4. If no items qualify after steps 1-3, call \`$CRISPY_TRACKER trivial\` with a reason.

**Default bias: prefer track over create.** Diagnosis →
root cause → fix is ONE project, not three. Only create when no existing
item is a reasonable match.

**Done items:** If new work clearly continues a done project (same
title AND goal), reopen it by tracking with stage=active. Otherwise
prefer creating a new item — the post-write validation will flag
true duplicates.

**Archived items:** Do not reopen archived projects on weak evidence
(e.g. shared file alone). Prefer creating a new item. Only reopen an
archived item if the title AND goal clearly match the new work.

**Multiple items:** A turn may touch several distinct workstreams. If
tools touch files in different domains, or the user describes unrelated
topics (look for "+", "&", or topic shifts), evaluate each independently.
Emit one CLI call per distinct item.

## Tools

Use the Bash tool to call the tracker CLI:

### Create a project
$CRISPY_TRACKER create --title "..." --type project --stage active --status "..." --summary "..." --icon "🔧"

### Update a project
$CRISPY_TRACKER track --id <project-id> --status "..." [--stage <stage>]

### Merge duplicates
$CRISPY_TRACKER merge --keep <keep-id> --remove <remove-id>

### Mark trivial
$CRISPY_TRACKER trivial --reason "..."

### Show project details
$CRISPY_TRACKER show --id <project-id>

Use this when you need full details (status, summary) for a
project before deciding whether to track it. The CURRENT_PROJECTS index
only shows id, stage, and title.

### Set session title
$CRISPY_TRACKER title --session $CRISPY_PARENT_SESSION_ID --title "Short descriptive title"

### List available stages
$CRISPY_TRACKER stages

## Session Title (MANDATORY)

The injection includes \`SESSION_TITLE:\` showing the current title.

- If it says \`(none — you MUST set one)\` → you MUST call \`$CRISPY_TRACKER title\`
- If it shows an existing title → only update if the session's focus has
  significantly shifted. Otherwise skip the title call.

$CRISPY_TRACKER title --session $CRISPY_PARENT_SESSION_ID --title "Short 3-8 word label"

Always call this AFTER your tracking action (create/track/merge/trivial).

## Schema

Valid type values: {{TYPES}}

## Available Stages

{{STAGES}}

Use exactly these stage names. The description tells you when each is appropriate.
stage=idea is only valid when type=idea. When an idea becomes real
work, create a new project and mark the idea as done — do not mutate
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
- **files**: Non-code artifacts only — plans, specs, design docs
  (e.g. ".ai-reference/plans/auth-design.md"). Source code (*.ts,
  *.css, *.rs, etc.) does not belong here. Omit if none.
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
- Work completed → stage=done
- Work abandoned or shelved → stage=paused (with blocked_by reason)
- Work paused or blocked → stage=paused
- Work resumed → stage=active
- New planning discussion → stage=planning

## Worked Examples

### Example 1: Track existing + create new (multi-item turn)

Given CURRENT_PROJECTS:
id=p1 | type=project | stage=active | parent=- | title=Auth Rewrite | status=Designing token schema

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

Expected reasoning and tool calls:

Two distinct items here. The JWT middleware clearly continues the Auth
Rewrite (p1). The sidebar fix is unrelated — needs a new project.

$CRISPY_TRACKER track --id p1 --status "JWT middleware implemented in jwt-verify.ts"

$CRISPY_TRACKER create --title "Fix sidebar mobile overflow" --type project --stage done --status "Fixed — CSS overflow corrected" --summary "Sidebar broke on mobile viewports due to missing overflow rule" --icon "🎨"

$CRISPY_TRACKER title --session $CRISPY_PARENT_SESSION_ID --title "Auth JWT & sidebar fix"

The sidebar fix is unrelated to Auth Rewrite — it gets its own top-level
project. Created as done because the fix is already complete — the user
decides when to archive.

### Example 2: Track a child task (most specific match)

Given CURRENT_PROJECTS:
id=p1 | type=project | stage=active | parent=- | title=Auth Rewrite | status=JWT middleware done
id=t1 | type=task | stage=active | parent=p1 | title=Write refresh token rotation | status=Started

Given TURN:
user: Continue with the refresh token rotation — add the expiry check.
assistant_tools:
- Read src/middleware/refresh.ts
- Write src/middleware/token-expiry.ts
- Edit src/middleware/refresh.ts
assistant_text: Added expiry validation. Extracted the expiry logic
into a separate token-expiry module for reuse.

Expected reasoning and tool calls:

Both p1 and t1 match, but t1 is the most specific — track the child.

$CRISPY_TRACKER track --id t1 --status "Added expiry validation, extracted token-expiry module"

### Example 3: Trivial turn

Given TURN:
user: What did we decide about the token schema last time?
assistant_tools:
- Read .ai-reference/plans/auth-design.md
assistant_text: Last session we decided on opaque refresh tokens with
a 7-day sliding window.

Expected reasoning and tool calls:

The turn retrieved information but made no changes or decisions.

$CRISPY_TRACKER trivial --reason "Recall of prior decision, no new work"

## Injection Format

Each turn arrives as:

\`\`\`
CURRENT_PROJECTS (N non-archived)
<id> | <stage> | <title>
<id> | <stage> | <title>
...

TURN <N>
<turn content>
\`\`\`

The project index is compact — just id, stage, and title. If you need
full details (status, summary) to decide whether a turn matches
a project, call \`$CRISPY_TRACKER show --id <id>\` before making your decision.`;

// ============================================================================
// Per-Turn Injection Builder (Gen 3)
// ============================================================================

function buildPerTurnInjection(
  projectState: string,
  turnContent: string,
  turnNumber: number,
  sessionTitle: string | null,
): string {
  const count = projectState ? projectState.split('\n').length : 0;
  const projectsSection = projectState
    ? `CURRENT_PROJECTS (${count} non-archived)\n${projectState}`
    : 'CURRENT_PROJECTS\n(none)';

  const titleLine = sessionTitle
    ? `SESSION_TITLE: ${sessionTitle}`
    : 'SESSION_TITLE: (none — you MUST set one)';

  return `${projectsSection}\n\n${titleLine}\n\nObserve the following turn...\n\nTURN ${turnNumber}\n${turnContent}`;
}

