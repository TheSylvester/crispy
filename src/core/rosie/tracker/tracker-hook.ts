/**
 * Rosie Tracker Hook — Lifecycle hook for automated project tracking
 *
 * Registers as a phase-2 responseComplete handler (fires AFTER summarize).
 * Reads the fresh rosie-meta output, dispatches an ephemeral child session
 * to match/create projects, then writes results to the projects tables.
 *
 * Mirrors summarize-hook.ts structure: module state, init/shutdown,
 * dispatchChild with retry.
 *
 * @module rosie/tracker/tracker-hook
 */

import { onResponseCompleteAfter } from '../../lifecycle-hooks.js';
import type { AgentDispatch } from '../../../host/agent-dispatch.js';
import { getSettingsSnapshotInternal } from '../../settings/index.js';
import { parseModelOption } from '../../model-utils.js';
import { getLatestRosieMeta } from '../../activity-index.js';
import { pushRosieLog } from '../debug-log.js';
import { parseTrackerResponse } from './xml-extractor.js';
import { validateTrackerBlocks } from './validator.js';
import { writeTrackerResults, getExistingProjects } from './db-writer.js';

// ============================================================================
// Module State
// ============================================================================

let dispatch: AgentDispatch | null = null;
let unsubscribe: (() => void) | null = null;
const inflight = new Set<string>();

// ============================================================================
// Lifecycle
// ============================================================================

export function initRosieTracker(d: AgentDispatch): void {
  dispatch = d;
  unsubscribe = onResponseCompleteAfter(async (sessionId: string) => {
    // Capture dispatch locally — shutdown can null it while we're in-flight
    const d = dispatch;
    if (!d) return;

    // Guard: settings check
    const snap = getSettingsSnapshotInternal();
    if (!snap.settings.rosie.tracker.enabled) return;

    // Guard: pending IDs, inflight
    if (sessionId.startsWith('pending:')) return;
    if (inflight.has(sessionId)) return;

    // Look up session info
    const info = await d.findSession(sessionId);
    if (!info) return;

    // Get fresh rosie-meta (written by summarize in phase 1)
    const meta = getLatestRosieMeta(info.path);
    if (!meta || !meta.quest || !meta.summary) return;

    // Resolve model — settings override, else system default
    const rosieModel = snap.settings.rosie.tracker.model;

    inflight.add(sessionId);
    try {
      await runTrackerAnalysis(d, sessionId, info.path, info.vendor, meta, rosieModel);
    } finally {
      inflight.delete(sessionId);
    }
  });
}

export function shutdownRosieTracker(): void {
  unsubscribe?.();
  unsubscribe = null;
  dispatch = null;
}

// ============================================================================
// Analysis
// ============================================================================

const MAX_ATTEMPTS = 2;

async function runTrackerAnalysis(
  d: AgentDispatch,
  sessionId: string,
  sessionPath: string,
  parentVendor: string,
  meta: { quest?: string; title?: string; summary?: string; status?: string; entities?: string },
  modelOverride?: string,
): Promise<void> {
  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;

  // Build prompt with existing projects context
  const existingProjects = getExistingProjects();
  const existingIds = new Set(existingProjects.map((p) => p.id));
  const prompt = buildTrackerPrompt(meta, existingProjects);

  let lastResponse = '';
  let lastErrors: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const promptToSend = attempt === 1
        ? prompt
        : buildRetryPrompt(lastResponse, lastErrors);

      const result = await d.dispatchChild({
        parentSessionId: sessionId,
        vendor,
        parentVendor,
        prompt: promptToSend,
        settings: {
          ...(model && { model }),
        },
        skipPersistSession: true,
        autoClose: true,
        timeoutMs: 30_000,
      });

      if (!result) {
        console.warn(`[rosie.tracker] FAIL attempt ${attempt}/${MAX_ATTEMPTS}: dispatchChild returned null`);
        pushRosieLog({
          source: 'tracker',
          level: 'warn',
          summary: `Tracker failed: no response (attempt ${attempt}/${MAX_ATTEMPTS})`,
          data: { sessionId, attempt },
        });
        continue;
      }

      console.log(`[rosie.tracker] OK response:`, result.text.slice(0, 500));
      lastResponse = result.text;

      // Parse
      const blocks = parseTrackerResponse(result.text);
      if (blocks.length === 0) {
        console.warn(`[rosie.tracker] No tracker blocks parsed from response`);
        pushRosieLog({
          source: 'tracker',
          level: 'warn',
          summary: `Tracker: no blocks parsed (attempt ${attempt}/${MAX_ATTEMPTS})`,
          data: { sessionId, attempt, responseSnippet: result.text.slice(0, 300) },
        });
        // No blocks could mean the session was trivial — not necessarily an error
        if (attempt === 1) continue;
        return;
      }

      // Validate
      const validation = validateTrackerBlocks(blocks, existingIds);

      if (validation.errors.length > 0 && attempt < MAX_ATTEMPTS) {
        console.warn(`[rosie.tracker] Validation errors (attempt ${attempt}):`, validation.errors);
        lastErrors = validation.errors;
        pushRosieLog({
          source: 'tracker',
          level: 'warn',
          summary: `Tracker: validation errors, retrying (attempt ${attempt}/${MAX_ATTEMPTS})`,
          data: { sessionId, attempt, errors: validation.errors },
        });
        continue;
      }

      if (validation.errors.length > 0) {
        console.warn(`[rosie.tracker] Validation errors after final attempt:`, validation.errors);
        pushRosieLog({
          source: 'tracker',
          level: 'warn',
          summary: `Tracker: validation errors after ${MAX_ATTEMPTS} attempts`,
          data: { sessionId, errors: validation.errors },
        });
      }

      // Write valid blocks
      if (validation.valid.length > 0) {
        writeTrackerResults(validation.valid, sessionPath);

        pushRosieLog({
          source: 'tracker',
          level: 'info',
          summary: `Tracker: ${validation.valid.length} project(s) updated`,
          data: {
            sessionId,
            projects: validation.valid.map((b) => ({
              id: b.project.id || '(new)',
              title: b.project.title,
              status: b.project.status,
            })),
          },
        });
      }
      return;
    } catch (err) {
      console.warn(`[rosie.tracker] FAIL attempt ${attempt}/${MAX_ATTEMPTS} threw:`, err);
      pushRosieLog({
        source: 'tracker',
        level: 'error',
        summary: `Tracker failed: ${err instanceof Error ? err.message : String(err)}`,
        data: { sessionId, attempt, error: String(err) },
      });
    }
  }
}

// ============================================================================
// Prompt Building
// ============================================================================

const TRACKER_SYSTEM_PROMPT = `You are a project tracker. You receive a session summary and a list of existing projects. Your job is to link this session's topics to existing projects or create new ones.

## Input

You will receive:
1. A session summary with: title, quest (main topic), sidequests (tangential topics), status, and entities
2. A list of existing projects with: id, title, status, and key entities

## Task

For each topic (quest and each sidequest), determine:
- Does it match an existing project? → upsert with that project's id
- Is it new work not covered by any existing project? → upsert with empty id

## Matching Rules (in priority order)

1. Title similarity — if the topic closely matches an existing project title, it's the same project
2. Entity overlap — shared files, branches, or function names confirm a match when titles differ
3. Quest continuity — if the topic describes work that continues an existing project's goal (e.g. one planned it, this one built it), it's the same project
4. Status progression — if the topic picks up where an existing project left off (planned → active, active → done), that reinforces a match

Only create a new project when no existing project is a reasonable match.

## Merge Rule

If this session and prior sessions form one arc (diagnosis → root cause → fix), they belong to the same project. Do not create a new project for each phase.

## Nest Rule

If this session orchestrated sub-tasks (e.g. parallel worktree sprint), use parent_id to group children under the orchestrating project.

## Status Values

Use exactly one of: active, done, blocked, planned, abandoned

## Output Format

Output one <tracker> block per project this session touches. Nothing else — no commentary, no explanation.

<tracker>
  <project action="upsert" id="existing-project-uuid OR empty-for-new">
    <title>Short, stable project title</title>
    <status>active|done|blocked|planned|abandoned</status>
    <blocked_by>Why it's blocked (only if status is blocked, otherwise empty)</blocked_by>
    <summary>1-2 sentence summary of current project state</summary>
    <category>recall|ui|infra|research|meta</category>
    <branch>git branch name if applicable, otherwise empty</branch>
    <entities>["file1.ts","file2.ts","concept1","concept2"]</entities>
  </project>
  <session detected_in="message-uuid" />
  <file path="relative/path/to/file" note="Why this file is relevant" />
  <file path="another/file" note="Description" />
</tracker>

Rules for the output:
- title: Keep stable across runs. Don't rename a project unless its scope fundamentally changed.
- summary: Reflect the CURRENT state, not history. What's true right now?
- entities: Top 5-10. Include files, branches, key concepts. These are used for future matching.
- files: Only list files that are meaningful artifacts — plans, specs, implementations. Not every file touched.
- If a topic is trivial (quick recall, empty session, false start), do not create a project for it.`;

/** Build the full tracker prompt (system + user context). Exported for replay-harness reuse. */
export function buildTrackerPrompt(
  meta: { quest?: string; title?: string; summary?: string; status?: string; entities?: string },
  projects: { id: string; title: string; status: string; entities: string }[],
): string {
  const projectList = projects.length > 0
    ? projects.map((p) => `[${p.id}] ${p.title} (${p.status}) — entities: ${p.entities}`).join('\n')
    : 'No existing projects yet.';

  return `${TRACKER_SYSTEM_PROMPT}

---

## Session Summary

Title: ${meta.title ?? ''}
Quest: ${meta.quest ?? ''}
Status: ${meta.status ?? ''}
Entities: ${meta.entities ?? '[]'}

## Existing Projects

${projectList}`;
}

function buildRetryPrompt(lastResponse: string, errors: string[]): string {
  return `Your previous output had validation errors. Please fix them and output corrected <tracker> blocks.

## Validation Errors

${errors.map((e) => `- ${e}`).join('\n')}

## Your Previous Output

${lastResponse}

Please output corrected <tracker> blocks. Nothing else — no commentary, no explanation.`;
}
