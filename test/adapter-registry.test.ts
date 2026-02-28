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

// Mock the registration descriptors so we control them
vi.mock('../src/core/adapters/claude/claude-registration.js', () => ({
  claudeRegistration: null,  // replaced in tests
}));
vi.mock('../src/core/adapters/codex/codex-registration.js', () => ({
  codexRegistration: null,  // replaced in tests
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

    // Inject mock registrations into the module's allRegistrations array
    const registryModule = await import('../src/core/adapters/claude/claude-registration.js');
    const codexModule = await import('../src/core/adapters/codex/codex-registration.js');
    (registryModule as Record<string, unknown>).claudeRegistration = claude;
    (codexModule as Record<string, unknown>).codexRegistration = codex;

    // Re-import to pick up the injected registrations
    vi.resetModules();
    // Re-apply session-manager mock
    vi.doMock('../src/core/session-manager.js', () => ({
      registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
      unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
    }));
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test' };

    freshMod.registerAllAdapters(config);

    expect(claude.available).toHaveBeenCalledWith(config);
    expect(codex.available).toHaveBeenCalledWith(config);
    expect(claude.createFactory).toHaveBeenCalledWith(config);
    expect(codex.createFactory).toHaveBeenCalledWith(config);
    expect(mockRegisterAdapter).toHaveBeenCalledTimes(2);
  });

  it('skips adapters where available() returns false', async () => {
    const claude = createMockRegistration('claude', false);
    const codex = createMockRegistration('codex', true);

    vi.resetModules();
    vi.doMock('../src/core/session-manager.js', () => ({
      registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
      unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
    }));
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test' };

    // Capture stderr
    const stderrSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    freshMod.registerAllAdapters(config);

    expect(claude.available).toHaveBeenCalledWith(config);
    expect(claude.createFactory).not.toHaveBeenCalled();
    expect(codex.createFactory).toHaveBeenCalledWith(config);
    expect(mockRegisterAdapter).toHaveBeenCalledTimes(1);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining('claude adapter skipped'),
    );

    stderrSpy.mockRestore();
  });

  it('passes config to both available() and createFactory()', async () => {
    const claude = createMockRegistration('claude', true);

    vi.resetModules();
    vi.doMock('../src/core/session-manager.js', () => ({
      registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
      unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
    }));
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: createMockRegistration('codex', false),
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = {
      cwd: '/workspace',
      pathToClaudeCodeExecutable: '/usr/bin/claude',
    };

    freshMod.registerAllAdapters(config);

    expect(claude.available).toHaveBeenCalledWith(config);
    expect(claude.createFactory).toHaveBeenCalledWith(config);
  });

  it('returns dispose function that calls unregisterAdapter for each registered vendor', async () => {
    const claude = createMockRegistration('claude', true);
    const codex = createMockRegistration('codex', true);

    vi.resetModules();
    vi.doMock('../src/core/session-manager.js', () => ({
      registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
      unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
    }));
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test' };

    const dispose = freshMod.registerAllAdapters(config);

    expect(mockUnregisterAdapter).not.toHaveBeenCalled();

    dispose();

    expect(mockUnregisterAdapter).toHaveBeenCalledTimes(2);
    expect(mockUnregisterAdapter).toHaveBeenCalledWith('claude');
    expect(mockUnregisterAdapter).toHaveBeenCalledWith('codex');
  });

  it('dispose is safe to call twice (no-op on second call)', async () => {
    const claude = createMockRegistration('claude', true);

    vi.resetModules();
    vi.doMock('../src/core/session-manager.js', () => ({
      registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
      unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
    }));
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: createMockRegistration('codex', false),
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test' };

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
    vi.doMock('../src/core/session-manager.js', () => ({
      registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
      unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
    }));
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test' };

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
    vi.doMock('../src/core/session-manager.js', () => ({
      registerAdapter: (...args: unknown[]) => mockRegisterAdapter(...args),
      unregisterAdapter: (...args: unknown[]) => mockUnregisterAdapter(...args),
    }));
    vi.doMock('../src/core/adapters/claude/claude-registration.js', () => ({
      claudeRegistration: claude,
    }));
    vi.doMock('../src/core/adapters/codex/codex-registration.js', () => ({
      codexRegistration: codex,
    }));

    const freshMod = await import('../src/host/adapter-registry.js');
    const config: HostAdapterConfig = { cwd: '/test' };

    vi.spyOn(console, 'error').mockImplementation(() => {});
    const dispose = freshMod.registerAllAdapters(config);
    dispose();

    // Only codex was registered, so only codex should be unregistered
    expect(mockUnregisterAdapter).toHaveBeenCalledTimes(1);
    expect(mockUnregisterAdapter).toHaveBeenCalledWith('codex');
  });
});
