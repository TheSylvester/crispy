/**
 * ActivityGroup — unified renderer for consecutive coalesceable tool entries
 *
 * Replaces both CoalescedReadEntry and ExploredGroup with a single component
 * that renders verb-specific summaries with tool icons:
 *   Completed: "📄 Read [3], 🔍 Found [2] ✓"  (multi-tool bucket uses abstract verb)
 *   Single:    "📄 Read [3], 💻 Bash [1] ✓"    (single-tool bucket uses tool name)
 *   Running:   "📄 Reading [3], 🔍 Searching [2]... ⏳"
 *   Errors:    "📄 Read [2] ✓ · 💻 Bash [1] ✗"
 *
 * Two-level expand: Level 0 = summary line, Level 1 = individual ToolCards.
 *
 * @module webview/renderers/ActivityGroup
 */

import type { VerbBucket } from '../utils/coalesce-entries.js';
import type { ToolActivity } from '../tool-registry.js';
import type { TranscriptEntry } from '../../core/transcript.js';
import { ToolCard } from './tools/ToolCard.js';
import { ToolBadge } from './tools/shared/ToolBadge.js';

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

const VERB_LABELS: Record<ToolActivity, { past: string; gerund: string }> = {
  read:    { past: 'Read',     gerund: 'Reading'   },
  search:  { past: 'Found',    gerund: 'Searching' },
  fetch:   { past: 'Fetched',  gerund: 'Fetching'  },
  execute: { past: 'Executed', gerund: 'Executing' },
  track:   { past: 'Tracked',  gerund: 'Tracking'  },
  invoke:  { past: 'Invoked',  gerund: 'Invoking'  },
};

/** Display names for tools — used as badge label when a bucket has a single tool type */
const TOOL_DISPLAY_NAME: Record<string, string> = {
  TodoWrite:       'Todo',
  WebFetch:        'Fetch',
  WebSearch:       'Search',
  ReadMcpResource: 'Read',
  ListMcpResources:'List',
};

/**
 * Pick the badge label for a verb bucket.
 * Single tool type → use tool name directly (e.g. "Read", "Bash", "Todo").
 * Multiple tool types → use the abstract verb (e.g. "Found" for Grep+Glob).
 */
function getChipLabel(v: VerbBucket, mode: 'past' | 'gerund'): string {
  if (v.toolNames.length === 1) {
    return TOOL_DISPLAY_NAME[v.toolNames[0]] ?? v.toolNames[0];
  }
  return VERB_LABELS[v.activity][mode];
}

// ============================================================================
// Badge colors — per-tool colors match individual ToolCard badges
// ============================================================================

/** Per-tool badge colors (must match badgeColor in each tool renderer) */
const TOOL_BADGE_COLOR: Record<string, string> = {
  Read:             '#0ea5e9', // sky blue
  ReadMcpResource:  '#0ea5e9',
  Grep:             '#06b6d4', // cyan
  Glob:             '#d946ef', // fuchsia
  WebSearch:        '#8b5cf6', // purple
  WebFetch:         '#6366f1', // indigo
  Bash:             '#f59e0b', // amber
  TodoWrite:        '#8b5cf6', // purple (matches card)
  Skill:            '#7c3aed', // violet
  ListMcpResources: '#06b6d4', // cyan
};

/** Fallback colors for multi-tool buckets (blended/shared per activity) */
const ACTIVITY_BADGE_COLOR: Record<ToolActivity, string> = {
  read:    '#0ea5e9', // sky blue
  search:  '#8b5cf6', // purple
  fetch:   '#6366f1', // indigo
  execute: '#f59e0b', // amber
  track:   '#8b5cf6', // purple
  invoke:  '#7c3aed', // violet
};

/** Pick badge color: single tool type → exact tool color; multi → activity fallback */
function getChipColor(v: VerbBucket): string {
  if (v.toolNames.length === 1) {
    return TOOL_BADGE_COLOR[v.toolNames[0]] ?? ACTIVITY_BADGE_COLOR[v.activity];
  }
  return ACTIVITY_BADGE_COLOR[v.activity];
}

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

function formatVerbChip(
  icons: string[],
  label: string,
  count: number,
  color: string,
): React.ReactNode {
  return (
    <span className="crispy-activity-group__chip">
      <span className="crispy-activity-group__icons">{icons.join('')}</span>
      <ToolBadge label={label} color={color} />
      <span className="crispy-activity-group__count">[{count}]</span>
    </span>
  );
}

function formatVerbSummary(verbs: VerbBucket[], hasRunning: boolean): React.ReactNode {
  if (hasRunning) {
    // Gerund mode: "📄 Reading [3], 🔍 Searching [2]... ⏳"
    // Uses abstract gerund for all buckets (gerund of tool name reads awkwardly: "Bashing", "Globbing")
    const parts = verbs.map(v =>
      formatVerbChip(getVerbIcons(v.toolNames), getChipLabel(v, 'gerund'), v.count, getChipColor(v))
    );
    return (
      <>
        {joinWithOxfordComma(parts)}
        <span className="crispy-tool-status crispy-status-pending">{' \u23F3'}</span>
      </>
    );
  }

  // Completed mode — split into successes and errors
  // Both use the tool name when bucket has a single tool type
  const successParts: React.ReactNode[] = [];
  const errorParts: React.ReactNode[] = [];

  for (const v of verbs) {
    const label = getChipLabel(v, 'past');
    const color = getChipColor(v);
    const successCount = v.count - v.errorCount;
    if (successCount > 0) {
      successParts.push(
        formatVerbChip(getVerbIcons(v.toolNames), label, successCount, color)
      );
    }
    if (v.errorCount > 0) {
      errorParts.push(
        formatVerbChip(getVerbIcons(v.toolNames), label, v.errorCount, color)
      );
    }
  }

  if (errorParts.length === 0) {
    // All success: "📄 Read [3], 🔍 Found [2] ✓"
    return (
      <>
        {joinWithOxfordComma(successParts)}
        <span className="crispy-tool-status crispy-status-success">{' \u2713'}</span>
      </>
    );
  }

  // Mixed: "📄 Read [2] ✓ · 🔍 Not found [1] ✗"
  return (
    <>
      {successParts.length > 0 && (
        <>
          {joinWithOxfordComma(successParts)}
          <span className="crispy-tool-status crispy-status-success">{' \u2713'}</span>
        </>
      )}
      {successParts.length > 0 && (
        <span className="crispy-activity-group__error-separator">{' \u00B7 '}</span>
      )}
      <span className="crispy-activity-group__errors">
        {joinWithOxfordComma(errorParts)}
        <span className="crispy-tool-status crispy-status-error">{' \u2717'}</span>
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
  textSnippets: string[];
}

export function ActivityGroup({ toolIds, verbs, entries: _entries, hasRunning, textSnippets }: ActivityGroupProps) {
  return (
    <details
      className="crispy-activity-group"
      data-tool-ids={toolIds.join(',')}
      open={hasRunning || undefined}
    >
      <summary className="crispy-activity-group__summary">
        {formatVerbSummary(verbs, hasRunning)}
      </summary>
      <div className="crispy-activity-group__content">
        {textSnippets.length > 0 && (
          <div className="crispy-activity-group__snippets">
            {textSnippets.map((snippet, i) => (
              <div key={i} className="crispy-activity-group__text-snippet">{snippet}</div>
            ))}
          </div>
        )}
        <div className="crispy-activity-group__tools">
          {toolIds.map(id => (
            <ToolCard key={id} toolId={id} />
          ))}
        </div>
      </div>
    </details>
  );
}
