/**
 * TodoWrite Tool Renderer
 *
 * Shows todo item count in header, checklist in body (expanded by default).
 * Mirrors Leto's todo rendering: status icons (☐/▶/☑), strikethrough on
 * completed items, yellow highlight on in-progress.
 *
 * @module webview/renderers/tools/TodoTool
 */

import { useToolEntry } from '../../context/ToolRegistryContext.js';
import { ToolCardShell } from './shared/ToolCardShell.js';
import { isTodoWriteInput } from '../../../core/transcript.js';
import type { ToolInput } from '../../../core/transcript.js';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

export function TodoTool({ toolId }: { toolId: string }): React.JSX.Element | null {
  const entry = useToolEntry(toolId);
  if (!entry) return null;

  const input = isTodoWriteInput(entry.input as ToolInput)
    ? (entry.input as ToolInput & { todos: TodoItem[] })
    : null;

  const todos = input?.todos ?? [];
  const itemCount = todos.length;

  return (
    <ToolCardShell
      toolId={toolId}
      icon="☑"
      badgeColor="#8b5cf6"
      badgeLabel="Todo"
      defaultOpen={true}
      resultSummary="Updated"
      headerContent={
        <span className="crispy-tool-description">({itemCount} items)</span>
      }
    >
      {todos.length > 0 && (
        <ul className="crispy-todo-list">
          {todos.map((todo, i) => {
            const status = todo.status || 'pending';
            const icon =
              status === 'completed' ? '☑' : status === 'in_progress' ? '▶' : '☐';
            const cls =
              status === 'completed'
                ? 'crispy-todo--completed'
                : status === 'in_progress'
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
    </ToolCardShell>
  );
}
