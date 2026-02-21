/**
 * ToolCard — shared wrapper for expanded tool views
 *
 * Renders as `<div>` for tool-panel anchors (no native toggle interception),
 * or `<details>`/`<summary>` for all other anchors (inline collapse).
 *
 * This prevents the three-state click bug where `<details>` native toggle
 * intercepts clicks in the panel, bypassing the panel reducer.
 *
 * @module webview/blocks/views/ToolCard
 */

import type { ReactNode } from 'react';
import type { AnchorPoint } from '../types.js';

export interface ToolCardProps {
  anchor: AnchorPoint;
  /** Controls `<details open>` for non-panel anchors. Ignored for panel. */
  open: boolean;
  /** Outer element class (default: 'crispy-blocks-tool-card') */
  className?: string;
  /** Summary element class (default: 'crispy-blocks-tool-summary') */
  summaryClassName?: string;
  /** Header row content */
  summary: ReactNode;
  /** Card body */
  children: ReactNode;
}

export function ToolCard({
  anchor,
  open,
  className = 'crispy-blocks-tool-card',
  summaryClassName = 'crispy-blocks-tool-summary',
  summary,
  children,
}: ToolCardProps): ReactNode {
  if (anchor.type === 'tool-panel') {
    return (
      <div className={className}>
        <div className={summaryClassName}>{summary}</div>
        {children}
      </div>
    );
  }

  return (
    <details className={className} open={open}>
      <summary className={summaryClassName}>{summary}</summary>
      {children}
    </details>
  );
}
