/**
 * Tests for Settings Store
 *
 * Tests the unified settings system:
 * - File initialization and defaults
 * - Read/write with chmod 600
 * - Optimistic concurrency (revision counter)
 * - Provider migration from providers.json
 * - Settings patching and section merging
 * - API key masking for wire transport
 * - Change notification
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { join } from 'node:path';

import {
  initSettings,
  getSettingsSnapshot,
  getSettingsSnapshotInternal,
  updateSettings,
  deleteProvider,
  onSettingsChanged,
  _setTestConfigDir,
  DEFAULT_SETTINGS,
} from '../src/core/settings/index.js';
import type {
  CrispySettingsFile,
  SettingsPatch,
  ProviderConfig,
} from '../src/core/settings/types.js';

// ============================================================================
// Test Setup
// ============================================================================

let testDir: string;
let cleanup: () => void;

beforeEach(() => {
  // Create isolated temp directory for each test
  testDir = fs.mkdtempSync(join(os.tmpdir(), 'crispy-settings-test-'));
  cleanup = _setTestConfigDir(testDir);
});

afterEach(() => {
  cleanup();
  // Clean up temp directory
  fs.rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

// ============================================================================
// Helper Functions
// ============================================================================

function writeSettingsFile(settings: CrispySettingsFile): void {
  fs.writeFileSync(
    join(testDir, 'settings.json'),
    JSON.stringify(settings, null, 2) + '\n',
  );
}

function readSettingsFile(): CrispySettingsFile {
  const content = fs.readFileSync(join(testDir, 'settings.json'), 'utf-8');
  return JSON.parse(content);
}

function writeProvidersJson(providers: Record<string, ProviderConfig>): void {
  fs.writeFileSync(
    join(testDir, 'providers.json'),
    JSON.stringify({ providers }, null, 2) + '\n',
  );
}

function settingsFileExists(): boolean {
  return fs.existsSync(join(testDir, 'settings.json'));
}

function providersMigratedExists(): boolean {
  return fs.existsSync(join(testDir, 'providers.json.migrated'));
}

const testBase = { cwd: '/test/cwd' };

// ============================================================================
// initSettings
// ============================================================================

describe('initSettings', () => {
  it('creates settings file with defaults when none exists', async () => {
    expect(settingsFileExists()).toBe(false);

    await initSettings(testBase);

    const snapshot = getSettingsSnapshot();
    expect(snapshot.settings.preferences.toolPanelAutoOpen).toBe(false);
    expect(snapshot.settings.providers).toEqual({});
    expect(snapshot.revision).toBe(0);
  });

  it('loads existing settings file', async () => {
    const existingSettings: CrispySettingsFile = {
      version: 1,
      revision: 5,
      updatedAt: '2025-01-01T00:00:00.000Z',
      ...DEFAULT_SETTINGS,
      preferences: {
        ...DEFAULT_SETTINGS.preferences,
        toolPanelAutoOpen: false,
      },
    };
    writeSettingsFile(existingSettings);

    await initSettings(testBase);

    const snapshot = getSettingsSnapshot();
    expect(snapshot.settings.preferences.toolPanelAutoOpen).toBe(false);
    expect(snapshot.revision).toBe(5);
  });

  it('migrates from providers.json when settings.json does not exist', async () => {
    const testProvider: ProviderConfig = {
      label: 'Test Provider',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-test-key-123456789',
      models: { default: 'test-model' },
      enabled: true,
    };
    writeProvidersJson({ 'test-provider': testProvider });

    await initSettings(testBase);

    const snapshot = getSettingsSnapshot();
    expect(snapshot.settings.providers['test-provider']).toBeDefined();
    expect(snapshot.settings.providers['test-provider'].label).toBe('Test Provider');
    // API key should be masked in wire snapshot
    expect(snapshot.settings.providers['test-provider'].apiKey).toBe('sk-...6789');

    // providers.json should be renamed
    expect(providersMigratedExists()).toBe(true);
    expect(fs.existsSync(join(testDir, 'providers.json'))).toBe(false);
  });

  it('handles corrupt settings file by renaming it', async () => {
    fs.writeFileSync(join(testDir, 'settings.json'), '{ invalid json');

    await initSettings(testBase);

    // Should have renamed corrupt file - this is the key behavior
    const files = fs.readdirSync(testDir);
    expect(files.some(f => f.startsWith('settings.json.corrupt.'))).toBe(true);

    // Revision should be 0 for fresh start
    const snapshot = getSettingsSnapshot();
    expect(snapshot.revision).toBe(0);
  });
});

// ============================================================================
// getSettingsSnapshot
// ============================================================================

describe('getSettingsSnapshot', () => {
  it('masks API keys in provider configs', async () => {
    const settings: CrispySettingsFile = {
      version: 1,
      revision: 1,
      updatedAt: new Date().toISOString(),
      ...DEFAULT_SETTINGS,
      providers: {
        'my-provider': {
          label: 'My Provider',
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-abc123def456ghi789jkl',
          models: { default: 'model-v1' },
          enabled: true,
        },
      },
    };
    writeSettingsFile(settings);

    await initSettings(testBase);

    const wireSnapshot = getSettingsSnapshot();
    expect(wireSnapshot.settings.providers['my-provider'].apiKey).toBe('sk-...9jkl');
  });

  it('returns full API keys in internal snapshot', async () => {
    const settings: CrispySettingsFile = {
      version: 1,
      revision: 1,
      updatedAt: new Date().toISOString(),
      ...DEFAULT_SETTINGS,
      providers: {
        'my-provider': {
          label: 'My Provider',
          baseUrl: 'https://api.example.com',
          apiKey: 'sk-abc123def456ghi789jkl',
          models: { default: 'model-v1' },
          enabled: true,
        },
      },
    };
    writeSettingsFile(settings);

    await initSettings(testBase);

    const internalSnapshot = getSettingsSnapshotInternal();
    expect(internalSnapshot.settings.providers['my-provider'].apiKey).toBe('sk-abc123def456ghi789jkl');
  });
});

// ============================================================================
// updateSettings
// ============================================================================

describe('updateSettings', () => {
  beforeEach(async () => {
    await initSettings(testBase);
  });

  it('updates preferences section', async () => {
    const initial = getSettingsSnapshot();
    const originalAutoOpen = initial.settings.preferences.toolPanelAutoOpen;

    const patch: SettingsPatch = {
      preferences: { toolPanelAutoOpen: !originalAutoOpen },
    };

    await updateSettings(patch);

    const snapshot = getSettingsSnapshot();
    expect(snapshot.settings.preferences.toolPanelAutoOpen).toBe(!originalAutoOpen);
  });

  it('increments revision on each update', async () => {
    const initialRevision = getSettingsSnapshot().revision;

    await updateSettings({ preferences: { toolPanelAutoOpen: false } });
    expect(getSettingsSnapshot().revision).toBe(initialRevision + 1);

    await updateSettings({ preferences: { toolPanelAutoOpen: true } });
    expect(getSettingsSnapshot().revision).toBe(initialRevision + 2);
  });

  it('persists changes to disk', async () => {
    await updateSettings({ preferences: { toolPanelAutoOpen: false } });

    const fileSettings = readSettingsFile();
    expect(fileSettings.preferences.toolPanelAutoOpen).toBe(false);
  });

  it('rejects stale expectedRevision', async () => {
    // Get current revision
    const currentRevision = getSettingsSnapshot().revision;

    // Update to increment revision
    await updateSettings({ preferences: { toolPanelAutoOpen: false } });

    // Try to update with stale revision
    await expect(
      updateSettings({ preferences: { toolPanelAutoOpen: true } }, { expectedRevision: currentRevision }),
    ).rejects.toThrow('SETTINGS_CONFLICT');
  });

  it('accepts current expectedRevision', async () => {
    await updateSettings({ preferences: { toolPanelAutoOpen: false } });
    const currentRevision = getSettingsSnapshot().revision;

    // Should succeed with correct revision
    await updateSettings(
      { preferences: { toolPanelAutoOpen: true } },
      { expectedRevision: currentRevision },
    );

    expect(getSettingsSnapshot().settings.preferences.toolPanelAutoOpen).toBe(true);
  });

  it('adds new provider', async () => {
    const newProvider: ProviderConfig = {
      label: 'New Provider',
      baseUrl: 'https://api.new.com',
      apiKey: 'sk-new-api-key',
      models: { default: 'new-model' },
      enabled: true,
    };

    await updateSettings({ providers: { 'new-provider': newProvider } });

    const snapshot = getSettingsSnapshotInternal();
    expect(snapshot.settings.providers['new-provider']).toBeDefined();
    expect(snapshot.settings.providers['new-provider'].label).toBe('New Provider');
    expect(snapshot.settings.providers['new-provider'].apiKey).toBe('sk-new-api-key');
  });

  it('preserves existing API key when patch has empty apiKey', async () => {
    // First add a provider with an API key
    const provider: ProviderConfig = {
      label: 'My Provider',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-original-secret-key',
      models: { default: 'model-v1' },
      enabled: true,
    };
    await updateSettings({ providers: { 'my-provider': provider } });

    // Update with empty apiKey - should preserve original
    const updatedProvider: ProviderConfig = {
      label: 'Updated Label',
      baseUrl: 'https://api.example.com',
      apiKey: '', // Empty = preserve existing
      models: { default: 'model-v2' },
      enabled: true,
    };
    await updateSettings({ providers: { 'my-provider': updatedProvider } });

    const snapshot = getSettingsSnapshotInternal();
    expect(snapshot.settings.providers['my-provider'].label).toBe('Updated Label');
    expect(snapshot.settings.providers['my-provider'].apiKey).toBe('sk-original-secret-key');
    expect(snapshot.settings.providers['my-provider'].models.default).toBe('model-v2');
  });

  it('rejects invalid provider slugs', async () => {
    const provider: ProviderConfig = {
      label: 'Bad Slug',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-key',
      models: { default: 'model' },
      enabled: true,
    };

    // Uppercase
    await expect(
      updateSettings({ providers: { 'BadSlug': provider } }),
    ).rejects.toThrow('Invalid provider slug');

    // Leading hyphen
    await expect(
      updateSettings({ providers: { '-bad-slug': provider } }),
    ).rejects.toThrow('Invalid provider slug');
  });

  it('rejects native vendor slugs', async () => {
    const provider: ProviderConfig = {
      label: 'Claude Override',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-key',
      models: { default: 'model' },
      enabled: true,
    };

    await expect(
      updateSettings({ providers: { 'claude': provider } }),
    ).rejects.toThrow('Cannot override native vendor');
  });

  it('notifies change listeners', async () => {
    const current = getSettingsSnapshot().settings.preferences.toolPanelAutoOpen;

    const events: { changedSections: string[]; source: string }[] = [];
    const unsub = onSettingsChanged((evt) => {
      events.push({ changedSections: [...evt.changedSections], source: evt.source });
    });

    await updateSettings({ preferences: { toolPanelAutoOpen: !current } });

    expect(events.length).toBe(1);
    expect(events[0].changedSections).toContain('preferences');
    expect(events[0].source).toBe('rpc');

    unsub();
  });
});

// ============================================================================
// deleteProvider
// ============================================================================

describe('deleteProvider', () => {
  beforeEach(async () => {
    const settings: CrispySettingsFile = {
      version: 1,
      revision: 1,
      updatedAt: new Date().toISOString(),
      ...DEFAULT_SETTINGS,
      providers: {
        'provider-a': {
          label: 'Provider A',
          baseUrl: 'https://a.example.com',
          apiKey: 'sk-a',
          models: { default: 'model-a' },
          enabled: true,
        },
        'provider-b': {
          label: 'Provider B',
          baseUrl: 'https://b.example.com',
          apiKey: 'sk-b',
          models: { default: 'model-b' },
          enabled: true,
        },
      },
    };
    writeSettingsFile(settings);
    await initSettings(testBase);
  });

  it('removes the specified provider', async () => {
    await deleteProvider('provider-a');

    const snapshot = getSettingsSnapshot();
    expect(snapshot.settings.providers['provider-a']).toBeUndefined();
    expect(snapshot.settings.providers['provider-b']).toBeDefined();
  });

  it('increments revision', async () => {
    const initialRevision = getSettingsSnapshot().revision;

    await deleteProvider('provider-a');

    expect(getSettingsSnapshot().revision).toBe(initialRevision + 1);
  });

  it('is idempotent for non-existent provider', async () => {
    const initialRevision = getSettingsSnapshot().revision;

    await deleteProvider('non-existent');

    // Revision should not change when provider doesn't exist
    expect(getSettingsSnapshot().revision).toBe(initialRevision);
  });

  it('notifies change listeners', async () => {
    const events: string[][] = [];
    const unsub = onSettingsChanged((evt) => {
      events.push([...evt.changedSections]);
    });

    await deleteProvider('provider-a');

    expect(events.length).toBe(1);
    expect(events[0]).toContain('providers');

    unsub();
  });
});

// ============================================================================
// onSettingsChanged
// ============================================================================

describe('onSettingsChanged', () => {
  beforeEach(async () => {
    await initSettings(testBase);
  });

  it('returns unsubscribe function', async () => {
    let callCount = 0;
    const unsub = onSettingsChanged(() => { callCount++; });

    await updateSettings({ preferences: { toolPanelAutoOpen: false } });
    expect(callCount).toBe(1);

    unsub();

    await updateSettings({ preferences: { toolPanelAutoOpen: true } });
    expect(callCount).toBe(1); // Should not have been called again
  });

  it('reports only changed sections', async () => {
    const current = getSettingsSnapshot().settings.preferences.toolPanelAutoOpen;

    const events: string[][] = [];
    const unsub = onSettingsChanged((evt) => {
      events.push([...evt.changedSections]);
    });

    // Change only preferences - toggle toolPanelAutoOpen
    await updateSettings({ preferences: { toolPanelAutoOpen: !current } });
    expect(events[0]).toEqual(['preferences']);

    // Change preferences again (toggle back)
    await updateSettings({ preferences: { toolPanelAutoOpen: current } });
    expect(events[1]).toEqual(['preferences']);

    unsub();
  });
});

// ============================================================================
// File permissions
// ============================================================================

describe.skipIf(process.platform === 'win32')('file permissions', () => {
  it('creates settings file with mode 0600', async () => {
    await initSettings(testBase);
    await updateSettings({ preferences: { toolPanelAutoOpen: false } });

    const stats = fs.statSync(join(testDir, 'settings.json'));
    // On Unix-like systems, mode & 0o777 gives the permission bits
    // 0o600 = 384 in decimal
    expect(stats.mode & 0o777).toBe(0o600);
  });
});
