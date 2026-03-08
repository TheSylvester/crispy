/**
 * Inline View — icon-only tool pill for inline transcript mode
 *
 * Renders a tool as a single emoji icon (22x22 pill) that can be placed
 * inline with preceding text. Error tools show a red dot indicator,
 * running tools show a pulsing yellow dot. Hover shows a tooltip with
 * tool name + subject + error message.
 *
 * @module webview/blocks/views/inline-view
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { getToolData, extractSubject } from '../tool-definitions.js';
import { extractResultText } from '../../renderers/tools/shared/tool-utils.js';

export function DefaultInlineView({ block, result, status }: ToolViewProps): ReactNode {
  const def = getToolData(block.name);
  const subject = extractSubject(block);
  const isError = status === 'error';
  const isRunning = status === 'running';

  const errorText = isError && result ? extractResultText(result.content) : null;
  const title = `${block.name}: ${subject}${errorText ? ' \u2014 ' + errorText.slice(0, 100) : ''}`;

  return (
    <span
      className={`crispy-inline-icon${isError ? ' crispy-inline-icon--error' : ''}${isRunning ? ' crispy-inline-icon--running' : ''}`}
      title={title}
    >
      {def.icon}
    </span>
  );
}
