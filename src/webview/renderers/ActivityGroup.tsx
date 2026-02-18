/**
 * ActivityGroup — unified renderer for consecutive coalesceable tool entries
 *
 * Replaces both CoalescedReadEntry and ExploredGroup with a single component
 * that renders verb-specific summaries with tool icons:
 *   Completed: "📄 Read [3], 🔍 Found [2] ✓"
 *   Running:   "📄 Reading [3], 🔍 Searching [2]... ⏳"
 *   Errors:    "📄 Read [2] ✓ · 🔍 Not found [1] ✗"
 *
 * Two-level expand: Level 0 = summary line, Level 1 = individual ToolCards.
 *
 * @module webview/renderers/ActivityGroup
 */

import type { VerbBucket } from '../utils/coalesce-entries.js';
import type { ToolActivity } from '../tool-registry.js';
import type { TranscriptEntry } from '../../core/transcript.js';
import { ToolCard } from './tools/ToolCard.js';

// ============================================================================
// Tool icon map — matches icons used in individual tool renderers
// ============================================================================

const TOOL_ICON_MAP: Record<string, string> = {
  Read:            '\uD83D\uDCC4', // 📄
  ReadMcpResource: '\uD83D\uDCC4', // 📄
  Grep:            '\uD83D\uDD0D', // 🔍
  Glob:            '\uD83D\uDCC2', // 📂
  WebSearch:       '\uD83C\uDF10', // 🌐
  WebFetch:        '\uD83C\uDF0E', // 🌎
  Bash:            '\uD83D\uDCBB', // 💻
  TodoWrite:       '\u2611',       // ☑
  Skill:           '\u2728',       // ✨
  ListMcpResources:'\uD83D\uDD0D', // 🔍
};

const DEFAULT_ICON = '\uD83D\uDD27'; // 🔧

function getToolIcon(name: string): string {
  return TOOL_ICON_MAP[name] ?? DEFAULT_ICON;
}

/** Get unique icons for a verb bucket's tool names, preserving first-occurrence order */
function getVerbIcons(toolNames: string[]): string[] {
  const seen = new Set<string>();
  const icons: string[] = [];
  for (const name of toolNames) {
    const icon = getToolIcon(name);
    if (!seen.has(icon)) {
      seen.add(icon);
      icons.push(icon);
    }
  }
  return icons;
}

// ============================================================================
// Verb display labels
// ============================================================================

const VERB_LABELS: Record<ToolActivity, { past: string; gerund: string; error: string }> = {
  read:    { past: 'Read',     gerund: 'Reading',    error: 'Not read' },
  search:  { past: 'Found',    gerund: 'Searching',  error: 'Not found' },
  fetch:   { past: 'Fetched',  gerund: 'Fetching',   error: 'Not fetched' },
  execute: { past: 'Executed', gerund: 'Executing',  error: 'Failed' },
  track:   { past: 'Tracked',  gerund: 'Tracking',   error: 'Not tracked' },
  invoke:  { past: 'Invoked',  gerund: 'Invoking',   error: 'Not invoked' },
};

// ============================================================================
// Summary formatting
// ============================================================================

function joinWithOxfordComma(parts: React.ReactNode[]): React.ReactNode {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return <>{parts[0]}{' and '}{parts[1]}</>;
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 && (i < parts.length - 1 ? ', ' : ', and ')}
          {p}
        </span>
      ))}
    </>
  );
}

function formatVerbChip(icons: string[], label: string, count: number): React.ReactNode {
  return (
    <span className="crispy-activity-group__chip">
      <span className="crispy-activity-group__icons">{icons.join('')}</span>
      {`${label} [${count}]`}
    </span>
  );
}

function formatVerbSummary(verbs: VerbBucket[], hasRunning: boolean): React.ReactNode {
  if (hasRunning) {
    // Gerund mode: "📄 Reading [3], 🔍 Searching [2]... ⏳"
    const parts = verbs.map(v =>
      formatVerbChip(getVerbIcons(v.toolNames), VERB_LABELS[v.activity].gerund, v.count)
    );
    return (
      <>
        {joinWithOxfordComma(parts)}
        <span className="crispy-status-pending">{' \u23F3'}</span>
      </>
    );
  }

  // Completed mode — split into successes and errors
  const successParts: React.ReactNode[] = [];
  const errorParts: React.ReactNode[] = [];

  for (const v of verbs) {
    const successCount = v.count - v.errorCount;
    if (successCount > 0) {
      successParts.push(
        formatVerbChip(getVerbIcons(v.toolNames), VERB_LABELS[v.activity].past, successCount)
      );
    }
    if (v.errorCount > 0) {
      errorParts.push(
        formatVerbChip(getVerbIcons(v.toolNames), VERB_LABELS[v.activity].error, v.errorCount)
      );
    }
  }

  if (errorParts.length === 0) {
    // All success: "📄 Read [3], 🔍 Found [2] ✓"
    return (
      <>
        {joinWithOxfordComma(successParts)}
        <span className="crispy-status-success">{' \u2713'}</span>
      </>
    );
  }

  // Mixed: "📄 Read [2] ✓ · 🔍 Not found [1] ✗"
  return (
    <>
      {successParts.length > 0 && (
        <>
          {joinWithOxfordComma(successParts)}
          <span className="crispy-status-success">{' \u2713'}</span>
        </>
      )}
      {successParts.length > 0 && (
        <span className="crispy-activity-group__error-separator">{' \u00B7 '}</span>
      )}
      <span className="crispy-activity-group__errors">
        {joinWithOxfordComma(errorParts)}
        <span className="crispy-status-error">{' \u2717'}</span>
      </span>
    </>
  );
}

// ============================================================================
// Component
// ============================================================================

interface ActivityGroupProps {
  toolIds: string[];
  verbs: VerbBucket[];
  entries: TranscriptEntry[];
  hasRunning: boolean;
}

export function ActivityGroup({ toolIds, verbs, entries: _entries, hasRunning }: ActivityGroupProps) {
  return (
    <details
      className="crispy-activity-group"
      data-tool-ids={toolIds.join(',')}
      open={hasRunning || undefined}
    >
      <summary className="crispy-activity-group__summary">
        {formatVerbSummary(verbs, hasRunning)}
      </summary>
      <div className="crispy-activity-group__tools">
        {toolIds.map(id => (
          <ToolCard key={id} toolId={id} />
        ))}
      </div>
    </details>
  );
}
