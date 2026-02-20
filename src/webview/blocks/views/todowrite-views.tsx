/**
 * TodoWrite Tool Views — custom renderers for TodoWrite tool
 *
 * - Compact: shows the most recently completed or in-progress item
 *
 * @module webview/blocks/views/todowrite-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';

const meta = getToolData('TodoWrite');

interface TodoItem {
  content?: string;
  status?: string;
  activeForm?: string;
}

interface TodoWriteInput {
  todos?: TodoItem[];
}

// ============================================================================
// Compact View
// ============================================================================

export function TodoWriteCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as TodoWriteInput;
  const todos = input.todos ?? [];

  // Find the most relevant item to display:
  // 1. The in-progress item (activeForm if available, else content)
  // 2. The last completed item
  // 3. Fallback to item count
  const inProgress = todos.find(t => t.status === 'in_progress');
  const completed = [...todos].reverse().find(t => t.status === 'completed');
  const displayItem = inProgress ?? completed;

  let description: ReactNode;
  if (displayItem) {
    const text = (inProgress ? displayItem.activeForm : null) ?? displayItem.content ?? '';
    if (displayItem.status === 'completed') {
      description = <s className="crispy-blocks-compact-description">{text}</s>;
    } else {
      description = <span className="crispy-blocks-compact-description">{text}</span>;
    }
  } else {
    description = <span className="crispy-blocks-compact-description">{todos.length} items</span>;
  }

  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : `${todos.length} item${todos.length !== 1 ? 's' : ''}`
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon">{meta.icon}</span>
      <ToolBadge color={meta.color} label="TodoWrite" />
      {description}
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}
