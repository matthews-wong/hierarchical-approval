import { describe, it, expect } from 'vitest';
import {
  RbacAuthorizationPolicy,
  CompositeAuthorizationPolicy,
} from '../../../src/plugins/resilience/index.js';
import type { AuthorizationContext, IAuthorizationPolicy } from '../../../src/engine/IAuthorizationPolicy.js';
import { ApprovalForbiddenError } from '../../../src/errors.js';
import { makeInstance } from './_helpers.js';

function authCtx(over: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    operation: 'approve',
    actorId: 'user-1',
    instance: makeInstance(),
    opts: {},
    ...over,
  };
}

describe('RbacAuthorizationPolicy — default modes', () => {
  it('denies an operation with no configured rule under default-deny', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: {},
      roleProvider: () => ['approver'],
    });
    const denial = await policy.authorize(authCtx({ operation: 'escalate' }));

    expect(denial).toMatch(/no authorization rule is configured \(default-deny\)/);
  });

  it('allows an operation with no configured rule under default-allow', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: {},
      defaultMode: 'allow',
      roleProvider: () => [],
    });
    expect(await policy.authorize(authCtx({ operation: 'escalate' }))).toBeUndefined();
  });
});

describe('RbacAuthorizationPolicy — requirements', () => {
  it("'allow-all' bypasses the role check entirely", async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { cancel: 'allow-all' },
      roleProvider: () => [],
    });
    expect(await policy.authorize(authCtx({ operation: 'cancel' }))).toBeUndefined();
  });

  it('denies an empty roles list under match any (nothing can satisfy it)', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: [] } },
      roleProvider: () => ['approver'],
    });
    const denial = await policy.authorize(authCtx());

    expect(denial).toMatch(/no role can satisfy an empty 'any' requirement/);
  });

  it('allows an empty roles list under match all (vacuously true)', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: [], match: 'all' } },
      roleProvider: () => [],
    });
    expect(await policy.authorize(authCtx())).toBeUndefined();
  });
});

describe('RbacAuthorizationPolicy — role matching', () => {
  it('allows when the actor holds one of the required roles (match any)', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['manager', 'director'] } },
      roleProvider: () => ['director'],
    });
    expect(await policy.authorize(authCtx())).toBeUndefined();
  });

  it('denies with a message naming the missing roles when none match', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['manager', 'director'] } },
      roleProvider: () => ['clerk'],
    });
    const denial = await policy.authorize(authCtx());

    expect(denial).toBe(
      'Operation "approve" denied: actor "user-1" must have one of role(s): manager, director.',
    );
  });

  it('requires every role under match all and denies when one is missing', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['manager', 'director'], match: 'all' } },
      roleProvider: () => ['manager'],
    });
    const denial = await policy.authorize(authCtx());

    expect(denial).toMatch(/must have all of role\(s\): manager, director/);
  });
});

describe('RbacAuthorizationPolicy — fail-closed provider', () => {
  it('denies and logs when the roleProvider throws', async () => {
    const logged: Array<[string, unknown]> = [];
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['manager'] } },
      roleProvider: () => {
        throw new Error('roles service down');
      },
      logger: {
        info: () => {},
        warn: () => {},
        error: (msg, err) => logged.push([msg, err]),
        fatal: () => {},
        debug: () => {},
      },
    });

    const denial = await policy.authorize(authCtx());

    expect(denial).toMatch(/unable to resolve actor roles/);
    expect(logged[0][0]).toContain('roleProvider failed');
    expect(logged[0][1]).toBeInstanceOf(Error);
  });

  it('denies fail-closed even when defaultMode is allow', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['manager'] } },
      defaultMode: 'allow',
      roleProvider: () => Promise.reject(new Error('down')),
    });
    expect(await policy.authorize(authCtx())).toMatch(/unable to resolve actor roles/);
  });
});

describe('CompositeAuthorizationPolicy — AND mode', () => {
  it('allows when every child allows', async () => {
    const policy = new CompositeAuthorizationPolicy({
      mode: 'and',
      policies: [{ authorize: () => undefined }, { authorize: () => undefined }],
    });
    expect(await policy.authorize(authCtx())).toBeUndefined();
  });

  it('short-circuits on the first denial and returns its message', async () => {
    const called: string[] = [];
    const policy = new CompositeAuthorizationPolicy({
      mode: 'and',
      policies: [
        {
          authorize: async () => {
            called.push('first');
            return 'first denies';
          },
        },
        {
          authorize: async () => {
            called.push('second');
            return 'second denies';
          },
        },
      ],
    });

    expect(await policy.authorize(authCtx())).toBe('first denies');
    expect(called).toEqual(['first']);
  });

  it('allows an empty policy set (vacuous truth)', async () => {
    const policy = new CompositeAuthorizationPolicy({ mode: 'and', policies: [] });
    expect(await policy.authorize(authCtx())).toBeUndefined();
  });
});

describe('CompositeAuthorizationPolicy — OR mode', () => {
  it('allows as soon as one child allows, skipping the rest', async () => {
    const called: string[] = [];
    const policy = new CompositeAuthorizationPolicy({
      mode: 'or',
      policies: [
        {
          authorize: async () => {
            called.push('first');
            return undefined;
          },
        },
        {
          authorize: async () => {
            called.push('second');
            return 'never reached';
          },
        },
      ],
    });

    expect(await policy.authorize(authCtx())).toBeUndefined();
    expect(called).toEqual(['first']);
  });

  it('denies with the LAST denial message when every child denies', async () => {
    const policy = new CompositeAuthorizationPolicy({
      mode: 'or',
      policies: [
        { authorize: () => 'denial one' },
        { authorize: () => 'denial two' },
      ],
    });
    expect(await policy.authorize(authCtx())).toBe('denial two');
  });

  it('denies an empty policy set (vacuous falsity) with a clear message', async () => {
    const policy = new CompositeAuthorizationPolicy({ mode: 'or', policies: [] });
    expect(await policy.authorize(authCtx())).toMatch(
      /no authorization policies are configured \(OR composite is vacuously closed\)/,
    );
  });
});

describe('CompositeAuthorizationPolicy — child normalization', () => {
  it('treats an empty-string denial from a child as allow', async () => {
    const policy = new CompositeAuthorizationPolicy({
      mode: 'and',
      policies: [{ authorize: () => '' }],
    });
    expect(await policy.authorize(authCtx())).toBeUndefined();
  });

  it('normalizes a thrown ApprovalForbiddenError to its message', async () => {
    const policy = new CompositeAuthorizationPolicy({
      mode: 'and',
      policies: [
        {
          authorize: () => {
            throw new ApprovalForbiddenError('role check failed');
          },
        },
      ],
    });
    expect(await policy.authorize(authCtx())).toBe('role check failed');
  });

  it('propagates non-authorization errors instead of treating them as denials', async () => {
    const boom = new Error('database down');
    const policy = new CompositeAuthorizationPolicy({
      mode: 'and',
      policies: [
        {
          authorize: () => {
            throw boom;
          },
        },
      ],
    });
    await expect(policy.authorize(authCtx())).rejects.toBe(boom);
  });
});