/**
 * TodoWrite Tool Views — custom renderers for TodoWrite tool
 *
 * - Compact: dot-line with colored "todo" + current item + status
 * - Expanded: full checklist with status icons and styling
 *
 * @module webview/blocks/views/todowrite-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData } from '../tool-definitions.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { ToolCard } from './ToolCard.js';
import { CompactBlock } from './default-views.js';

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
  const todos = Array.isArray(input.todos) ? input.todos : [];

  // Find the most relevant item to display
  const inProgress = todos.find(t => t.status === 'in_progress');
  const completed = [...todos].reverse().find(t => t.status === 'completed');
  const displayItem = inProgress ?? completed;

  let subject: string;
  if (displayItem) {
    const text = (inProgress ? displayItem.activeForm : null) ?? displayItem.content ?? '';
    subject = text;
  } else {
    subject = `${todos.length} items`;
  }

  return (
    <CompactBlock
      icon={meta.icon}
      color={meta.color}
      name="Todo"
      subject={subject}
      status={status}
    />
  );
}

// ============================================================================
// Expanded View — full checklist with status icons
// ============================================================================

export function TodoWriteExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as TodoWriteInput;
  const todos = Array.isArray(input.todos) ? input.todos : [];

  const itemCount = todos.length;
  const resultSummary = result
    ? result.is_error
      ? 'Error'
      : `${itemCount} item${itemCount !== 1 ? 's' : ''}`
    : undefined;

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon">{meta.icon}</span>
        <ToolBadge color={meta.color} label="Todo" />
        <span className="crispy-blocks-compact-subject">({itemCount} items)</span>
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {todos.length > 0 && (
        <ul className="crispy-todo-list">
          {todos.map((todo, i) => {
            const s = todo.status || 'pending';
            const icon = s === 'completed' ? '\u2713' : s === 'in_progress' ? '\u25B6' : '\u2610';
            const cls = s === 'completed'
              ? 'crispy-todo--completed'
              : s === 'in_progress'
                ? 'crispy-todo--in-progress'
                : '';
            return (
              <li key={i} className={`crispy-todo-item ${cls}`}>
                <span className="crispy-todo-icon">{icon}</span>
                <span className="crispy-todo-content">{todo.content}</span>
              </li>
            );
          })}
        </ul>
      )}
    </ToolCard>
  );
}
