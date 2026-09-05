import { describe, it, expect } from 'vitest';
import {
  RbacAuthorizationPolicy,
  CompositeAuthorizationPolicy,
  RateLimitMiddleware,
  LoggingMiddleware,
  defaultLoggingCorrelationKeyFn,
} from '../../../src/plugins/resilience/index.js';
import type { AuthorizationContext } from '../../../src/engine/IAuthorizationPolicy.js';
import type { OperationContext } from '../../../src/engine/IOperationMiddleware.js';
import { ApprovalError, ApprovalForbiddenError } from '../../../src/errors.js';
import { makeInstance, ManualClock, spyLogger } from './_helpers.js';

/** Context valid for both authorization policies and operation middlewares. */
function authCtx(
  over: Partial<AuthorizationContext> & Partial<OperationContext> = {},
): AuthorizationContext & OperationContext {
  return {
    operation: 'approve',
    actorId: 'user-1',
    instance: makeInstance(),
    opts: {},
    tenantId: 'tenant-1',
    input: {},
    instanceId: 'inst-1',
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
      policies: [{ authorize: () => 'denial one' }, { authorize: () => 'denial two' }],
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

describe('RateLimitMiddleware — constructor validation', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new RateLimitMiddleware({ capacity: 0, refillTokensPerSecond: 1 })).toThrow(
      /capacity must be a positive finite number/,
    );
  });

  it('rejects a negative refill rate', () => {
    expect(() => new RateLimitMiddleware({ capacity: 5, refillTokensPerSecond: -1 })).toThrow(
      /refillTokensPerSecond must be a non-negative finite number/,
    );
  });

  it('rejects a non-positive costPerRequest', () => {
    expect(
      () => new RateLimitMiddleware({ capacity: 5, refillTokensPerSecond: 1, costPerRequest: 0 }),
    ).toThrow(/costPerRequest must be a positive finite number/);
  });

  it('rejects a costPerRequest larger than capacity', () => {
    expect(
      () => new RateLimitMiddleware({ capacity: 2, refillTokensPerSecond: 1, costPerRequest: 3 }),
    ).toThrow(/costPerRequest cannot exceed capacity/);
  });
});

describe('RateLimitMiddleware — token bucket', () => {
  it('lets capacity-burst requests through and rejects the excess with FORBIDDEN', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({ capacity: 2, refillTokensPerSecond: 1, clock });

    mw.before(authCtx());
    mw.before(authCtx());
    expect(() => mw.before(authCtx())).toThrow(ApprovalForbiddenError);
  });

  it('rejects with a message naming the resolved bucket key', () => {
    const mw = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 1 });
    mw.before(authCtx());
    expect(() => mw.before(authCtx())).toThrow(
      /Rate limit exceeded for "user-1:approve". Please retry later./,
    );
  });

  it('succeeds when a request brings the bucket exactly to zero, then rejects the next', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 1, clock });

    mw.before(authCtx()); // 1 -> 0, succeeds
    expect(() => mw.before(authCtx())).toThrow(ApprovalForbiddenError);
  });

  it('refills tokens from the injected clock between requests', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 1, clock });

    mw.before(authCtx()); // 1 -> 0, exhausted
    expect(() => mw.before(authCtx())).toThrow(ApprovalForbiddenError);

    clock.advance(1_000); // accrues exactly 1 token (1s * 1/s)
    expect(() => mw.before(authCtx())).not.toThrow(); // refilled request succeeds
  });

  it('clamps refill to capacity (never overfills)', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({ capacity: 2, refillTokensPerSecond: 1, clock });

    mw.before(authCtx()); // 2 -> 1
    clock.advance(10_000); // would accrue 10 tokens
    expect(mw.peekTokens(authCtx())).toBe(2);
  });

  it('treats a backwards-moving clock as zero elapsed time (balance never goes negative)', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 1, clock });

    mw.before(authCtx()); // 1 -> 0, exhausted
    clock.advance(-5_000); // clock goes backwards

    expect(mw.peekTokens(authCtx())).toBe(0); // clamped, not negative
    expect(() => mw.before(authCtx())).toThrow(ApprovalForbiddenError); // still exhausted
  });

  it('peekTokens returns full capacity for an untouched bucket without creating one', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 1, clock });

    expect(mw.peekTokens(authCtx())).toBe(1);
    // Peeking must not consume: the first real request still sees the full bucket.
    mw.before(authCtx()); // 1 -> 0
    expect(() => mw.before(authCtx())).toThrow(ApprovalForbiddenError);
  });

  it('peekTokens projects accrued tokens for a touched bucket without persisting them', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({ capacity: 5, refillTokensPerSecond: 1, clock });

    mw.before(authCtx()); // 5 -> 4
    clock.advance(200); // 0.2s elapsed
    expect(mw.peekTokens(authCtx())).toBeCloseTo(4.2, 5);
    // A repeated peek at the same instant is stable, confirming the store wasn't mutated.
    expect(mw.peekTokens(authCtx())).toBeCloseTo(4.2, 5);
  });

  it('reset clears all buckets (tokens return to capacity)', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 1, clock });

    mw.before(authCtx());
    mw.reset();
    expect(() => mw.before(authCtx())).not.toThrow();
  });

  it('supports a custom messageFn and costPerRequest', () => {
    const clock = new ManualClock(0);
    const mw = new RateLimitMiddleware({
      capacity: 3,
      refillTokensPerSecond: 1,
      costPerRequest: 3,
      clock,
      messageFn: (key) => `Busy for ${key}`,
    });

    mw.before(authCtx()); // 3 -> 0
    expect(() => mw.before(authCtx())).toThrow(/^Busy for user-1:approve$/);
  });
});

describe('LoggingMiddleware — correlation key', () => {
  it('defaults to instanceId ?? operation', () => {
    expect(defaultLoggingCorrelationKeyFn(authCtx())).toBe('inst-1');
    expect(
      defaultLoggingCorrelationKeyFn(authCtx({ operation: 'submit', instanceId: undefined })),
    ).toBe('submit');
  });

  it('honors a custom correlationKeyFn', () => {
    const logger = spyLogger();
    const mw = new LoggingMiddleware({
      logger,
      correlationKeyFn: (ctx) => `tenant:${ctx.tenantId}`,
    });
    mw.before(authCtx({ instanceId: 'inst-1' }));
    mw.after(authCtx({ instanceId: 'inst-1' }), makeInstance());

    // Both calls resolved to the same key, so a duration was measured.
    expect(logger.info.mock.calls[1][1]).toMatchObject({ durationMs: expect.any(Number) });
  });
});

describe('LoggingMiddleware — lifecycle logging', () => {
  it('logs start fields on before and success fields with durationMs on after', () => {
    const clock = new ManualClock(1_000);
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ logger, clock });

    mw.before(authCtx());
    clock.advance(250);
    mw.after(authCtx(), makeInstance());

    expect(logger.info.mock.calls[0]).toEqual([
      'operation.start',
      {
        operation: 'approve',
        actorId: 'user-1',
        tenantId: 'tenant-1',
        instanceId: 'inst-1',
      },
    ]);
    expect(logger.info.mock.calls[1]).toEqual([
      'operation.success',
      {
        operation: 'approve',
        actorId: 'user-1',
        tenantId: 'tenant-1',
        instanceId: 'inst-1',
        durationMs: 250,
      },
    ]);
  });

  it('logs the error code and name on onError without suppressing the error', () => {
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ logger });
    const err = new ApprovalError('denied', 'FORBIDDEN');
    const ctx = authCtx();

    expect(() => mw.onError(ctx, err)).not.toThrow();
    expect(logger.error.mock.calls[0][0]).toBe('operation.error');
    expect(logger.error.mock.calls[0][2]).toMatchObject({
      errorCode: 'FORBIDDEN',
      errorName: 'ApprovalError',
      durationMs: null, // before never ran
    });
  });

  it('reports null rather than NaN when before never ran for the key', () => {
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ logger });

    mw.after(authCtx(), makeInstance());

    expect(logger.info.mock.calls[0][1]).toMatchObject({ durationMs: null });
  });

  it('honors custom start/success/error messages', () => {
    const logger = spyLogger();
    const mw = new LoggingMiddleware({
      logger,
      startMessage: 'wf.start',
      successMessage: 'wf.ok',
      errorMessage: 'wf.ko',
    });

    mw.before(authCtx());
    mw.after(authCtx(), makeInstance());
    mw.onError(authCtx(), new ApprovalError('x', 'VALIDATION'));

    expect(logger.info.mock.calls[0][0]).toBe('wf.start');
    expect(logger.info.mock.calls[1][0]).toBe('wf.ok');
    expect(logger.error.mock.calls[0][0]).toBe('wf.ko');
  });
});

describe('LoggingMiddleware — overlapping operations (LIFO pairing)', () => {
  it('pairs after with the most recent start under the same key', () => {
    const clock = new ManualClock(0);
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ logger, clock });
    // Two concurrent submits share the key 'submit' (no instanceId).
    const ctx = authCtx({ operation: 'submit', instanceId: undefined });

    mw.before(ctx);
    clock.advance(100);
    mw.before(ctx);
    clock.advance(100);
    mw.after(ctx, makeInstance()); // pairs with the SECOND start -> 100ms

    expect(logger.info.mock.calls[2][1]).toMatchObject({ durationMs: 100 });

    clock.advance(100);
    mw.after(ctx, makeInstance()); // pairs with the FIRST start -> 300ms
    expect(logger.info.mock.calls[3][1]).toMatchObject({ durationMs: 300 });
  });

  it('cleans up the key after the last in-flight start is consumed', () => {
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ logger });
    const ctx = authCtx({ instanceId: undefined });

    mw.before(ctx);
    mw.after(ctx, makeInstance());
    // A subsequent onError with no pending start must not throw or pair.
    mw.onError(ctx, new ApprovalError('x', 'VALIDATION'));

    expect(logger.error.mock.calls[0][2]).toMatchObject({ durationMs: null });
  });
});
