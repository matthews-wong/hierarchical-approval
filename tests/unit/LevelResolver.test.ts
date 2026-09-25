import { describe, it, expect, vi } from 'vitest';
import { LevelResolver, type OrgProvider } from '../../src/engine/LevelResolver.js';
import { ApprovalValidationError } from '../../src/errors.js';
import type { ApproverConfig, ResolverFn } from '../../src/types/index.js';

function makeOrgProvider(overrides: Partial<OrgProvider> = {}): OrgProvider {
  return {
    getUsersByRole: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

describe('LevelResolver', () => {
  it('resolves user approvers directly', async () => {
    const resolver = new LevelResolver();
    const approvers: ApproverConfig[] = [{ type: 'user', userId: 'u1' }];
    await expect(resolver.resolveApprovers(approvers, 'submitter', {})).resolves.toEqual(['u1']);
  });

  it('role — throws without an orgProvider, naming the role', async () => {
    const resolver = new LevelResolver();
    const approvers: ApproverConfig[] = [{ type: 'role', role: 'manager' }];
    await expect(resolver.resolveApprovers(approvers, 'submitter', {})).rejects.toThrow(
      ApprovalValidationError,
    );
    await expect(resolver.resolveApprovers(approvers, 'submitter', {})).rejects.toThrow(
      /Cannot resolve role "manager" without an orgProvider/,
    );
  });

  it('role — resolves members through the orgProvider', async () => {
    const resolver = new LevelResolver();
    const orgProvider = makeOrgProvider({
      getUsersByRole: vi.fn().mockResolvedValue(['m1', 'm2']),
    });
    const approvers: ApproverConfig[] = [{ type: 'role', role: 'manager' }];
    await expect(
      resolver.resolveApprovers(approvers, 'submitter', {}, orgProvider),
    ).resolves.toEqual(['m1', 'm2']);
    expect(orgProvider.getUsersByRole).toHaveBeenCalledWith('manager');
  });

  it('dynamic — resolves through a registered resolver', async () => {
    const resolver = new LevelResolver();
    const fn: ResolverFn = vi.fn().mockReturnValue('d1');
    resolver.register('delegate', fn);
    const approvers: ApproverConfig[] = [{ type: 'dynamic', resolver: 'delegate' }];
    await expect(resolver.resolveApprovers(approvers, 'submitter', { amount: 5 })).resolves.toEqual(
      ['d1'],
    );
    expect(fn).toHaveBeenCalledWith('submitter', { amount: 5 });
  });

  it('dynamic — throws naming the unregistered resolver', async () => {
    const resolver = new LevelResolver();
    const approvers: ApproverConfig[] = [{ type: 'dynamic', resolver: 'missing' }];
    await expect(resolver.resolveApprovers(approvers, 'submitter', {})).rejects.toThrow(
      ApprovalValidationError,
    );
    await expect(resolver.resolveApprovers(approvers, 'submitter', {})).rejects.toThrow(
      /No resolver registered for "missing"/,
    );
  });

  it('custom type — resolves through a registered approver type', async () => {
    const resolver = new LevelResolver();
    resolver.registerApproverType('dept', async (config, ctx) => {
      expect(config.dept).toBe('engineering');
      expect(ctx.submittedBy).toBe('submitter');
      return ['d1', 'd2'];
    });
    const approvers: ApproverConfig[] = [{ type: 'dept', dept: 'engineering' }];
    await expect(resolver.resolveApprovers(approvers, 'submitter', {})).resolves.toEqual([
      'd1',
      'd2',
    ]);
  });

  it('copyRegistrationsTo copies registered approver types, not just dynamic resolvers', async () => {
    const source = new LevelResolver();
    const target = new LevelResolver();
    source.registerApproverType('dept', async () => ['d1']);
    const approvers: ApproverConfig[] = [{ type: 'dept' }];

    await expect(target.resolveApprovers(approvers, 'submitter', {})).rejects.toThrow(
      /Unknown approver type "dept"/,
    );

    source.copyRegistrationsTo(target);

    await expect(target.resolveApprovers(approvers, 'submitter', {})).resolves.toEqual(['d1']);
  });

  it('custom type — throws ApprovalValidationError naming the unknown type', async () => {
    const resolver = new LevelResolver();
    const approvers: ApproverConfig[] = [{ type: 'not-registered' }];
    await expect(resolver.resolveApprovers(approvers, 'submitter', {})).rejects.toThrow(
      /Unknown approver type "not-registered"/,
    );
  });

  it('dedupes ids resolved from multiple sources', async () => {
    const resolver = new LevelResolver();
    const orgProvider = makeOrgProvider({
      getUsersByRole: vi.fn().mockResolvedValue(['u1', 'u2']),
    });
    const approvers: ApproverConfig[] = [
      { type: 'user', userId: 'u1' },
      { type: 'role', role: 'manager' },
    ];
    await expect(
      resolver.resolveApprovers(approvers, 'submitter', {}, orgProvider),
    ).resolves.toEqual(['u1', 'u2']);
  });

  it('throws when nothing resolves (empty role)', async () => {
    const resolver = new LevelResolver();
    const orgProvider = makeOrgProvider({ getUsersByRole: vi.fn().mockResolvedValue([]) });
    const approvers: ApproverConfig[] = [{ type: 'role', role: 'manager' }];
    await expect(
      resolver.resolveApprovers(approvers, 'submitter', {}, orgProvider),
    ).rejects.toThrow(/No approvers resolved for this level from 1 configured approver config\(s\)/);
  });

  it('custom type passes orgProvider to context', async () => {
    const resolver = new LevelResolver();
    const mockOrg = makeOrgProvider();
    let passedOrg: OrgProvider | undefined;
    resolver.registerApproverType('custom', (config, ctx) => {
      passedOrg = ctx.orgProvider;
      return ['u1'];
    });
    const approvers: ApproverConfig[] = [{ type: 'custom' }];
    await resolver.resolveApprovers(approvers, 'submitter', {}, mockOrg);
    expect(passedOrg).toBe(mockOrg);
  });

  it('defaults the out-of-office resolution time to now when none is given', async () => {
    const resolver = new LevelResolver();
    const seen: Date[] = [];
    const approvers: ApproverConfig[] = [{ type: 'user', userId: 'mgr' }];
    const before = Date.now();
    await resolver.resolveApprovers(approvers, 'submitter', {}, undefined, {
      getDelegateFor: (_userId, at) => {
        seen.push(at);
        return null;
      },
    });
    expect(seen[0]?.getTime()).toBeGreaterThanOrEqual(before);
    expect(seen[0]?.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
