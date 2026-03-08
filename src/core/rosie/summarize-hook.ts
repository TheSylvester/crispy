/**
 * Rosie Summarize Hook — Auto-extracts quest, summary, and entities after each turn
 *
 * Registers as a responseComplete lifecycle handler. On each turn completion,
 * dispatches an ephemeral child session to query a model for plain-text
 * output, then parses the response and writes results to the activity index.
 *
 * Uses dispatch.dispatchChild() — the shared child session primitive in
 * session-manager — rather than hand-rolling session lifecycle management.
 *
 * @module rosie/summarize-hook
 */

import { onResponseComplete } from '../lifecycle-hooks.js';
import type { AgentDispatch } from '../../host/agent-dispatch.js';
import { getSettingsSnapshotInternal } from '../settings/index.js';
import { parseModelOption } from '../model-utils.js';
import { appendActivityEntries } from '../activity-index.js';
import { refreshAndNotify } from '../session-list-manager.js';
import { pushRosieLog } from './debug-log.js';
import { extractTag, normalizeEntitiesJson } from './xml-utils.js';

// ============================================================================
// Module State
// ============================================================================

let dispatch: AgentDispatch | null = null;
let unsubscribe: (() => void) | null = null;
const inflight = new Set<string>();

// ============================================================================
// Lifecycle
// ============================================================================

export function initRosieSummarize(d: AgentDispatch): void {
  dispatch = d;
  unsubscribe = onResponseComplete(async (sessionId: string) => {
    // Capture dispatch locally — shutdownRosieSummarize() can set the module-level
    // variable to null while this async handler is in-flight.
    const d = dispatch;
    if (!d) return;

    // Guard: settings check
    const snap = getSettingsSnapshotInternal();
    if (!snap.settings.rosie.summarize.enabled) return;

    // Guard: pending IDs, inflight
    if (sessionId.startsWith('pending:')) return;
    if (inflight.has(sessionId)) return;

    // Look up session info (child session guard is handled by lifecycle-hooks)
    const info = await d.findSession(sessionId);
    if (!info) return;

    // Resolve model — settings override, else system default
    const rosieModel = snap.settings.rosie.summarize.model; // "vendor:model" or undefined

    inflight.add(sessionId);
    try {
      await runSummarizeAnalysis(d, sessionId, info.path, info.vendor, rosieModel);
    } finally {
      inflight.delete(sessionId);
    }
  });
}

export function shutdownRosieSummarize(): void {
  unsubscribe?.();
  unsubscribe = null;
  dispatch = null;
}

// ============================================================================
// Response Parsing
// ============================================================================

/**
 * Parse the summarize hook's XML-tagged response into structured fields.
 *
 * Expects tags:
 *   <goal>...</goal>
 *   <title>...</title>
 *   <summary>...</summary>
 *   <status>...</status>
 *   <entities>...</entities>  (optional)
 *
 * Uses regex extraction — tags can appear anywhere in the response.
 * Returns null if goal or summary is missing.
 */
function parseSummarizeResponse(text: string): {
  quest: string;
  title: string;
  summary: string;
  status: string;
  entities: string;
} | null {
  const quest = extractTag(text, 'goal');
  const title = extractTag(text, 'title');
  const summary = extractTag(text, 'summary');
  const status = extractTag(text, 'status');
  const entities = normalizeEntitiesJson(extractTag(text, 'entities'));

  if (quest && summary) return { quest, title, summary, status, entities };
  return null;
}

// ============================================================================
// Analysis
// ============================================================================

const MAX_ATTEMPTS = 2;

async function runSummarizeAnalysis(
  d: AgentDispatch,
  sessionId: string, sessionPath: string, parentVendor: string,
  modelOverride?: string,
): Promise<void> {
  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const result = await d.dispatchChild({
        parentSessionId: sessionId,
        vendor,
        parentVendor,
        prompt: SUMMARIZE_PROMPT,
        settings: {
          ...(model && { model }),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
        skipPersistSession: true,
        autoClose: true,
        timeoutMs: 30_000,
      });

      if (!result) {
        console.warn(`[rosie.summarize] FAIL attempt ${attempt}/${MAX_ATTEMPTS}: dispatchChild returned null`);
        pushRosieLog({
          source: 'summarize',
          level: 'warn',
          summary: `Summarize failed: no response (attempt ${attempt}/${MAX_ATTEMPTS})`,
          data: { sessionId, attempt },
        });
        continue;
      }

      console.log(`[rosie.summarize] OK response:`, result.text.slice(0, 500));

      const fields = parseSummarizeResponse(result.text);
      if (!fields) {
        console.warn(`[rosie.summarize] FAIL parse: could not extract quest/summary from response: ${result.text.slice(0, 300)}`);
        pushRosieLog({
          source: 'summarize',
          level: 'warn',
          summary: `Summarize failed: parse error (attempt ${attempt}/${MAX_ATTEMPTS})`,
          data: { sessionId, attempt, responseSnippet: result.text.slice(0, 300) },
        });
        continue;
      }

      // Write to activity index
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
        entities: fields.entities,
      }]);

      // Push updated metadata to all UI subscribers
      refreshAndNotify(sessionId);

      // Push to rosie log stream
      let parsedEntities: string[] = [];
      try { parsedEntities = JSON.parse(fields.entities); } catch { /* keep empty */ }
      pushRosieLog({
        source: 'summarize',
        level: 'info',
        summary: `Summarize: ${fields.title || fields.quest}`,
        data: {
          quest: fields.quest,
          title: fields.title,
          summary: fields.summary,
          status: fields.status,
          entities: parsedEntities,
          sessionId,
        },
      });
      return;
    } catch (err) {
      console.warn(`[rosie.summarize] FAIL attempt ${attempt}/${MAX_ATTEMPTS} threw:`, err);
      pushRosieLog({
        source: 'summarize',
        level: 'error',
        summary: `Summarize failed: ${err instanceof Error ? err.message : String(err)}`,
        data: { sessionId, attempt, error: String(err) },
      });
    }
  }
}

// ============================================================================
// Constants
// ============================================================================

export const SUMMARIZE_PROMPT = `Consider this entire conversation so far.
What is the stated or apparent goal of this particular conversation?
How would you label this conversation in a short sentence for a user to best remember what this session was for?
Summarize the last turn: Describe the User Request and your Response; including any work completed
What is the current status of the work in this conversation? Describe where things stand right now — what's done, what's in progress, what's blocked or paused.
List the key entities mentioned in this conversation as a JSON array: file paths, function/class names, technical concepts, tools used, error types, libraries, and architectural decisions. Short identifiers only, no descriptions.

Provide your output in this format:
<goal>The goal of this conversation</goal>
<title>Label the conversation</title>
<summary>Turn summary</summary>
<status>Current status of the work</status>
<entities>["src/auth.ts", "JWT", "mutex", "ECONNREFUSED", "react-query", "prefer composition over inheritance"]</entities>`;
