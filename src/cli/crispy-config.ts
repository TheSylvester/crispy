/**
 * Crispy Config — Interactive settings wizard
 *
 * Standalone CLI wizard for configuring ~/.crispy/settings.json.
 * No daemon required — does direct file I/O using the same path helpers.
 *
 * @module crispy-config
 */

import { createInterface } from 'node:readline/promises';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { settingsPath, crispyRoot } from '../core/paths.js';
import { DEFAULT_SETTINGS } from '../core/settings/types.js';
import type { CrispySettingsFile, CrispySettings, ProviderConfig } from '../core/settings/types.js';

const SLUG_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
const NATIVE_VENDORS = new Set(['claude', 'codex', 'opencode', 'gemini']);

const PERMISSION_MODES = [
  { value: 'default', label: 'Ask for everything' },
  { value: 'acceptEdits', label: 'Auto-approve file edits' },
  { value: 'plan', label: 'Plan mode (approve before execution)' },
  { value: 'bypassPermissions', label: 'Bypass all permissions' },
] as const;

// ============================================================================
// File I/O (standalone, mirrors settings-store pattern)
// ============================================================================

async function loadSettings(): Promise<CrispySettingsFile> {
  try {
    const raw = await readFile(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as CrispySettingsFile;
    if (parsed.version !== 1) {
      return { version: 1, revision: 0, updatedAt: new Date().toISOString(), ...DEFAULT_SETTINGS };
    }
    const merged: CrispySettingsFile = {
      ...DEFAULT_SETTINGS,
      ...parsed,
      version: 1,
      revision: parsed.revision ?? 0,
      updatedAt: parsed.updatedAt ?? new Date().toISOString(),
    };
    return merged;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: 1, revision: 0, updatedAt: new Date().toISOString(), ...DEFAULT_SETTINGS };
    }
    if (err instanceof SyntaxError) {
      return { version: 1, revision: 0, updatedAt: new Date().toISOString(), ...DEFAULT_SETTINGS };
    }
    throw err;
  }
}

async function saveSettings(settings: CrispySettingsFile): Promise<void> {
  await mkdir(crispyRoot(), { recursive: true });
  const content = JSON.stringify(settings, null, 2) + '\n';
  await writeFile(settingsPath(), content, { mode: 0o600 });
}

// ============================================================================
// Input helpers
// ============================================================================

let rl: ReturnType<typeof createInterface>;
let aborted = false;

function ask(prompt: string, defaultValue?: string | null): Promise<string> {
  const suffix = defaultValue ? ` [${defaultValue}]` : '';
  return rl.question(`${prompt}${suffix}: `).then(answer => {
    const trimmed = answer.trim();
    return trimmed || (defaultValue ?? '');
  });
}

async function choose(prompt: string, options: readonly { value: string; label: string }[], defaultValue?: string): Promise<string> {
  console.log(`\n${prompt}:`);
  const defaultIdx = defaultValue ? options.findIndex(o => o.value === defaultValue) : -1;
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${i + 1}) ${options[i].label}`);
  }
  const defaultDisplay = defaultIdx >= 0 ? String(defaultIdx + 1) : '';
  const answer = await ask('Choose', defaultDisplay);
  const num = parseInt(answer, 10);
  if (num >= 1 && num <= options.length) return options[num - 1].value;
  if (defaultIdx >= 0) return options[defaultIdx].value;
  return options[0].value;
}

async function confirm(prompt: string, defaultValue = true): Promise<boolean> {
  const hint = defaultValue ? 'Y/n' : 'y/N';
  const answer = await ask(`${prompt} [${hint}]`);
  if (!answer) return defaultValue;
  return answer.toLowerCase().startsWith('y');
}

function readPassword(prompt: string, existingMasked?: string): Promise<string> {
  return new Promise((resolve) => {
    const suffix = existingMasked ? ` [${existingMasked}]` : '';
    process.stdout.write(`${prompt}${suffix}: `);

    const { stdin } = process;
    if (!stdin.isTTY) {
      // Non-interactive fallback
      rl.question('').then(answer => resolve(answer.trim()));
      return;
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf-8');

    let password = '';
    const onData = (ch: string) => {
      const c = ch.toString();
      if (c === '\n' || c === '\r' || c === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password || '');
      } else if (c === '\u0003') {
        // Ctrl+C
        stdin.setRawMode(false);
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        aborted = true;
        resolve('');
      } else if (c === '\u007f' || c === '\b') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else if (c.charCodeAt(0) >= 32) {
        password += c;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return token.slice(0, 4) + '…' + token.slice(-4);
}

function slugify(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ============================================================================
// Wizard sections
// ============================================================================

async function configureModel(settings: CrispySettings): Promise<void> {
  console.log('\n── Default Model ──');
  const current = settings.turnDefaults.model;
  const answer = await ask('Default model (sonnet, opus, haiku, or blank for vendor default)', current);
  settings.turnDefaults.model = answer || null;
}

async function configurePermissionMode(settings: CrispySettings): Promise<void> {
  console.log('\n── Default Permission Mode ──');
  const current = settings.turnDefaults.permissionMode ?? 'default';
  const value = await choose('Default permission mode', PERMISSION_MODES, current);
  settings.turnDefaults.permissionMode = value === 'default' ? null : value;
}

async function configureAutoReflect(settings: CrispySettings): Promise<void> {
  console.log('\n── Plan Verification ──');
  const current = settings.preferences.autoReflect;
  settings.preferences.autoReflect = await confirm('Auto-verify implementation plans? (reviews plans before execution)', current);
}

async function configureDiscord(settings: CrispySettings): Promise<void> {
  console.log('\n── Discord Bot ──');
  const bot = settings.discord.bot;
  const wantDiscord = await confirm('Configure Discord bot?', !!bot.token);
  if (!wantDiscord) {
    settings.discord.bot.token = '';
    settings.discord.bot.guildId = '';
    return;
  }

  const tokenResult = await readPassword('Bot token', bot.token ? maskToken(bot.token) : undefined);
  if (aborted) return;
  if (tokenResult) settings.discord.bot.token = tokenResult;

  const guildId = await ask('Guild ID', bot.guildId || undefined);
  if (guildId) settings.discord.bot.guildId = guildId;

  const archival = await ask('Archive timeout (hours)', String(bot.archivalTimeoutHours));
  const parsed = parseInt(archival, 10);
  if (parsed > 0) settings.discord.bot.archivalTimeoutHours = parsed;

  const userIds = await ask('Allowed user IDs (comma-separated, blank = owner only)',
    bot.allowedUserIds.length > 0 ? bot.allowedUserIds.join(', ') : undefined);
  if (userIds) {
    settings.discord.bot.allowedUserIds = userIds.split(',').map(s => s.trim()).filter(Boolean);
  } else {
    settings.discord.bot.allowedUserIds = [];
  }

  const currentPerm = bot.permissionMode ?? settings.turnDefaults.permissionMode ?? 'default';
  const permOverride = await choose('Permission mode for Discord sessions', PERMISSION_MODES, currentPerm);
  settings.discord.bot.permissionMode = permOverride === (settings.turnDefaults.permissionMode ?? 'default')
    ? null : (permOverride as typeof bot.permissionMode);
}

async function configureProviders(settings: CrispySettings): Promise<void> {
  console.log('\n── Custom API Providers ──');

  const existingSlugs = Object.keys(settings.providers);
  if (existingSlugs.length > 0) {
    console.log(`  Existing: ${existingSlugs.join(', ')}`);
  }

  let addMore = await confirm('Add a custom API provider?', false);
  while (addMore) {
    if (aborted) return;
    const label = await ask('Provider label');
    if (!label) break;

    let slug = slugify(label);
    const suggestedSlug = await ask('Slug', slug);
    slug = suggestedSlug || slug;

    if (!SLUG_RE.test(slug)) {
      console.log(`  Invalid slug "${slug}". Must be lowercase alphanumeric with hyphens.`);
      continue;
    }
    if (NATIVE_VENDORS.has(slug)) {
      console.log(`  Cannot override native vendor "${slug}".`);
      continue;
    }

    const baseUrl = await ask('Base URL');
    const apiKey = await readPassword('API key');
    if (aborted) return;
    const defaultModel = await ask('Default model');

    const provider: ProviderConfig = {
      label,
      baseUrl,
      apiKey,
      models: { default: defaultModel },
      enabled: true,
    };

    settings.providers[slug] = provider;
    console.log(`  Added provider: ${label} (${slug})`);

    addMore = await confirm('\nAdd another provider?', false);
  }
}

// ============================================================================
// Main
// ============================================================================

export async function runConfig(): Promise<void> {
  console.log('\nWelcome to Crispy.\n');

  let fileSettings: CrispySettingsFile;
  try {
    fileSettings = await loadSettings();
  } catch (err) {
    console.error('Failed to load settings:', err);
    process.exit(1);
  }

  // Work on a deep copy of the settings portion
  const settings: CrispySettings = JSON.parse(JSON.stringify({
    preferences: fileSettings.preferences,
    providers: fileSettings.providers,
    hooks: fileSettings.hooks,
    envPresets: fileSettings.envPresets,
    cliProfiles: fileSettings.cliProfiles,
    turnDefaults: fileSettings.turnDefaults,
    rosie: fileSettings.rosie,
    discord: fileSettings.discord,
    mcp: fileSettings.mcp,
  }));

  rl = createInterface({ input: process.stdin, output: process.stdout });

  // Handle Ctrl+C
  // Ctrl+C on a TTY fires SIGINT then 'close'. On piped stdin, 'close'
  // fires at EOF after all buffered lines are consumed — that's normal, not an abort.
  process.on('SIGINT', () => {
    aborted = true;
    console.log('\nAborted. No changes saved.');
    rl.close();
    process.exit(0);
  });

  try {
    await configureModel(settings);
    if (aborted) return;

    await configurePermissionMode(settings);
    if (aborted) return;

    await configureAutoReflect(settings);
    if (aborted) return;

    await configureDiscord(settings);
    if (aborted) return;

    await configureProviders(settings);
    if (aborted) return;
  } finally {
    rl.close();
  }

  // Merge and save
  const updated: CrispySettingsFile = {
    version: 1,
    revision: fileSettings.revision + 1,
    updatedAt: new Date().toISOString(),
    ...settings,
  };

  try {
    await saveSettings(updated);
    console.log(`\nConfig saved to ${settingsPath()}`);
    console.log('Run `crispy start` to begin.');
  } catch (err) {
    console.error('Failed to save settings:', err);
    process.exit(1);
  }
}
