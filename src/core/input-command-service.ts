/**
 * Input Command Service — skill and slash command discovery
 *
 * Scans bundled Crispy skills from disk AND merges vendor-reported
 * commands/skills registered by adapters at session init time.
 * Returns InputCommand[] for the webview autocomplete dropdown.
 *
 * @module core/input-command-service
 */

import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
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

// ============================================================================
// Vendor command registry — adapters push here after init
// ============================================================================

const vendorCommands = new Map<string, SkillEntry[]>();

/**
 * Register vendor-reported commands for a session.
 * Called by adapters after init (Claude) or skill discovery (Codex).
 * Overwrites any previous registration for the same session (safe for resume).
 */
export function registerVendorCommands(sessionId: string, commands: SkillEntry[]): void {
  vendorCommands.set(sessionId, commands);
  log({
    source: 'input-command-service',
    level: 'info',
    summary: `registered ${commands.length} vendor command(s) for session ${sessionId.slice(0, 8)}`,
  });
}

/** Clear vendor commands for a session (called on channel teardown). */
export function clearVendorCommands(sessionId: string): void {
  vendorCommands.delete(sessionId);
}

// ============================================================================
// Bundled skill scanning
// ============================================================================

/** Set the root directory for bundled skills (called from host at startup). */
export function setSkillRoot(path: string): void {
  skillRoot = path;
  cachedSkills = undefined;
  log({ source: 'input-command-service', level: 'info', summary: `skill root set: ${path}` });
}

/**
 * Synchronously scan a skill directory for SKILL.md frontmatter.
 * Each subdirectory containing a SKILL.md is treated as one skill entry.
 */
function scanSkillDir(root: string, source: SkillEntry['source']): SkillEntry[] {
  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    return [];
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

    results.push({ id: dir, displayName: dir, description, source });
  }

  return results;
}

/**
 * Synchronously scan bundled skill directories for SKILL.md frontmatter.
 * Results are cached — bundled skills don't change at runtime.
 */
function scanBundledSkills(root: string): SkillEntry[] {
  if (cachedSkills) return cachedSkills;
  cachedSkills = scanSkillDir(root, 'bundled');
  if (cachedSkills.length === 0) {
    log({ source: 'input-command-service', level: 'warn', summary: `no bundled skills found in: ${root}` });
  }
  return cachedSkills;
}

/**
 * Scan project-level and user-level skill directories.
 * Claude: .claude/skills/   Codex: .agents/skills/
 *
 * Live sessions also register vendor commands via adapter RPCs, but this
 * disk scan provides immediate availability on the splash screen before
 * any session exists.
 *
 * Not cached — CWD can change between sessions.
 */
function scanProjectSkills(cwd: string, vendor?: string): SkillEntry[] {
  const skillDirs = vendor === 'codex'
    ? [join(cwd, '.agents', 'skills'), join(homedir(), '.agents', 'skills')]
    : [join(cwd, '.claude', 'skills'), join(homedir(), '.claude', 'skills')];
  const seen = new Set<string>();
  const results: SkillEntry[] = [];
  for (const dir of skillDirs) {
    for (const entry of scanSkillDir(dir, 'vendor')) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        results.push(entry);
      }
    }
  }
  return results;
}

// ============================================================================
// Public API
// ============================================================================

/** Normalize a skill ID for dedup comparison (strip `crispy:` prefix). */
function normalizeId(id: string): string {
  return id.startsWith('crispy:') ? id.slice(7) : id;
}

/** Return all available commands for the given vendor and session. */
export async function listAvailableCommands(vendor?: string, sessionId?: string, cwd?: string): Promise<InputCommand[]> {
  const trigger: '/' | '$' = vendor === 'codex' ? '$' : '/';

  // 1. Bundled Crispy skills
  const bundled = skillRoot ? scanBundledSkills(skillRoot) : [];
  const seenIds = new Set(bundled.map(s => normalizeId(s.id)));

  // 2. Project-level skills (from CWD and ~/)
  const projectSkills = cwd ? scanProjectSkills(cwd, vendor) : [];

  // 3. Vendor-reported commands (if session is known)
  const vendorEntries = sessionId ? (vendorCommands.get(sessionId) ?? []) : [];

  // 4. Merge: bundled first, then project skills, then vendor (skip duplicates)
  const merged: SkillEntry[] = [...bundled];

  for (const source of [projectSkills, vendorEntries]) {
    for (const v of source) {
      const nid = normalizeId(v.id);
      if (seenIds.has(nid)) {
        // Duplicate — but if this source has a richer description, merge it
        const existing = merged.find(b => normalizeId(b.id) === nid);
        if (existing && (!existing.description || existing.description === existing.id) && v.description) {
          existing.description = v.description;
        }
        continue;
      }
      seenIds.add(nid);
      merged.push(v);
    }
  }

  return merged.map(s => ({
    ...s,
    trigger,
    insertText: `${trigger}${s.id} `,
  }));
}
