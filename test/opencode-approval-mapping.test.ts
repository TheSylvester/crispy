/**
 * Tests for opencode-approval-mapping.ts — Tier 1 (pure functions, no I/O)
 *
 * Forward: OpenCode permission → Crispy AwaitingApprovalEvent fields
 * Reverse: Crispy response → OpenCode POST body
 */

import { describe, it, expect } from 'vitest';
import {
  permissionToApprovalEvent,
  crispyResponseToPermissionReply,
} from '../src/core/adapters/opencode/opencode-approval-mapping.js';
import type { Permission } from '@opencode-ai/sdk/client';

function makePermission(overrides: Partial<Permission> = {}): Permission {
  return {
    id: 'perm-1',
    type: 'bash',
    sessionID: 'session-1',
    messageID: 'msg-1',
    title: 'Allow bash execution?',
    metadata: { command: 'ls -la' },
    time: { created: 1000 },
    ...overrides,
  };
}

describe('Forward mapping: permission → approval event', () => {
  it('maps bash permission to Bash toolName', () => {
    const result = permissionToApprovalEvent(makePermission({ type: 'bash' }));
    expect(result.toolName).toBe('Bash');
    expect(result.toolUseId).toBe('perm-1');
    expect(result.reason).toBe('Allow bash execution?');
  });

  it('maps edit permission to Edit toolName', () => {
    const result = permissionToApprovalEvent(makePermission({ type: 'edit' }));
    expect(result.toolName).toBe('Edit');
  });

  it('always includes allow, allow_session, deny options', () => {
    const result = permissionToApprovalEvent(makePermission());
    expect(result.options).toHaveLength(3);
    expect(result.options.map((o) => o.id)).toEqual(['allow', 'allow_session', 'deny']);
  });

  it('surfaces always patterns in allow_session description', () => {
    const result = permissionToApprovalEvent(makePermission({
      pattern: ['ls *', 'cat *'],
    }));
    const alwaysOpt = result.options.find((o) => o.id === 'allow_session');
    expect(alwaysOpt?.description).toContain('ls *');
    expect(alwaysOpt?.description).toContain('cat *');
  });

  it('surfaces single pattern string in description', () => {
    const result = permissionToApprovalEvent(makePermission({
      pattern: 'ls *',
    }));
    const alwaysOpt = result.options.find((o) => o.id === 'allow_session');
    expect(alwaysOpt?.description).toContain('ls *');
  });

  it('no description when pattern is absent', () => {
    const result = permissionToApprovalEvent(makePermission({
      pattern: undefined,
    }));
    const alwaysOpt = result.options.find((o) => o.id === 'allow_session');
    expect(alwaysOpt?.description).toBeUndefined();
  });

  it('unknown permission type passes through', () => {
    const result = permissionToApprovalEvent(makePermission({ type: 'custom_perm' }));
    expect(result.toolName).toBe('custom_perm');
  });

  it('includes metadata and pattern in input', () => {
    const result = permissionToApprovalEvent(makePermission({
      metadata: { command: 'rm -rf /' },
      pattern: 'rm *',
      callID: 'call-42',
    }));
    expect(result.input).toMatchObject({
      command: 'rm -rf /',
      pattern: 'rm *',
      callID: 'call-42',
    });
  });
});

describe('Reverse mapping: Crispy response → OpenCode reply', () => {
  it('allow → { response: "once" }', () => {
    expect(crispyResponseToPermissionReply('allow')).toEqual({ response: 'once' });
  });

  it('allow_session → { response: "always" }', () => {
    expect(crispyResponseToPermissionReply('allow_session')).toEqual({ response: 'always' });
  });

  it('deny → { response: "reject" }', () => {
    expect(crispyResponseToPermissionReply('deny')).toEqual({ response: 'reject' });
  });

  it('unknown option → reject for safety', () => {
    expect(crispyResponseToPermissionReply('unknown')).toEqual({ response: 'reject' });
  });
});
