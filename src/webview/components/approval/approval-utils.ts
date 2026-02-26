/**
 * Approval Utilities — shared helpers for approval renderers
 *
 * yamlDump formats tool inputs as YAML-like display text.
 * Shared helpers for approval renderers.
 *
 * @module approval/approval-utils
 */

/**
 * Construct a handoff prompt for ExitPlanMode with context clear.
 *
 * When the user approves a plan with "clear context", this prompt is
 * used to start a fresh session that carries the plan forward.
 *
 * @param planContent - The plan text from ExitPlanModeInput
 * @param sessionId - Current session ID for transcript reference
 * @returns Formatted handoff prompt
 */
export function constructExitPlanHandoffPrompt(
  planContent: string | undefined,
  sessionId: string | null,
): string {
  const lines = ['Implement the following plan:'];
  if (planContent) lines.push('', planContent);
  if (sessionId) {
    lines.push('',
      `If you need specific details from before exiting plan mode, ` +
      `refer to the previous session (ID: ${sessionId}).`
    );
  }
  return lines.join('\n');
}

/**
 * Format an object as YAML-like display text.
 * Used to show tool inputs in approval panels.
 *
 * @param obj - Object to format
 * @param indent - Current indentation level
 * @returns Formatted string
 */
export function yamlDump(obj: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);

  if (obj === null || obj === undefined) {
    return `${pad}null`;
  }

  if (typeof obj === 'string') {
    // Multi-line strings
    if (obj.includes('\n')) {
      const lines = obj
        .split('\n')
        .map((line) => `${pad}  ${line}`)
        .join('\n');
      return `${pad}|\n${lines}`;
    }
    // Quote if needed (contains special characters)
    if (obj.includes(':') || obj.includes('#') || obj.startsWith(' ') || obj.startsWith("'")) {
      return `${pad}"${obj.replace(/"/g, '\\"')}"`;
    }
    return `${pad}${obj}`;
  }

  if (typeof obj === 'number' || typeof obj === 'boolean') {
    return `${pad}${obj}`;
  }

  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${pad}[]`;
    return obj
      .map((item) => {
        const value = yamlDump(item, indent + 1).trimStart();
        return `${pad}- ${value}`;
      })
      .join('\n');
  }

  if (typeof obj === 'object') {
    const entries = Object.entries(obj);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([key, value]) => {
        const valueStr = yamlDump(value, indent + 1);
        // Inline simple values
        if (typeof value !== 'object' || value === null) {
          return `${pad}${key}: ${valueStr.trim()}`;
        }
        return `${pad}${key}:\n${valueStr}`;
      })
      .join('\n');
  }

  return `${pad}${String(obj)}`;
}
