/**
 * Tests for Claude adapter registration descriptor.
 *
 * Mocks ClaudeAgentAdapter constructor and findClaudeBinary to verify
 * available() behavior and factory construction for each spec mode.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HostAdapterConfig } from '../src/host/adapter-registry.js';

// ============================================================================
// Module-level mocks
// ============================================================================

const MockClaudeAgentAdapter = vi.fn();
const mockGetResumeModel = vi.fn();
const mockClaudeDiscovery = {
  vendor: 'claude' as const,
  findSession: vi.fn(),
  listSessions: vi.fn().mockReturnValue([]),
  loadHistory: vi.fn().mockResolvedValue([]),
};

function makeClaudeMock() {
  return {
    ClaudeAgentAdapter: class {
      constructor(...args: unknown[]) {
        MockClaudeAgentAdapter(...args);
      }
      vendor = 'claude';
    },
    claudeDiscovery: mockClaudeDiscovery,
    getResumeModel: (...args: unknown[]) => mockGetResumeModel(...args),
  };
}

vi.mock('../src/core/adapters/claude/claude-code-adapter.js', () => makeClaudeMock());

const mockFindClaudeBinary = vi.fn();
vi.mock('../src/core/find-claude-binary.js', () => ({
  findClaudeBinary: (...args: unknown[]) => mockFindClaudeBinary(...args),
}));

// ============================================================================
// Tests
// ============================================================================

describe('claudeRegistration', () => {
  // Use resetModules + dynamic import to get fresh module-level cachedBinaryPath
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function freshImport() {
    vi.resetModules();
    // Re-apply mocks after resetModules
    vi.doMock('../src/core/adapters/claude/claude-code-adapter.js', () => makeClaudeMock());
    vi.doMock('../src/core/find-claude-binary.js', () => ({
      findClaudeBinary: (...args: unknown[]) => mockFindClaudeBinary(...args),
    }));
    return import('../src/core/adapters/claude/claude-registration.js');
  }

  // --------------------------------------------------------------------------
  // available()
  // --------------------------------------------------------------------------

  describe('available()', () => {
    it('returns true when config.pathToClaudeCodeExecutable is set', async () => {
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/test',
        pathToClaudeCodeExecutable: '/usr/bin/claude',
      };

      expect(claudeRegistration.available(config)).toBe(true);
      expect(mockFindClaudeBinary).not.toHaveBeenCalled();
    });

    it('returns true when findClaudeBinary() finds a binary', async () => {
      mockFindClaudeBinary.mockReturnValue('/home/user/.local/bin/claude');
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test' };

      expect(claudeRegistration.available(config)).toBe(true);
      expect(mockFindClaudeBinary).toHaveBeenCalled();
    });

    it('returns false when neither config path nor findClaudeBinary provides a binary', async () => {
      mockFindClaudeBinary.mockReturnValue(undefined);
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/test' };

      expect(claudeRegistration.available(config)).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // createFactory()
  // --------------------------------------------------------------------------

  describe('createFactory()', () => {
    it('resume mode passes correct args to ClaudeAgentAdapter', async () => {
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        pathToClaudeCodeExecutable: '/usr/bin/claude',
      };
      mockGetResumeModel.mockReturnValue('claude-sonnet');

      const factory = claudeRegistration.createFactory(config);
      factory({ mode: 'resume', sessionId: 'sess-123' });

      expect(MockClaudeAgentAdapter).toHaveBeenCalledWith({
        pathToClaudeCodeExecutable: '/usr/bin/claude',
        cwd: '/workspace',
        resume: 'sess-123',
        model: 'claude-sonnet',
      });
    });

    it('fresh mode uses spec.cwd, not config.cwd', async () => {
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        pathToClaudeCodeExecutable: '/usr/bin/claude',
      };

      const factory = claudeRegistration.createFactory(config);
      factory({
        mode: 'fresh',
        cwd: '/project',
        model: 'opus',
        permissionMode: 'plan',
        extraArgs: { chrome: null },
      });

      expect(MockClaudeAgentAdapter).toHaveBeenCalledWith({
        pathToClaudeCodeExecutable: '/usr/bin/claude',
        cwd: '/project',
        model: 'opus',
        permissionMode: 'plan',
        extraArgs: { chrome: null },
      });
    });

    it('resume mode forwards spec.permissionMode to adapter', async () => {
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        pathToClaudeCodeExecutable: '/usr/bin/claude',
      };
      mockGetResumeModel.mockReturnValue(undefined);

      const factory = claudeRegistration.createFactory(config);
      factory({ mode: 'resume', sessionId: 'sess-123', permissionMode: 'bypassPermissions' });

      const args = MockClaudeAgentAdapter.mock.calls[0][0];
      expect(args.permissionMode).toBe('bypassPermissions');
    });

    it('fork mode uses config.cwd', async () => {
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        pathToClaudeCodeExecutable: '/usr/bin/claude',
      };

      const factory = claudeRegistration.createFactory(config);
      factory({
        mode: 'fork',
        fromSessionId: 'orig-sess',
        atMessageId: 'msg-42',
      });

      expect(MockClaudeAgentAdapter).toHaveBeenCalledWith({
        pathToClaudeCodeExecutable: '/usr/bin/claude',
        cwd: '/workspace',
        resume: 'orig-sess',
        forkSession: true,
        resumeSessionAt: 'msg-42',
      });
    });

    it('fork mode forwards spec.permissionMode and allowDangerouslySkipPermissions', async () => {
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        pathToClaudeCodeExecutable: '/usr/bin/claude',
      };

      const factory = claudeRegistration.createFactory(config);
      factory({
        mode: 'fork',
        fromSessionId: 'orig-sess',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      });

      const args = MockClaudeAgentAdapter.mock.calls[0][0];
      expect(args.permissionMode).toBe('bypassPermissions');
      expect(args.allowDangerouslySkipPermissions).toBe(true);
    });

    it('hydrated mode uses spec.cwd', async () => {
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        pathToClaudeCodeExecutable: '/usr/bin/claude',
      };

      const history = [
        { type: 'user' as const, uuid: 'u1', timestamp: '2025-01-01', message: { role: 'user' as const, content: [] } },
      ];

      const factory = claudeRegistration.createFactory(config);
      factory({
        mode: 'hydrated',
        cwd: '/other-project',
        history,
        sourceVendor: 'codex',
        sourceSessionId: 'codex-sess',
        model: 'sonnet',
        permissionMode: 'default',
      });

      expect(MockClaudeAgentAdapter).toHaveBeenCalledWith({
        pathToClaudeCodeExecutable: '/usr/bin/claude',
        cwd: '/other-project',
        hydratedHistory: history,
        model: 'sonnet',
        permissionMode: 'default',
      });
    });

    it('omits pathToClaudeCodeExecutable when not in config', async () => {
      mockFindClaudeBinary.mockReturnValue('/found/claude');
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = { cwd: '/workspace' };

      // available() must be called first to set cachedBinaryPath
      claudeRegistration.available(config);

      const factory = claudeRegistration.createFactory(config);
      factory({ mode: 'resume', sessionId: 'sess-789' });

      const constructorArgs = MockClaudeAgentAdapter.mock.calls[0][0];
      expect(constructorArgs).not.toHaveProperty('pathToClaudeCodeExecutable');
      expect(constructorArgs.cwd).toBe('/workspace');
    });

    it('resume mode omits model when getResumeModel returns undefined', async () => {
      const { claudeRegistration } = await freshImport();
      const config: HostAdapterConfig = {
        cwd: '/workspace',
        pathToClaudeCodeExecutable: '/usr/bin/claude',
      };
      mockGetResumeModel.mockReturnValue(undefined);

      const factory = claudeRegistration.createFactory(config);
      factory({ mode: 'resume', sessionId: 'sess-123' });

      const constructorArgs = MockClaudeAgentAdapter.mock.calls[0][0];
      expect(constructorArgs).not.toHaveProperty('model');
    });
  });
});
