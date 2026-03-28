/**
 * Input Command Service — skill and slash command discovery
 *
 * Scans bundled Crispy skills from disk. Returns InputCommand[]
 * for the webview autocomplete dropdown.
 *
 * @module core/input-command-service
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { log } from './log.js';

/** A single autocomplete-able command or skill. */
export interface InputCommand {
  /** Directory slug or vendor-reported name */
  id: string;
  /** What the user sees in the dropdown */
  displayName: string;
  /** Short description for the dropdown subtitle */
  description: string;
  /** The trigger character for this vendor: "/" or "$" */
  trigger: '/' | '$';
  /** What gets inserted on selection */
  insertText: string;
  /** Where this command comes from */
  source: 'bundled' | 'vendor';
}

type SkillEntry = Omit<InputCommand, 'trigger' | 'insertText'>;

let skillRoot: string | undefined;
let cachedSkills: SkillEntry[] | undefined;

/** Set the root directory for bundled skills (called from host at startup). */
export function setSkillRoot(path: string): void {
  skillRoot = path;
  cachedSkills = undefined;
  log({ source: 'input-command-service', level: 'info', summary: `skill root set: ${path}` });
}

/**
 * Synchronously scan bundled skill directories for SKILL.md frontmatter.
 * Results are cached — bundled skills don't change at runtime.
 */
function scanBundledSkills(root: string): SkillEntry[] {
  if (cachedSkills) return cachedSkills;

  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    log({ source: 'input-command-service', level: 'warn', summary: `failed to read skill root: ${root}` });
    cachedSkills = [];
    return cachedSkills;
  }

  const results: SkillEntry[] = [];

  for (const dir of entries) {
    let description = dir;
    try {
      const content = readFileSync(join(root, dir, 'SKILL.md'), 'utf-8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
        if (descMatch) {
          description = descMatch[1].trim().replace(/^(['"])(.*)\1$/, '$2');
        }
      }
    } catch {
      continue;
    }

    results.push({
      id: dir,
      displayName: dir,
      description,
      source: 'bundled',
    });
  }

  cachedSkills = results;
  return results;
}

/** Return all available commands for the given vendor. */
export async function listAvailableCommands(vendor?: string): Promise<InputCommand[]> {
  if (!skillRoot) return [];

  const trigger: '/' | '$' = vendor === 'codex' ? '$' : '/';
  const skills = scanBundledSkills(skillRoot);

  return skills.map(s => ({
    ...s,
    trigger,
    insertText: `${trigger}${s.id} `,
  }));
}
