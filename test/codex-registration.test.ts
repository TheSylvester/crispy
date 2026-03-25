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
      const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' };

      expect(codexRegistration.available(config)).toBe(false);
    });

    it('returns true when findCodexBinary() returns a path', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' };

      expect(codexRegistration.available(config)).toBe(true);
    });

    it('calls codexDiscovery.setCommand() when binary found', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' };

      codexRegistration.available(config);

      expect(mockSetCommand).toHaveBeenCalledWith('/usr/local/bin/codex');
    });

    it('does NOT call setCommand() when binary not found', async () => {
      mockFindCodexBinary.mockReturnValue(undefined);
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' };

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
      const config: HostAdapterConfig = { cwd: '/workspace', hostType: 'dev-server' };

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
      const config: HostAdapterConfig = { cwd: '/workspace', hostType: 'dev-server' };

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
      const config: HostAdapterConfig = { cwd: '/workspace', hostType: 'dev-server' };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'fresh', cwd: '/project' });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/project' }),
      );
    });

    it('does not inject host cwd into resume sessions without explicit cwd', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace', hostType: 'dev-server' };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'resume', sessionId: 'sess-123' });

      const callArg = MockCodexAgentAdapter.mock.calls[0][0];
      expect(callArg.cwd).toBeUndefined();
    });

    it('uses config.cwd for fresh sessions without spec.cwd', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace', hostType: 'dev-server' };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'fresh', cwd: '/workspace' });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: '/workspace' }),
      );
    });

    it('spreads spec properties into adapter construction', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace', hostType: 'dev-server' };

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

    it('applies host-level prompt to fresh sessions', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const systemPromptFactory = vi.fn().mockReturnValue('Host skills prompt');
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        hostType: 'dev-server',
        systemPromptFactory,
      };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'fresh', cwd: '/project' });

      expect(systemPromptFactory).toHaveBeenCalled();
      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'fresh',
          cwd: '/project',
          systemPrompt: 'Host skills prompt',
        }),
      );
    });

    it('lets explicit session overrides win over host defaults', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        hostType: 'dev-server',
        systemPromptFactory: vi.fn().mockReturnValue('Host prompt'),
      };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({
        mode: 'fork',
        fromSessionId: 'parent-session',
        systemPrompt: 'Spec prompt',
        mcpServers: {
          search: { type: 'stdio', command: 'spec-search' },
        },
      });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'fork',
          systemPrompt: 'Spec prompt',
          mcpServers: {
            search: { type: 'stdio', command: 'spec-search' },
          },
        }),
      );
    });

    it('applies host defaults to resume sessions', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        hostType: 'dev-server',
        systemPromptFactory: vi.fn().mockReturnValue('Host skills prompt'),
      };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'resume', sessionId: 'sess-123' });

      const callArg = MockCodexAgentAdapter.mock.calls[0][0];
      expect(callArg).toMatchObject({
        mode: 'resume',
        sessionId: 'sess-123',
        systemPrompt: 'Host skills prompt',
        effectiveCwd: '/workspace',
      });
      // Resume without explicit cwd should NOT inject host cwd
      expect(callArg.cwd).toBeUndefined();
    });

    it('passes bundledSkillRoot through to the adapter', async () => {
      mockFindCodexBinary.mockReturnValue('/usr/local/bin/codex');
      const { codexRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        hostType: 'dev-server',
        bundledSkillRoot: '/bundle/skills',
      };

      codexRegistration.available(config);
      const factory = codexRegistration.createFactory(config);
      factory({ mode: 'fresh', cwd: '/project' });

      expect(MockCodexAgentAdapter).toHaveBeenCalledWith(
        expect.objectContaining({
          bundledSkillRoot: '/bundle/skills',
          effectiveCwd: '/project',
        }),
      );
    });
  });
});
