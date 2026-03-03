/**
 * Settings Migration — providers.json → settings.json migration
 *
 * On first boot when no settings.json exists, reads the legacy
 * providers.json and renames it to providers.json.migrated.
 *
 * @module settings/migration
 */

import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import type { ProviderConfig } from './types.js';

/** Legacy providers file structure. */
interface ProvidersFile {
  providers: Record<string, ProviderConfig>;
}

/**
 * Migrate from legacy providers.json to settings.json.
 *
 * 1. Read `{configDir}/providers.json` if it exists.
 * 2. Parse → extract `providers` record.
 * 3. Rename file to `providers.json.migrated`.
 * 4. Return the providers record (empty `{}` if file didn't exist).
 */
export async function migrateFromProvidersJson(
  configDir: string,
): Promise<Record<string, ProviderConfig>> {
  const providersPath = join(configDir, 'providers.json');

  try {
    const raw = await readFile(providersPath, 'utf-8');
    const parsed = JSON.parse(raw) as ProvidersFile;

    // Validate structure
    if (!parsed || typeof parsed !== 'object' || !parsed.providers) {
      return {};
    }

    // Rename to .migrated (safety net — not deleted)
    const migratedPath = join(configDir, 'providers.json.migrated');
    try {
      await rename(providersPath, migratedPath);
    } catch {
      // rename is best-effort — file might already be migrated by concurrent instance
    }

    return parsed.providers;
  } catch (err: unknown) {
    // ENOENT = file doesn't exist, which is fine
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    // Log other errors but don't crash — return empty providers
    console.error('[settings/migration] Failed to migrate providers.json:', err);
    return {};
  }
}
