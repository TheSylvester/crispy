/**
 * Chrome MCP Tool Views — custom renderers for all mcp__claude-in-chrome__* tools
 *
 * - Compact: Chrome icon + colored badge + action emoji + subject + status
 * - Expanded: same header + inline screenshots + text result
 *
 * Internal dispatch on tool name suffix and input.action for the computer tool.
 *
 * @module webview/blocks/views/chrome-views
 */

import type { ReactNode } from 'react';
import type { ToolViewProps } from '../types.js';
import { ToolBadge } from '../../renderers/tools/shared/ToolBadge.js';
import { StatusIndicator } from '../../renderers/tools/shared/StatusIndicator.js';
import { extractResultText, extractImageBlocks, formatCount } from '../../renderers/tools/shared/tool-utils.js';
import { ChromeMonoIcon } from '../../components/control-panel/icons.js';
import { ToolCard } from './ToolCard.js';

const CHROME_COLOR = 'linear-gradient(135deg, #EA4335, #FBBC04, #34A853)';
const PREFIX = 'mcp__claude-in-chrome__';

// ============================================================================
// Helpers
// ============================================================================

function parseChromeToolName(fullName: string): string {
  return fullName.startsWith(PREFIX) ? fullName.slice(PREFIX.length) : fullName;
}

function truncate(str: string, maxLen: number): string {
  return str.length > maxLen ? str.slice(0, maxLen) + '…' : str;
}

function getChromeActionEmoji(suffix: string, input: Record<string, unknown>): string {
  if (suffix === 'computer') {
    switch (input.action) {
      case 'screenshot': return '📸';
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click':
      case 'left_click_drag': return '🖱️';
      case 'scroll':
      case 'scroll_to': return '↕️';
      case 'type':
      case 'key': return '⌨️';
      case 'wait': return '⏱️';
      case 'zoom': return '🔍';
      case 'hover': return '👆';
      default: return '🖱️';
    }
  }

  switch (suffix) {
    case 'navigate': return '🔗';
    case 'find': return '🔎';
    case 'read_page': return '📋';
    case 'javascript_tool': return '⚡';
    case 'tabs_context_mcp': return '🗂️';
    case 'tabs_create_mcp': return '➕';
    case 'form_input': return '📝';
    case 'resize_window': return '↔️';
    case 'read_console_messages': return '🖥️';
    case 'read_network_requests': return '🌐';
    case 'gif_creator': return '🎬';
    case 'get_page_text': return '📄';
    case 'upload_image': return '📤';
    case 'update_plan': return '📊';
    case 'shortcuts_list':
    case 'shortcuts_execute': return '⚡';
    default: return '🔌';
  }
}

function getChromeBadgeLabel(suffix: string, input: Record<string, unknown>): string {
  if (suffix === 'computer') {
    switch (input.action) {
      case 'screenshot': return 'screenshot';
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click': return 'click';
      case 'left_click_drag': return 'drag';
      case 'scroll':
      case 'scroll_to': return 'scroll';
      case 'type': return 'type';
      case 'key': return 'key';
      case 'wait': return 'wait';
      case 'zoom': return 'zoom';
      case 'hover': return 'hover';
      default: return String(input.action ?? 'computer');
    }
  }

  switch (suffix) {
    case 'navigate': return 'navigate';
    case 'find': return 'find';
    case 'read_page': return 'read page';
    case 'javascript_tool': return 'JS eval';
    case 'tabs_context_mcp': return 'tabs';
    case 'tabs_create_mcp': return 'new tab';
    case 'form_input': return 'form input';
    case 'resize_window': return 'resize';
    case 'read_console_messages': return 'console';
    case 'read_network_requests': return 'network';
    case 'gif_creator': return 'GIF';
    case 'get_page_text': return 'page text';
    case 'upload_image': return 'upload';
    case 'update_plan': return 'plan';
    case 'shortcuts_list': return 'shortcuts';
    case 'shortcuts_execute': return 'shortcut';
    default: return suffix;
  }
}

function getChromeSubject(suffix: string, input: Record<string, unknown>): string {
  if (suffix === 'computer') {
    const action = input.action as string | undefined;
    switch (action) {
      case 'screenshot': return '';
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click': {
        if (input.ref) return String(input.ref);
        const coord = input.coordinate as number[] | undefined;
        return coord ? `(${coord[0]}, ${coord[1]})` : '';
      }
      case 'left_click_drag': {
        const start = input.start_coordinate as number[] | undefined;
        const end = input.coordinate as number[] | undefined;
        if (start && end) return `(${start[0]},${start[1]}) → (${end[0]},${end[1]})`;
        return '';
      }
      case 'scroll': {
        const dir = input.scroll_direction ?? 'down';
        const amt = input.scroll_amount ?? 3;
        return `${dir} ×${amt}`;
      }
      case 'scroll_to':
        return input.ref ? String(input.ref) : '';
      case 'type':
        return truncate(String(input.text ?? ''), 40);
      case 'key':
        return String(input.text ?? '');
      case 'wait':
        return `${input.duration ?? '?'}s`;
      case 'zoom': {
        const region = input.region as number[] | undefined;
        return region ? `[${region[0]},${region[1]} → ${region[2]},${region[3]}]` : '';
      }
      case 'hover': {
        if (input.ref) return String(input.ref);
        const c = input.coordinate as number[] | undefined;
        return c ? `(${c[0]}, ${c[1]})` : '';
      }
      default: return '';
    }
  }

  switch (suffix) {
    case 'navigate': return truncate(String(input.url ?? ''), 50);
    case 'find': return truncate(String(input.query ?? ''), 50);
    case 'javascript_tool': {
      const text = String(input.text ?? '');
      const firstLine = text.split('\n')[0] ?? '';
      return truncate(firstLine, 50);
    }
    case 'read_page': {
      const parts: string[] = [];
      if (input.filter) parts.push(String(input.filter));
      if (input.ref_id) parts.push(String(input.ref_id));
      return parts.join(' ');
    }
    case 'form_input': {
      const ref = String(input.ref ?? '');
      const val = truncate(String(input.value ?? ''), 30);
      return ref ? `${ref} = ${val}` : val;
    }
    case 'resize_window':
      return `${input.width ?? '?'}×${input.height ?? '?'}`;
    case 'read_console_messages':
      return input.pattern ? String(input.pattern) : '';
    case 'read_network_requests':
      return input.urlPattern ? String(input.urlPattern) : '';
    case 'gif_creator':
      return String(input.action ?? '');
    default: return '';
  }
}

function getChromeResultSummary(
  suffix: string,
  input: Record<string, unknown>,
  resultText: string | null,
  isError: boolean,
): string {
  if (isError) return 'Error';

  if (suffix === 'computer') {
    const action = input.action as string | undefined;
    if (action === 'screenshot' || action === 'zoom') {
      // Try to extract dimensions from result text
      const dimMatch = resultText?.match(/(\d+x\d+)/);
      if (dimMatch) return dimMatch[1];
      return formatCount(resultText, 'line');
    }
  }

  switch (suffix) {
    case 'find': {
      const m = resultText?.match(/Found (\d+)/);
      return m ? `${m[1]} elements` : formatCount(resultText, 'line');
    }
    case 'tabs_context_mcp': {
      // Try to parse tab count from JSON result
      try {
        if (resultText) {
          const parsed = JSON.parse(resultText) as { availableTabs?: unknown[] };
          if (parsed.availableTabs) return `${parsed.availableTabs.length} tabs`;
        }
      } catch {
        // fall through
      }
      return formatCount(resultText, 'line');
    }
    case 'tabs_create_mcp': return 'created';
    case 'navigate': return 'done';
    case 'resize_window': return 'done';
    default: return formatCount(resultText, 'line');
  }
}

// ============================================================================
// Compact View
// ============================================================================

export function ChromeCompactView({ block, result, status }: ToolViewProps): ReactNode {
  const input = block.input as Record<string, unknown>;
  const suffix = parseChromeToolName(block.name);
  const emoji = getChromeActionEmoji(suffix, input);
  const label = getChromeBadgeLabel(suffix, input);
  const subject = getChromeSubject(suffix, input);

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? getChromeResultSummary(suffix, input, resultText, !!result.is_error)
    : undefined;

  return (
    <div className="crispy-blocks-compact-row">
      <span className="crispy-blocks-compact-icon"><ChromeMonoIcon /></span>
      <ToolBadge color={CHROME_COLOR} label="chrome" />
      <span className="crispy-blocks-chrome-action">{label}</span>
      <span className="crispy-blocks-chrome-emoji">{emoji}</span>
      {subject && <span className="crispy-blocks-compact-subject">{subject}</span>}
      <StatusIndicator status={status} summary={resultSummary} />
    </div>
  );
}

// ============================================================================
// Expanded View
// ============================================================================

export function ChromeExpandedView({ block, result, status, anchor }: ToolViewProps): ReactNode {
  const input = block.input as Record<string, unknown>;
  const suffix = parseChromeToolName(block.name);
  const emoji = getChromeActionEmoji(suffix, input);
  const label = getChromeBadgeLabel(suffix, input);
  const subject = getChromeSubject(suffix, input);

  const resultText = extractResultText(result?.content);
  const resultSummary = result
    ? getChromeResultSummary(suffix, input, resultText, !!result.is_error)
    : undefined;

  const images = result ? extractImageBlocks(result.content) : [];

  return (
    <ToolCard anchor={anchor} open={status === 'running'} summary={<>
      <span className="crispy-blocks-tool-header">
        <span className="crispy-blocks-tool-icon"><ChromeMonoIcon /></span>
        <ToolBadge color={CHROME_COLOR} label="chrome" />
        <span className="crispy-blocks-chrome-action">{label}</span>
        <span className="crispy-blocks-chrome-emoji">{emoji}</span>
        {subject && <span className="crispy-blocks-tool-description">{subject}</span>}
      </span>
      <StatusIndicator status={status} summary={resultSummary} />
    </>}>
      {result && (
        <div className="crispy-blocks-tool-body">
          {images.length > 0 && (
            <div className="crispy-blocks-chrome-images">
              {images.map((img, i) => (
                <img
                  key={i}
                  className="crispy-blocks-chrome-screenshot"
                  src={`data:${img.source.media_type ?? 'image/jpeg'};base64,${img.source.data}`}
                  alt={`Screenshot ${i + 1}`}
                />
              ))}
            </div>
          )}
          {resultText && (
            <pre className={`crispy-tool-result__text ${result.is_error ? 'crispy-tool-result__text--error' : ''}`}>
              {resultText}
            </pre>
          )}
        </div>
      )}
    </ToolCard>
  );
}
