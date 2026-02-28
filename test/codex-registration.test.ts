/**
 * Tests for Codex adapter registration descriptor.
 *
 * Mocks CodexAgentAdapter constructor, findCodexBinary, and codexDiscovery
 * to verify available() behavior and factory construction.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostAdapterConfig } from '../src/host/adapter-registry.js';

// ============================================================================
// Module-level mocks
// ============================================================================

const MockCodexAgentAdapter = vi.fn();
const mockSetCommand = vi.fn();

function makeCodexAdapterMock() {
  return {
    CodexAgentAdapter: class {
      constructor(...args: unknown[]) {
        MockCodexAgentAdapter(...args);
      }
      vendor = 'codex';
    },
  };
}

function makeCodexDiscoveryMock() {
  return {
    codexDiscovery: {
      vendor: 'codex' as const,
      findSession: vi.fn(),
      listSessions: vi.fn().mockReturnValue([]),
      loadHistory: vi.fn().mockResolvedValue([]),
      setCommand: (...args: unknown[]) => mockSetCommand(...args),
    },
  };
}

vi.mock('../src/core/adapters/codex/codex-app-server-adapter.js', () => makeCodexAdapterMock());
vi.mock('../src/core/adapters/codex/codex-discovery.js', () => makeCodexDiscoveryMock());

const mockFindCodexBinary = vi.fn();
vi.mock('../src/core/find-codex-binary.js', () => ({
  findCodexBinary: (...args: unknown[]) => mockFindCodexBinary(...args),
}));

// ============================================================================
// Tests
// ============================================================================

describe('codexRegistration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function freshImport() {
    vi.resetModules();
    // Re-apply mocks after resetModules
    vi.doMock('../src/core/adapters/codex/codex-app-server-adapter.js', () => makeCodexAdapterMock());
    vi.doMock('../src/core/adapters/codex/codex-discovery.js', () => makeCodexDiscoveryMock());
    vi.doMock('../src/core/find-codex-binary.js', () => ({
      findCodexBinary: (...args: unknown[]) => mockFindCodexBinary(...args),
    }));
    return import('../src/core/adapters/codex/codex-registration.js');
  }

  // --------------------------------------------------------------------------
  // available()
  // --------------------------------------------------------------------------

  describe('available()', () => {
    it('returns false when findCodexBinary() returns undefined', async () => {
      mockFindCodexBinary.mockReturnValue(undefined);
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test' };

      expect(codexRegistration.available(config)).toBe(false);
    });

    it('returns true when findCodexBinary() returns a path', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test' };

      expect(codexRegistration.available(config)).toBe(true);
    });

    it('calls codexDiscovery.setCommand() when binary found', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test' };

      codexRegistration.available(config);

      expect(mockSetCommand).toHaveBeenCalledWith('/usr/local/bin/codex');
    });

    it('does NOT call setCommand() when binary not found', async () => {
      mockFindCodexBinary.mockReturnValue(undefined);
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test' };

      codexRegistration.available(config);

      expect(mockSetCommand).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // createFactory()
  // --------------------------------------------------------------------------

  describe('createFactory()', () => {
    it('always passes args: ["app-server"] (no MCP flags)', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace' };

      codexRegistration.available(config); // set cachedBinaryPath
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'fresh', cwd: '/project' });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ args: ['app-server'] }),
      );
    });

    it('passes command: cachedBinaryPath', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace' };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'fresh', cwd: '/project' });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ command: '/usr/local/bin/codex' }),
      );
    });

    it('uses spec.cwd for modes that have it', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace' };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'fresh', cwd: '/project' });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/project' }),
      );
    });

    it('uses config.cwd for modes without spec.cwd', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace' };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'resume', sessionId: 'sess-123' });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/workspace' }),
      );
    });

    it('spreads spec properties into adapter construction', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace' };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'fresh', cwd: '/project', model: 'gpt-4.1' });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'fresh',
          model: 'gpt-4.1',
          cwd: '/project',
          command: '/usr/local/bin/codex',
          args: ['app-server'],
        }),
      );
    });
  });
});
