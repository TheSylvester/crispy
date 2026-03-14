/**
 * Rosie Bot Hook — Two-turn child session for summarization + project tracking
 *
 * Registers on onResponseCompleteAfter (phase 2, after ingest populates the
 * messages table). Dispatches a single child session with two turns:
 *   Turn 1: Summarize — XML extraction of goal/title/summary/status
 *   Turn 2: Track — MCP tools for project upsert/trivial marking
 *
 * The model carries its summary forward in context between turns. Turn 2
 * benefits from cached input tokens (transcript already in KV cache).
 * The MCP server subprocess is restarted between turns from the same config;
 * the decisions sidecar file persists on disk across turns.
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
import type { Vendor } from '../transcript.js';
import { appendActivityEntries, getLatestRosieMeta, getAllRosieMetas } from '../activity-index.js';
import { refreshAndNotify } from '../session-list-manager.js';
import { closeSession } from '../session-manager.js';
import { pushRosieLog } from './debug-log.js';
import { extractTag } from './xml-utils.js';
import { getExistingProjects, recordTrackerOutcome, runDedupSweep } from './tracker/db-writer.js';
import { pushTrackerNotification } from './tracker/tracker-notifications.js';
import { buildInternalMcpConfig } from '../../mcp/servers/external.js';
import type { TrackerDecision } from '../../mcp/servers/internal.js';
import type { InternalServerPaths } from './tracker/types.js';
import { readSessionMessages, getSessionMessageCount, inferRole } from '../recall/message-store.js';

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

export function initRosieBot(d: AgentDispatch, paths: InternalServerPaths): void {
  dispatch = d;
  serverPaths = paths;

  unsubscribe = onResponseCompleteAfter(async (sessionId: string) => {
    const d = dispatch;
    if (!d) return;

    const snap = getSettingsSnapshotInternal();
    if (!snap.settings.rosie.bot.enabled) {
      pushRosieLog({ source: 'rosie-bot', level: 'info', summary: 'Rosie-bot: skipped (disabled)' });
      return;
    }

    if (sessionId.startsWith('pending:')) {
      pushRosieLog({ source: 'rosie-bot', level: 'info', summary: 'Rosie-bot: skipped (pending ID)' });
      return;
    }
    if (inflight.has(sessionId)) {
      pushRosieLog({ source: 'rosie-bot', level: 'info', summary: 'Rosie-bot: skipped (already running)' });
      return;
    }

    const info = await d.findSession(sessionId);
    if (!info) {
      pushRosieLog({ source: 'rosie-bot', level: 'warn', summary: `Rosie-bot: skipped (session ${sessionId.slice(0, 12)}… not found)` });
      return;
    }

    const rosieModel = snap.settings.rosie.bot.model;

    inflight.add(sessionId);
    pushRosieLog({ source: 'rosie-bot', level: 'info', summary: `Rosie-bot: starting for ${sessionId.slice(0, 12)}…`, data: { sessionId, vendor: info.vendor } });
    try {
      await runRosieBot(d, sessionId, info.path, info.vendor, rosieModel);
    } finally {
      inflight.delete(sessionId);
    }
  });
}

export function shutdownRosieBot(): void {
  unsubscribe?.();
  unsubscribe = null;
  dispatch = null;
  serverPaths = null;
}

// ============================================================================
// Two-Turn Orchestrator
// ============================================================================

async function runRosieBot(
  d: AgentDispatch,
  sessionId: string,
  sessionPath: string,
  parentVendor: string,
  modelOverride?: string,
): Promise<void> {
  // Capture serverPaths early — shutdown can null it while we're in-flight
  const paths = serverPaths;
  if (!paths) {
    pushRosieLog({ source: 'rosie-bot', level: 'warn', summary: 'Rosie-bot: skipped (shutdown in progress)' });
    return;
  }

  const parsed = modelOverride ? parseModelOption(modelOverride) : undefined;
  const vendor = parsed?.vendor ?? parentVendor;
  const model = parsed?.model;

  pushRosieLog({ source: 'rosie-bot', level: 'info', summary: `Rosie-bot: using ${vendor}/${model || 'default'}`, data: { vendor, model } });

  // 1. Assemble bookend transcript from messages table
  const transcript = assembleBookendTranscript(sessionId, sessionPath, vendor as Vendor, model);
  if (!transcript) {
    pushRosieLog({ source: 'rosie-bot', level: 'info', summary: 'Rosie-bot: skipped (no messages indexed yet)' });
    return;
  }

  // 2. Turn 1: Summarize
  const summarizeResult = await runSummarizeTurn(d, sessionId, sessionPath, vendor, parentVendor, model, transcript, paths);
  if (!summarizeResult) return;

  // 3. Turn 2: Track (resume the child session)
  try {
    await runTrackerTurn(d, summarizeResult.childSessionId, summarizeResult.decisionsFile, sessionId, sessionPath, model);
  } finally {
    // Ensure child session is always cleaned up — close is idempotent
    closeSession(summarizeResult.childSessionId);
    try { unlinkSync(summarizeResult.decisionsFile); } catch { /* best-effort */ }
  }
}

// ============================================================================
// Bookend Transcript Assembly
// ============================================================================

/** 30% of model context window, ~3 chars per token. */
function transcriptBudget(vendor: Vendor, model?: string): number {
  return Math.floor(getContextWindowTokens(vendor, model) * 0.3 * 3);
}

function assembleBookendTranscript(sessionId: string, sessionPath: string, vendor?: Vendor, model?: string): string | null {
  const budget = transcriptBudget((vendor ?? 'claude') as Vendor, model);
  // Fetch only the bookend messages we need (first 2 + last 3), not the full session
  const total = getSessionMessageCount(sessionId);
  if (total === 0) return null;

  const firstN = 2;
  const lastM = 3;

  const firstPage = readSessionMessages(sessionId, 0, firstN);
  if (!firstPage) return null;
  const first = firstPage.messages;

  // Only fetch tail if it doesn't overlap with the head
  const lastOffset = Math.max(firstN, total - lastM);
  const last = total > firstN
    ? (readSessionMessages(sessionId, lastOffset, lastM)?.messages ?? [])
    : [];

  // Fetch existing rosie-metas for the middle section
  const metas = getAllRosieMetas(sessionPath);

  // Build payload sections first (last 3 + rosie-metas) — these are sacred
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

  // Budget remaining for the opening turns (context, compressible)
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
      // Fit what we can from this message, then stop
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
// Turn 1: Summarize
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

async function runSummarizeTurn(
  d: AgentDispatch,
  sessionId: string,
  sessionPath: string,
  vendor: string,
  parentVendor: string,
  model: string | undefined,
  transcript: string,
  paths: InternalServerPaths,
): Promise<{ childSessionId: string; decisionsFile: string } | null> {
  const prompt = buildSummarizePrompt(transcript);

  for (let attempt = 1; attempt <= MAX_SUMMARIZE_ATTEMPTS; attempt++) {
    const decisionsFile = createDecisionsFile();

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
        autoClose: false,  // keep alive for turn 2
        mcpServers: buildInternalMcpConfig(paths.command, paths.args, [
          `--session-file=${sessionPath}`,
          `--decisions-file=${decisionsFile}`,
        ]),
        env: {
          CLAUDECODE: '',
          CLAUDE_CODE_STREAM_CLOSE_TIMEOUT: '30000',
        },
        timeoutMs: 30_000,
      });

      if (!result) {
        pushRosieLog({ source: 'rosie-bot:summarize', level: 'warn',
          summary: `Summarize failed: no response (attempt ${attempt})` });
        try { unlinkSync(decisionsFile); } catch { /* best-effort */ }
        continue;
      }

      const fields = parseSummarizeResponse(result.text);
      if (!fields) {
        pushRosieLog({ source: 'rosie-bot:summarize', level: 'warn',
          summary: `Summarize failed: XML parse error (attempt ${attempt})`,
          data: { responseSnippet: result.text.slice(0, 300) } });
        // Close this child since we'll retry with a fresh one
        closeSession(result.sessionId);
        try { unlinkSync(decisionsFile); } catch { /* best-effort */ }
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
        entities: '[]',
      }]);

      refreshAndNotify(sessionId);

      pushRosieLog({ source: 'rosie-bot:summarize', level: 'info',
        summary: `Summarize: ${fields.title || fields.quest}`,
        data: { quest: fields.quest, title: fields.title, status: fields.status } });

      return { childSessionId: result.sessionId, decisionsFile };
    } catch (err) {
      pushRosieLog({ source: 'rosie-bot:summarize', level: 'error',
        summary: `Summarize error: ${err instanceof Error ? err.message : String(err)}` });
      try { unlinkSync(decisionsFile); } catch { /* best-effort */ }
    }
  }

  pushRosieLog({ source: 'rosie-bot:summarize', level: 'warn',
    summary: `Summarize: all ${MAX_SUMMARIZE_ATTEMPTS} attempts failed` });
  return null;
}

// ============================================================================
// Turn 2: Tracker
// ============================================================================

const TRACKER_SYSTEM_PROMPT = `You are a project tracker. You receive a session summary and a list of existing projects. \
Your job is to identify EVERY distinct project this session touched and file each one.

You have three tools:
- **create_project** — Create a NEW project. Use when this session's work doesn't match any existing project.
- **track_project** — Update an EXISTING project. Provide only fields that changed. Always auto-links the session.
- **mark_trivial** — Mark the session as not warranting any project (quick recall, empty session, false start).

## Task

Analyze the session summary. Identify each distinct workstream:
- Does it match an existing project? → call track_project with that project's id and only the fields that changed
- Is it new work? → call create_project with all required fields
- Is the entire session trivial? → call mark_trivial

**Look for multiple projects.** Sessions often contain a primary quest plus secondary work — a sidequest, a tangential fix, a plan saved for a different feature, or a skill/tool created alongside the main work. If the session title contains "+", "&", or describes two unrelated topics, there are almost certainly multiple projects.

## Stage Values

- **active** — work in progress right now
- **planning** — designing, speccing, not yet building
- **ready** — spec'd and ready to start, waiting for bandwidth
- **committed** — scheduled, will start soon
- **paused** — on hold (use blocked_by to explain why)
- **archived** — completed or abandoned

## Field Guidance

- **icon**: Pick a single emoji that represents the project domain (🔧 tooling, 📊 data, 🎨 UI, etc.)
- **status**: What is true RIGHT NOW — 1-2 sentences of freeform narrative
- **summary**: Stable description of what this project IS — set once on create, rarely changed
- **stage**: The organizational phase. For track_project, only include if it actually changed
- **entities**: Top 5-10. Include files, branches, key concepts. **Ignore stable infrastructure** — don't include foundational files that appear in many sessions unless the session specifically modified them.
- **files**: Non-code artifacts only — plans, specs, design docs. Source code belongs in entities. Omit if none.

## Matching Rules (priority order)

1. **Title similarity** — if the topic closely matches an existing project title, it's the same project
2. **Entity overlap** — shared files, branches, or function names confirm a match when titles differ
3. **Quest continuity** — if the topic continues an existing project's goal, same project
4. **Stage progression** — if the topic picks up where an existing project left off, that reinforces a match

Only create a new project when no existing project is a reasonable match.

## Merge Rule

If this session and prior sessions form one arc (diagnosis → root cause → fix), they belong to the same project. Do not create a new project for each phase.

## Recall Rule

If the session's primary activity was looking up, recapping, or checking the status of prior work — it is **trivial**. The recalled content belongs to the original sessions, not this one.

**Trivial signals** (any of these → strongly consider mark_trivial):
- Quest mentions: "recall", "did we discuss", "status check", "refresh understanding", "recap"
- Session is a brief conversation with no code changes or design decisions
- Session rehashes or summarizes prior work without advancing it
- Session asks about or retrieves information but produces no artifacts

Only create a project if the session performed **NEW work** beyond retrieval.

**You MUST call your tools.** Do not emit JSON, markdown, or commentary. Call create_project, track_project, or mark_trivial directly.`;

export function buildTrackerPrompt(
  meta: { quest?: string; title?: string; summary?: string; status?: string },
  projects: { id: string; title: string; stage: string; status: string | null; icon: string | null; entities: string }[],
): string {
  const projectList = projects.length > 0
    ? projects.map((p) => `[${p.id}] ${p.icon ?? ''} ${p.title} [${p.stage}] ${p.status ?? ''} — entities: ${p.entities}`).join('\n')
    : 'No existing projects yet.';

  const summaryLine = meta.summary ? `Summary: ${meta.summary}\n` : '';

  return `${TRACKER_SYSTEM_PROMPT}

---

## Session Summary

Title: ${meta.title ?? ''}
Quest: ${meta.quest ?? ''}
${summaryLine}Status: ${meta.status ?? ''}

## Existing Projects

${projectList}`;
}

const MAX_TRACKER_ATTEMPTS = 3;

async function runTrackerTurn(
  d: AgentDispatch,
  childSessionId: string,
  decisionsFile: string,
  parentSessionId: string,
  sessionPath: string,
  model: string | undefined,
): Promise<void> {
  const existingProjects = getExistingProjects();
  const meta = getLatestRosieMeta(sessionPath);

  for (let attempt = 1; attempt <= MAX_TRACKER_ATTEMPTS; attempt++) {
    const retryNudge = attempt === 2
      ? '\n\nIMPORTANT: Your previous attempt failed because you did not call any tools. You MUST call upsert_project or mark_trivial.'
      : attempt >= 3
        ? '\n\nCRITICAL FINAL ATTEMPT: Call upsert_project or mark_trivial RIGHT NOW. Tools only.'
        : '';

    const prompt = buildTrackerPrompt(meta ?? {}, existingProjects) + retryNudge;

    try {
      await d.resumeChild({
        sessionId: childSessionId,
        prompt,
        settings: {
          ...(model && { model }),
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
        },
        autoClose: false,  // runRosieBot's finally handles cleanup
        timeoutMs: 30_000,
      });

      // Read decisions from sidecar (written by MCP tool handlers).
      const decisions = readDecisions(decisionsFile);

      if (decisions.length > 0) {
        logDecisions(decisions, parentSessionId);
        runDedupSweep(d.dispatchChild).catch((err) => {
          console.warn('[rosie-bot:tracker] Dedup sweep failed:', err);
        });
        return;
      }

      pushRosieLog({ source: 'rosie-bot:tracker', level: 'warn',
        summary: `Tracker: no tool calls (attempt ${attempt})` });
    } catch (err) {
      pushRosieLog({ source: 'rosie-bot:tracker', level: 'error',
        summary: `Tracker error: ${err instanceof Error ? err.message : String(err)}` });
    }
  }

  recordTrackerOutcome(sessionPath, 'failed', MAX_TRACKER_ATTEMPTS, 'All attempts exhausted — no tool calls');
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

/** Read the decisions sidecar file. Pure read — does NOT delete the file. */
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

/** Push individual rosie log entries and tracker notifications for each decision. */
function logDecisions(decisions: TrackerDecision[], sessionId: string): void {
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
  const trivials = decisions.filter(d => d.tool === 'mark_trivial').length;
  pushRosieLog({ source: 'rosie-bot:tracker', level: 'info', summary: `Tracker: ${decisions.length} decisions (${creates} create, ${tracks} track, ${trivials} trivial)`, data: { sessionId, total: decisions.length, creates, tracks, trivials } });
}
