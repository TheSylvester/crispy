/**
 * Rosie Tracker Hook — Lifecycle hook for automated project tracking
 *
 * Registers as a phase-2 responseComplete handler (fires AFTER summarize).
 * Reads the fresh rosie-meta output, dispatches an ephemeral child session
 * with MCP tools (upsert_project, mark_trivial) to match/create projects.
 * The tool handlers in the internal MCP server write directly to the DB —
 * no XML parsing or post-hoc validation needed.
 *
 * Mirrors summarize-hook.ts structure: module state, init/shutdown,
 * dispatchChild with retry.
 *
 * @module rosie/tracker/tracker-hook
 */

import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { onResponseCompleteAfter } from '../../lifecycle-hooks.js';
import type { AgentDispatch } from '../../../host/agent-dispatch.js';
import { getSettingsSnapshotInternal } from '../../settings/index.js';
import { parseModelOption } from '../../model-utils.js';
import { getLatestRosieMeta } from '../../activity-index.js';
import { pushRosieLog } from '../debug-log.js';
import { getExistingProjects, recordTrackerOutcome, runDedupSweep } from './db-writer.js';
import { buildInternalMcpConfig } from '../../../mcp/servers/external.js';
import type { TrackerDecision } from '../../../mcp/servers/internal.js';
import type { InternalServerPaths } from './types.js';

// Re-export for consumers that import from this module
export type { InternalServerPaths } from './types.js';

// ============================================================================
// Module State
// ============================================================================

let dispatch: AgentDispatch | null = null;
let serverPaths: InternalServerPaths | null = null;
let unsubscribe: (() => void) | null = null;
const inflight = new Set<string>();

// ============================================================================
// Lifecycle
// ============================================================================

export function initRosieTracker(d: AgentDispatch, paths: InternalServerPaths): void {
  dispatch = d;
  serverPaths = paths;

  // Startup dedup sweep — catches any duplicates that slipped through
  runDedupSweep(d.dispatchChild).catch((err) => {
    console.warn('[rosie.tracker] Startup dedup sweep failed:', err instanceof Error ? err.message : String(err));
  });

  unsubscribe = onResponseCompleteAfter(async (sessionId: string) => {
    // Capture dispatch locally — shutdown can null it while we're in-flight
    const d = dispatch;
    if (!d) return;

    // Guard: settings check
    const snap = getSettingsSnapshotInternal();
    if (!snap.settings.rosie.tracker.enabled) {
      pushRosieLog({ source: 'tracker', level: 'info', summary: 'Tracker: skipped (disabled)' });
      return;
    }

    // Guard: pending IDs, inflight
    if (sessionId.startsWith('pending:')) {
      pushRosieLog({ source: 'tracker', level: 'info', summary: 'Tracker: skipped (pending ID)' });
      return;
    }
    if (inflight.has(sessionId)) {
      pushRosieLog({ source: 'tracker', level: 'info', summary: 'Tracker: skipped (already running)' });
      return;
    }

    // Look up session info
    const info = await d.findSession(sessionId);
    if (!info) {
      pushRosieLog({ source: 'tracker', level: 'warn', summary: `Tracker: skipped (session ${sessionId.slice(0, 12)}… not found)` });
      return;
    }

    // Get fresh rosie-meta (written by summarize in phase 1)
    const meta = getLatestRosieMeta(info.path);
    if (!meta || !meta.quest || !meta.summary) {
      pushRosieLog({ source: 'tracker', level: 'info', summary: 'Tracker: skipped (no summarize metadata)' });
      return;
    }

    // Resolve model — settings override, else system default
    const rosieModel = snap.settings.rosie.tracker.model;

    inflight.add(sessionId);
    pushRosieLog({ source: 'tracker', level: 'info', summary: `Tracker: starting for ${sessionId.slice(0, 12)}…`, data: { sessionId, vendor: info.vendor } });
    try {
      await runTrackerAnalysis(d, sessionId, info.path, info.vendor, meta, rosieModel);

      // Fire-and-forget dedup sweep after successful write
      runDedupSweep(d.dispatchChild).catch((err) => {
        console.warn('[rosie.tracker] Post-write dedup sweep failed:', err instanceof Error ? err.message : String(err));
      });
    } finally {
      inflight.delete(sessionId);
    }
  });
}

export function shutdownRosieTracker(): void {
  unsubscribe?.();
  unsubscribe = null;
  dispatch = null;
  serverPaths = null;
}

// ============================================================================
// Decision Sidecar
// ============================================================================

/** Create a temp file path for the MCP subprocess to write decisions to. */
function createDecisionsFile(): string {
  const file = join(tmpdir(), `crispy-tracker-${randomUUID()}.jsonl`);
  writeFileSync(file, '');
  return file;
}

/** Read and delete the decisions sidecar file. Returns parsed decisions. */
function readDecisions(file: string): TrackerDecision[] {
  try {
    const raw = readFileSync(file, 'utf-8').trim();
    if (!raw) return [];
    return raw.split('\n').map((line) => JSON.parse(line) as TrackerDecision);
  } catch (err) {
    pushRosieLog({ source: 'tracker', level: 'warn', summary: 'Tracker: decisions file parse error', data: { file, error: String(err) } });
    return [];
  } finally {
    try { unlinkSync(file); } catch { /* best-effort cleanup */ }
  }
}

/** Push individual rosie log entries for each tracker decision. */
function logDecisions(decisions: TrackerDecision[], sessionId: string): void {
  for (const d of decisions) {
    if (d.tool === 'upsert_project') {
      pushRosieLog({
        source: 'tracker',
        level: 'info',
        summary: `Tracker: ${d.action} "${d.title}" → ${d.status}`,
        data: { sessionId, ...d },
      });
    } else if (d.tool === 'mark_trivial') {
      pushRosieLog({
        source: 'tracker',
        level: 'info',
        summary: `Tracker: marked trivial — ${d.reason}`,
        data: { sessionId, ...d },
      });
    }
  }
  const upserts = decisions.filter(d => d.tool === 'upsert_project').length;
  const trivials = decisions.filter(d => d.tool === 'mark_trivial').length;
  pushRosieLog({ source: 'tracker', level: 'info', summary: `Tracker: ${decisions.length} decisions (${upserts} upsert, ${trivials} trivial)`, data: { sessionId, total: decisions.length, upserts, trivials } });
}

// ============================================================================
// Analysis
// ============================================================================

const MAX_ATTEMPTS = 3;

async function runTrackerAnalysis(
  d: AgentDispatch,
  sessionId: string,
  sessionPath: string,
  parentVendor: string,
  meta: { quest?: string; title?: string; summary?: string; status?: string; entities?: string },
  modelOverride?: string,
): Promise<void> {
  if (!serverPaths) {
    console.warn('[rosie.tracker] Internal MCP server paths not configured');
    return;
  }

  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;
  pushRosieLog({ source: 'tracker', level: 'info', summary: `Tracker: using ${vendor}/${model || 'default'}`, data: { vendor, model } });

  // Build prompt with existing projects context
  const existingProjects = getExistingProjects();
  pushRosieLog({ source: 'tracker', level: 'info', summary: `Tracker: ${existingProjects.length} existing projects in context` });
  const prompt = buildTrackerPrompt(meta, existingProjects);

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const decisionsFile = createDecisionsFile();
    try {
      const retryNudge = attempt === 2
        ? `\n\nIMPORTANT: Your previous attempt failed because you did not call any tools. You MUST call upsert_project or mark_trivial. Do not output JSON or text — use the tool calling interface.`
        : attempt >= 3
          ? `\n\nCRITICAL FINAL ATTEMPT: You failed twice to call tools. Call upsert_project or mark_trivial RIGHT NOW. No text output. Tools only.`
          : '';
      const promptToSend = prompt + retryNudge;

      const result = await d.dispatchChild({
        parentSessionId: sessionId,
        vendor,
        parentVendor,
        prompt: promptToSend,
        settings: {
          ...(model && { model }),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
        forceNew: true,
        mcpServers: buildInternalMcpConfig(serverPaths.command, serverPaths.args, [
          `--session-file=${sessionPath}`,
          `--decisions-file=${decisionsFile}`,
        ]),
        env: {
          CLAUDECODE: '',
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '30000',
        },
        skipPersistSession: true,
        autoClose: true,
        timeoutMs: 30_000,
      });

      // Read decisions written by the MCP tool handlers in the subprocess.
      // Tools write to a sidecar file as a side-effect — dispatchChild may
      // return null (no text output) even when tools fired successfully.
      const decisions = readDecisions(decisionsFile);

      if (decisions.length > 0) {
        // Tools fired — success regardless of whether dispatchChild returned text
        const snippet = result?.text?.slice(0, 200) ?? '(no text — tools-only response)';
        console.log(`[rosie.tracker] OK — ${decisions.length} decision(s) via tool calls (attempt ${attempt})`);
        pushRosieLog({
          source: 'tracker',
          level: 'info',
          summary: `Tracker: analysis completed`,
          data: { sessionId, attempt, responseSnippet: snippet },
        });
        logDecisions(decisions, sessionId);
        return;
      }

      if (!result) {
        console.warn(`[rosie.tracker] FAIL attempt ${attempt}/${MAX_ATTEMPTS}: no tool calls and no text response`);
        pushRosieLog({
          source: 'tracker',
          level: 'warn',
          summary: `Tracker failed: no response (attempt ${attempt}/${MAX_ATTEMPTS})`,
          data: { sessionId, attempt },
        });
        continue;
      }

      // Got text but no tool calls — model commented instead of calling tools
      console.warn(`[rosie.tracker] FAIL attempt ${attempt}/${MAX_ATTEMPTS}: text response but no tool calls`);
      pushRosieLog({
        source: 'tracker',
        level: 'warn',
        summary: `Tracker failed: text output but no tool calls (attempt ${attempt}/${MAX_ATTEMPTS})`,
        data: { sessionId, attempt, responseSnippet: result.text.slice(0, 200) },
      });
      continue;
    } catch (err) {
      // Clean up decisions file on error (readDecisions won't have run)
      try { unlinkSync(decisionsFile); } catch { /* best-effort */ }
      console.warn(`[rosie.tracker] FAIL attempt ${attempt}/${MAX_ATTEMPTS} threw:`, err);
      pushRosieLog({
        source: 'tracker',
        level: 'error',
        summary: `Tracker failed: ${err instanceof Error ? err.message : String(err)}`,
        data: { sessionId, attempt, error: String(err) },
      });
    }
  }

  // All attempts exhausted — record failure so backfill knows this was tried
  recordTrackerOutcome(sessionPath, 'failed', MAX_ATTEMPTS, 'All attempts exhausted — no tool calls');
}

// ============================================================================
// Prompt Building
// ============================================================================

const TRACKER_SYSTEM_PROMPT = `You are a project tracker. You receive a session summary and a list of existing projects. \
Your job is to identify EVERY distinct project this session touched and file each one.

You have two tools:
- **upsert_project** — Create or update a project. Call once PER DISTINCT PROJECT this session touches. Most sessions touch 1 project, but some touch 2-3.
- **mark_trivial** — Mark the session as not warranting any project (quick recall, empty session, false start).

## Task

Analyze the session summary. Identify each distinct workstream:
- Does it match an existing project? → call upsert_project with that project's id
- Is it new work? → call upsert_project without an id
- Is the entire session trivial? → call mark_trivial

**Look for multiple projects.** Sessions often contain a primary quest plus secondary work — a sidequest, a tangential fix, a plan saved for a different feature, or a skill/tool created alongside the main work. If the session title contains "+", "&", or describes two unrelated topics, there are almost certainly multiple projects. Call upsert_project once for each.

## Matching Rules (priority order)

1. **Title similarity** — if the topic closely matches an existing project title, it's the same project
2. **Entity overlap** — shared files, branches, or function names confirm a match when titles differ
3. **Quest continuity** — if the topic continues an existing project's goal (e.g. one planned it, this one built it), same project
4. **Status progression** — if the topic picks up where an existing project left off (planned → active, active → done), that reinforces a match

Only create a new project when no existing project is a reasonable match.

## Merge Rule

If this session and prior sessions form one arc (diagnosis → root cause → fix), they belong to the same project. Do not create a new project for each phase.

## Recall Rule

If the session's primary activity was looking up, recapping, or checking the status of prior work — it is **trivial**. The recalled content belongs to the original sessions, not this one.

**Trivial signals** (any of these → strongly consider mark_trivial):
- Quest mentions: "recall", "did we discuss", "status check", "refresh understanding", "recap", "what was", "check on", "review plans"
- Session is a brief conversation with no code changes or design decisions
- Session rehashes or summarizes prior work without advancing it
- Session is an audit, inventory check, or portfolio review with no new deliverables
- Session asks about or retrieves information but produces no artifacts

Only create a project if the session performed **NEW work** beyond retrieval — code written, design decisions made, plans created, or bugs fixed.

## Rules

- **title**: Keep stable across sessions. Don't rename unless scope fundamentally changed.
- **summary**: Reflect the CURRENT state, not history. What's true right now?
- **entities**: Top 5-10. Include files, branches, key concepts. These are used for future matching. **Ignore stable infrastructure** — don't include foundational files that appear in many sessions (e.g. transcript.ts, channel-events.ts, session-manager.ts, activity-index.ts, CLAUDE.md) unless the session specifically modified them. Focus on files and concepts unique to THIS work.
- **files**: Non-code artifacts only — plans (.ai-reference/), specs, design docs, skill definitions. Source code belongs in entities, not files. Omit if none exist.

**You MUST call your tools.** Do not emit JSON, markdown, or commentary. Call upsert_project or mark_trivial directly.`;

/** Build the full tracker prompt (system + user context). */
export function buildTrackerPrompt(
  meta: { quest?: string; title?: string; summary?: string; status?: string; entities?: string },
  projects: { id: string; title: string; status: string; entities: string }[],
): string {
  const projectList = projects.length > 0
    ? projects.map((p) => `[${p.id}] ${p.title} (${p.status}) — entities: ${p.entities}`).join('\n')
    : 'No existing projects yet.';

  const summaryLine = meta.summary ? `Summary: ${meta.summary}\n` : '';

  return `${TRACKER_SYSTEM_PROMPT}

---

## Session Summary

Title: ${meta.title ?? ''}
Quest: ${meta.quest ?? ''}
${summaryLine}Status: ${meta.status ?? ''}
Entities: ${meta.entities ?? '[]'}

## Existing Projects

${projectList}`;
}
