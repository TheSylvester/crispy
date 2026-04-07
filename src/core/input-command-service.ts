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
  cachedPluginSkills = undefined;
  log({ source: 'input-command-service', level: 'info', summary: `skill root set: ${path}` });
}

/** Extract description from YAML frontmatter in a markdown string. */
function extractFrontmatterDescription(content: string, fallback: string): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const descMatch = fmMatch[1].match(/^description:\s*(.+)$/m);
    if (descMatch) {
      return descMatch[1].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return fallback;
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
    try {
      const content = readFileSync(join(root, dir, 'SKILL.md'), 'utf-8');
      const description = extractFrontmatterDescription(content, dir);
      results.push({ id: dir, displayName: dir, description, source });
    } catch {
      continue;
    }
  }

  return results;
}

/**
 * Synchronously scan a commands directory for flat .md files.
 * Claude Code loads these from .claude/commands/ (project + global).
 */
function scanCommandDir(root: string, source: SkillEntry['source']): SkillEntry[] {
  let files: string[];
  try {
    files = readdirSync(root).filter(f => f.endsWith('.md'));
  } catch {
    return [];
  }

  const results: SkillEntry[] = [];

  for (const file of files) {
    const cmdName = file.replace(/\.md$/, '');
    let description = cmdName;
    try {
      const content = readFileSync(join(root, file), 'utf-8');
      description = extractFrontmatterDescription(content, cmdName);
    } catch {
      // use fallback description
    }
    results.push({ id: cmdName, displayName: cmdName, description, source });
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
 * Scan project-level and user-level skill AND command directories.
 * Claude: .claude/skills/, .claude/commands/   Codex: .agents/skills/
 *
 * Live sessions also register vendor commands via adapter RPCs, but this
 * disk scan provides immediate availability on the splash screen before
 * any session exists.
 *
 * Not cached — CWD can change between sessions.
 */
function scanProjectSkills(cwd: string, vendor?: string): SkillEntry[] {
  const isCodex = vendor === 'codex';
  const dotDir = isCodex ? '.agents' : '.claude';
  const home = homedir();

  // Skills: subdirectories with SKILL.md
  const skillDirs = [join(cwd, dotDir, 'skills'), join(home, dotDir, 'skills')];

  // Commands: flat .md files (Claude Code convention, not used by Codex)
  const commandDirs = isCodex ? [] : [join(cwd, dotDir, 'commands'), join(home, dotDir, 'commands')];

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

  for (const dir of commandDirs) {
    for (const entry of scanCommandDir(dir, 'vendor')) {
      if (!seen.has(entry.id)) {
        seen.add(entry.id);
        results.push(entry);
      }
    }
  }

  return results;
}

// ============================================================================
// Installed plugin scanning (marketplace plugins)
// ============================================================================

interface InstalledPluginsFile {
  version: number;
  plugins: Record<string, Array<{ scope: string; installPath: string }>>;
}

let cachedPluginSkills: SkillEntry[] | undefined;

/**
 * Scan installed Claude Code plugins for skills and commands.
 *
 * Reads ~/.claude/plugins/installed_plugins.json for install paths,
 * checks ~/.claude/settings.json enabledPlugins for on/off state,
 * then walks each enabled plugin's skills/ and commands/ directories.
 *
 * Results are cached — installed plugins don't change mid-session.
 */
function scanInstalledPlugins(): SkillEntry[] {
  if (cachedPluginSkills) return cachedPluginSkills;

  const home = homedir();
  const registryPath = join(home, '.claude', 'plugins', 'installed_plugins.json');
  const settingsPath = join(home, '.claude', 'settings.json');

  let registry: InstalledPluginsFile;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch {
    cachedPluginSkills = [];
    return cachedPluginSkills;
  }

  // Read enabled/disabled state from settings.json
  let enabledPlugins: Record<string, boolean> = {};
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    enabledPlugins = settings.enabledPlugins ?? {};
  } catch {
    // If settings unreadable, treat all as enabled
  }

  const results: SkillEntry[] = [];

  for (const [pluginId, installs] of Object.entries(registry.plugins ?? {})) {
    // Skip disabled plugins
    if (enabledPlugins[pluginId] === false) continue;

    const install = installs[0];
    if (!install?.installPath) continue;

    // Read plugin name from manifest (fall back to ID prefix)
    let pluginName = pluginId.split('@')[0];
    try {
      const manifest = JSON.parse(
        readFileSync(join(install.installPath, '.claude-plugin', 'plugin.json'), 'utf-8'),
      );
      if (manifest.name) pluginName = manifest.name;
    } catch {
      // use fallback name
    }

    // Scan skills/ subdirectories
    for (const entry of scanSkillDir(join(install.installPath, 'skills'), 'vendor')) {
      results.push({
        ...entry,
        id: `${pluginName}:${entry.id}`,
        displayName: `${pluginName}:${entry.id}`,
      });
    }

    // Scan commands/ (flat .md files, not subdirectories)
    for (const entry of scanCommandDir(join(install.installPath, 'commands'), 'vendor')) {
      results.push({
        ...entry,
        id: `${pluginName}:${entry.id}`,
        displayName: `${pluginName}:${entry.id}`,
      });
    }
  }

  cachedPluginSkills = results;
  log({
    source: 'input-command-service',
    level: 'info',
    summary: `scanned ${results.length} skill(s)/command(s) from installed plugins`,
  });
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

  // 3. Installed marketplace plugins
  const pluginSkills = vendor !== 'codex' ? scanInstalledPlugins() : [];

  // 4. Vendor-reported commands (if session is known)
  const vendorEntries = sessionId ? (vendorCommands.get(sessionId) ?? []) : [];

  // 5. Merge: bundled first, then project, plugins, vendor (skip duplicates)
  const merged: SkillEntry[] = [...bundled];

  for (const source of [projectSkills, pluginSkills, vendorEntries]) {
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
