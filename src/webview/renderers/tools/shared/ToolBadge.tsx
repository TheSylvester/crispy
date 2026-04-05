/**
 * Tool Badge — tool name pill with configurable style
 *
 * Supports three visual styles (controlled by badgeStyle preference):
 * - solid:   solid colored background, white text (classic)
 * - tinted:  colored text on subtle tinted background
 * - frosted: colored text, tinted bg, border, inner glow (default)
 *
 * @module webview/renderers/tools/shared/ToolBadge
 */

import { usePreferences } from '../../../context/PreferencesContext.js';

/** Light-mode color overrides — darker, more saturated versions of Dracula pastels
 *  that meet WCAG AA contrast on light (#f5f5f5) backgrounds. */
const LIGHT_MODE_COLORS: Record<string, string> = {
  '#ffb86c': '#92400e', // Bash: orange → amber-800
  '#8be9fd': '#0369a1', // Read: cyan → sky-700
  '#50fa7b': '#15803d', // Write: green → green-700
  '#ff5555': '#b91c1c', // Edit: red → red-700
  '#ff79c6': '#a21caf', // Glob: pink → fuchsia-700
  '#7dcfff': '#0e7490', // Grep: light-cyan → cyan-700
  '#bd93f9': '#6d28d9', // WebSearch: purple → violet-700
  '#e0e0e0': '#475569', // Task: gray → slate-600
  '#6272a4': '#374151', // default: blue-gray → gray-700
  '#6366f1': '#4338ca', // MCP: indigo → indigo-700
  '#888': '#555',       // secondary badges (background, timeout) → gray-600
  '#888888': '#555',    // alias
};

function isLightMode(): boolean {
  if (typeof document === 'undefined') return false;
  const kind = document.body.dataset.vscodeThemeKind;
  return kind === 'vscode-light' || kind === 'vscode-high-contrast-light';
}

interface ToolBadgeProps {
  color: string;
  textColor?: string;
  label: string;
}

/**
 * Pick white or dark text based on the background hex color's relative luminance.
 * Falls back to #fff for non-hex inputs (gradients, var(), etc.).
 */
function contrastText(bg: string): string {
  const match = bg.match(/^#([0-9a-f]{3,8})$/i);
  if (!match) return '#fff';

  let hex = match[1];
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  if (hex.length < 6) return '#fff';

  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;

  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return luminance > 0.5 ? '#1e1e1e' : '#fff';
}

/**
 * Saturated color overrides for solid badge mode.
 * Maps the current Dracula-palette pastels → the original Tailwind-saturated
 * colors that were designed for solid backgrounds with contrast text.
 */
const SOLID_COLORS: Record<string, string> = {
  '#ffb86c': '#f59e0b', // Bash: pastel orange → amber-500
  '#8be9fd': '#0ea5e9', // Read: pastel cyan → sky-500
  '#50fa7b': '#10b981', // Write, NotebookEdit: pastel green → emerald-500
  '#ff5555': '#f43f5e', // Edit, MultiEdit, TaskStop: pastel red → rose-500
  '#ff79c6': '#d946ef', // Glob: pastel pink → fuchsia-500
  '#7dcfff': '#06b6d4', // Grep, LS: pastel light-cyan → cyan-500
  '#bd93f9': '#8b5cf6', // WebSearch, TodoWrite: pastel purple → violet-500
  '#e0e0e0': '#64748b', // Task, Agent, TaskOutput, KillShell: light gray → slate-500
  '#6272a4': '#6b7280', // ToolSearch, default: muted blue-gray → gray-500
  '#6366f1': '#6366f1', // MCP: already saturated (indigo-500)
};

/** Parse #rrggbb to rgba string at given alpha. Returns null for non-hex. */
function hexToRgba(hex: string, alpha: number): string | null {
  const m = hex.match(/^#([0-9a-f]{6})$/i);
  if (!m) return null;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function ToolBadge({ color, textColor, label }: ToolBadgeProps): React.JSX.Element {
  const { badgeStyle } = usePreferences();
  const light = isLightMode();
  // In light mode, remap Dracula pastels to darker variants for contrast
  const effectiveColor = light && !textColor ? (LIGHT_MODE_COLORS[color] ?? color) : color;

  if (badgeStyle === 'solid') {
    const solidBg = SOLID_COLORS[effectiveColor] ?? effectiveColor;
    return (
      <span
        className="crispy-tool-badge"
        style={{
          color: textColor ?? contrastText(solidBg),
          background: solidBg,
        }}
      >
        {label.toLowerCase()}
      </span>
    );
  }

  if (badgeStyle === 'tinted') {
    const bg = hexToRgba(effectiveColor, light ? 0.1 : 0.12);
    return (
      <span
        className="crispy-tool-badge"
        style={{
          color: textColor ?? effectiveColor,
          background: bg ?? 'var(--tint-soft)',
        }}
      >
        {label.toLowerCase()}
      </span>
    );
  }

  // frosted (default)
  const bg = hexToRgba(effectiveColor, light ? 0.08 : 0.10);
  const border = hexToRgba(effectiveColor, light ? 0.2 : 0.25);
  return (
    <span
      className="crispy-tool-badge"
      style={{
        color: textColor ?? effectiveColor,
        background: bg ?? 'var(--tint-soft)',
        border: `1px solid ${border ?? 'var(--glass-border)'}`,
        boxShadow: `inset 0 0 8px ${hexToRgba(effectiveColor, 0.04) ?? 'transparent'}`,
      }}
    >
      {label.toLowerCase()}
    </span>
  );
}
