/**
 * Tests for Adapter Registry — centralized adapter registration.
 *
 * Mocks session-manager to verify registerAdapter/unregisterAdapter calls.
 * Uses inline mock AdapterRegistration descriptors (not real ones).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { VendorDiscovery, SessionOpenSpec, AgentAdapter } from '../src/core/agent-adapter.js';
import type { Vendor } from '../src/core/transcript.js';
import type { AdapterRegistration, HostAdapterConfig } from '../src/host/adapter-registry.js';

// Mock session-manager before importing adapter-registry
const mockRegisterAdapter = vi.fn();
const mockUnregisterAdapter = vi.fn();
vi.mock('../src/core/session-manager.js', () => ({
  registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
  unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
}));

// Mock session-channel (getActiveChannels used by settings change listener)
vi.mock('../src/core/session-channel.js', () => ({
  getActiveChannels: () => [],
}));

// Mock settings module
vi.mock('../src/core/settings/index.js', () => ({
  getSettingsSnapshotInternal: () => ({
    settings: { mcp: { memory: { vscode: true, devServer: true } } },
    revision: 1,
    updatedAt: new Date().toISOString(),
  }),
  onSettingsChanged: () => () => {},
  setMcpFactories: () => {},
}));

// Mock external MCP server
const mockExternalServer = { type: 'sdk' as const, name: 'memory', instance: {} };
vi.mock('../src/mcp/servers/external.js', () => ({
  createExternalServer: () => mockExternalServer,
}));

// Mock ClaudeAgentAdapter (imported for instanceof checks)
vi.mock('../src/core/adapters/claude/claude-code-adapter.js', () => ({
  ClaudeAgentAdapter: class {},
}));

// Mock the registration descriptors so we control them
vi.mock('../src/core/adapters/claude/claude-registration.js', () => ({
  claudeRegistration: null,  // replaced in tests
}));
vi.mock('../src/core/adapters/codex/codex-registration.js', () => ({
  codexRegistration: null,  // replaced in tests
}));
vi.mock('../src/core/adapters/opencode/opencode-registration.js', () => ({
  opencodeRegistration: null,  // replaced in tests
}));

// ============================================================================
// Helpers
// ============================================================================

function createMockDiscovery(vendor: string): VendorDiscovery {
  return {
    vendor: vendor as Vendor,
    findSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    loadHistory: vi.fn().mockResolvedValue([]),
  };
}

function createMockDispatch() {
  return {
    listSessions: vi.fn(),
    findSession: vi.fn(),
    loadSession: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    sendTurn: vi.fn(),
    resolveApproval: vi.fn(),
    interrupt: vi.fn(),
    close: vi.fn(),
    dispatchChild: vi.fn(),
    onEvent: vi.fn().mockReturnValue(() => {}),
    dispose: vi.fn(),
  };
}

/** Re-apply all infrastructure mocks after vi.resetModules(). */
function applyInfraMocks() {
  vi.doMock('../src/core/session-manager.js', () => ({
    registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
    unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
  }));
  vi.doMock('../src/core/session-channel.js', () => ({
    getActiveChannels: () => [],
  }));
  vi.doMock('../src/core/settings/index.js', () => ({
    getSettingsSnapshotInternal: () => ({
      settings: { mcp: { memory: { vscode: true, devServer: true } } },
      revision: 1,
      updatedAt: new Date().toISOString(),
    }),
    onSettingsChanged: () => () => {},
    setMcpFactories: () => {},
  }));
  vi.doMock('../src/mcp/servers/external.js', () => ({
    createExternalServer: () => mockExternalServer,
  }));
  vi.doMock('../src/core/adapters/claude/claude-code-adapter.js', () => ({
    ClaudeAgentAdapter: class {},
  }));
  vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
    opencodeRegistration: createMockRegistration('opencode', false),
  }));
}

function createMockRegistration(
  vendor: string,
  available: boolean,
): AdapterRegistration {
  const discovery = createMockDiscovery(vendor);
  const factory = vi.fn().mockReturnValue({} as AgentAdapter);
  return {
    vendor,
    discovery,
    available: vi.fn().mockReturnValue(available),
    createFactory: vi.fn().mockReturnValue(factory),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('registerAllAdapters', () => {
  let registerAllAdapters: typeof import('../src/host/adapter-registry.js').registerAllAdapters;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Fresh import each time to pick up mock state
    const mod = await import('../src/host/adapter-registry.js');
    registerAllAdapters = mod.registerAllAdapters;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('registers adapters where available() returns true', async () => {
    const claude = createMockRegistration('claude', true);
    const codex = createMockRegistration('codex', true);
    const opencode = createMockRegistration('opencode', true);

    vi.resetModules();
    applyInfraMocks();
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));
    vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
      opencodeRegistration: opencode,
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' as const, dispatch: createMockDispatch() as never };

    freshMod.registerAllAdapters(config);

    expect(claude.available).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd, hostType: config.hostType }));
    expect(codex.available).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd, hostType: config.hostType }));
    expect(claude.createFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd, hostType: config.hostType }));
    expect(codex.createFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd, hostType: config.hostType }));
    expect(mockRegisterAdapter).toHaveBeenCalledTimes(3);
  });

  it('skips adapters where available() returns false', async () => {
    const claude = createMockRegistration('claude', false);
    const codex = createMockRegistration('codex', true);

    vi.resetModules();
    applyInfraMocks();
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));
    vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
      opencodeRegistration: createMockRegistration('opencode', false),
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' as const, dispatch: createMockDispatch() as never };

    // Capture stderr
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    freshMod.registerAllAdapters(config);

    expect(claude.available).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd, hostType: config.hostType }));
    expect(claude.createFactory).not.toHaveBeenCalled();
    expect(codex.createFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd, hostType: config.hostType }));
    expect(mockRegisterAdapter).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('claude adapter skipped'),
    );

    stderrSpy.mockRestore();
  });

  it('passes config to both available() and createFactory()', async () => {
    const claude = createMockRegistration('claude', true);

    vi.resetModules();
    applyInfraMocks();
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: createMockRegistration('codex', false),
    }));
    vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
      opencodeRegistration: createMockRegistration('opencode', false),
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = {
      cwd: '/workspace',
      hostType: 'vscode',
      pathToClaudeCodeExecutable: '/usr/bin/claude',
      dispatch: createMockDispatch() as never,
    };

    freshMod.registerAllAdapters(config);

    expect(claude.available).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd, hostType: config.hostType }));
    expect(claude.createFactory).toHaveBeenCalledWith(expect.objectContaining({ cwd: config.cwd, hostType: config.hostType }));
  });

  it('returns dispose function that calls unregisterAdapter for each registered vendor', async () => {
    const claude = createMockRegistration('claude', true);
    const codex = createMockRegistration('codex', true);
    const opencode = createMockRegistration('opencode', true);

    vi.resetModules();
    applyInfraMocks();
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));
    vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
      opencodeRegistration: opencode,
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' as const, dispatch: createMockDispatch() as never };

    const dispose = freshMod.registerAllAdapters(config);

    expect(mockUnregisterAdapter).not.toHaveBeenCalled();

    dispose();

    expect(mockUnregisterAdapter).toHaveBeenCalledTimes(3);
    expect(mockUnregisterAdapter).toHaveBeenCalledWith('claude');
    expect(mockUnregisterAdapter).toHaveBeenCalledWith('codex');
    expect(mockUnregisterAdapter).toHaveBeenCalledWith('opencode');
  });

  it('dispose is safe to call twice (no-op on second call)', async () => {
    const claude = createMockRegistration('claude', true);

    vi.resetModules();
    applyInfraMocks();
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: createMockRegistration('codex', false),
    }));
    vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
      opencodeRegistration: createMockRegistration('opencode', false),
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' as const, dispatch: createMockDispatch() as never };

    const dispose = freshMod.registerAllAdapters(config);

    dispose();
    dispose(); // second call — should not throw

    // unregisterAdapter called twice for claude (once per dispose call)
    // but second call is a no-op in session-manager since it's already gone
    expect(mockUnregisterAdapter).toHaveBeenCalledTimes(2);
  });

  it('registers Claude before Codex (matches allRegistrations order)', async () => {
    const claude = createMockRegistration('claude', true);
    const codex = createMockRegistration('codex', true);

    vi.resetModules();
    applyInfraMocks();
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));
    vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
      opencodeRegistration: createMockRegistration('opencode', true),
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' as const, dispatch: createMockDispatch() as never };

    freshMod.registerAllAdapters(config);

    // Claude's factory registered first
    const firstCall = mockRegisterAdapter.mock.calls[0];
    const secondCall = mockRegisterAdapter.mock.calls[1];
    expect(firstCall[0]).toBe(claude.discovery);
    expect(secondCall[0]).toBe(codex.discovery);
  });

  it('dispose only unregisters vendors that were actually registered', async () => {
    const claude = createMockRegistration('claude', false); // unavailable
    const codex = createMockRegistration('codex', true);

    vi.resetModules();
    applyInfraMocks();
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));
    vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
      opencodeRegistration: createMockRegistration('opencode', false),
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' as const, dispatch: createMockDispatch() as never };

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispose = freshMod.registerAllAdapters(config);
    dispose();

    // Only codex was registered, so only codex should be unregistered
    expect(mockUnregisterAdapter).toHaveBeenCalledTimes(1);
    expect(mockUnregisterAdapter).toHaveBeenCalledWith('codex');
  });

  it('works without dispatch (no external server created)', async () => {
    const claude = createMockRegistration('claude', true);

    vi.resetModules();
    applyInfraMocks();
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: createMockRegistration('codex', false),
    }));
    vi.doMock('../src/core/adapters/opencode/opencode-registration.js', () => ({
      opencodeRegistration: createMockRegistration('opencode', false),
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    // No dispatch — external server should not be created
    const config: HostAdapterConfig = { cwd: '/test', hostType: 'dev-server' as const };

    vi.spyOn(console, 'error').mockImplementation(() => {});
    freshMod.registerAllAdapters(config);

    // Should still register adapters, just without MCP
    expect(mockRegisterAdapter).toHaveBeenCalledTimes(1);
    // Config passed to factory should NOT have mcpServers
    const factoryCall = claude.createFactory as ReturnType<typeof vi.fn>;
    const passedConfig = factoryCall.mock.calls[0][0];
    expect(passedConfig.mcpServers).toBeUndefined();
  });
});
