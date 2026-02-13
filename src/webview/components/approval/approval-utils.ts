/**
 * Approval Utilities — shared helpers for approval renderers
 *
 * yamlDump formats tool inputs as YAML-like display text.
 * Ported from Leto's webview-next/permissions/utils.ts.
 *
 * @module approval/approval-utils
 */

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
