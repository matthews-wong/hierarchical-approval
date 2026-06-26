import { describe, it, expect, vi } from 'vitest';
import {
  RateLimitMiddleware,
  defaultRateLimitKeyFn,
  LoggingMiddleware,
  defaultLoggingCorrelationKeyFn,
  RbacAuthorizationPolicy,
  CompositeAuthorizationPolicy,
} from '../../../src/plugins/resilience/index.js';
import { ApprovalForbiddenError, ApprovalError } from '../../../src/errors.js';
import type { OperationContext } from '../../../src/engine/IOperationMiddleware.js';
import type { AuthorizationContext } from '../../../src/engine/IAuthorizationPolicy.js';
import type { IAuthorizationPolicy } from '../../../src/engine/IAuthorizationPolicy.js';
import { ManualClock, spyLogger, makeInstance } from './_helpers.js';

function opCtx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    operation: 'approve',
    tenantId: 'tenant-1',
    actorId: 'user-1',
    instanceId: 'inst-1',
    input: {},
    ...over,
  };
}

function authCtx(over: Partial<AuthorizationContext> = {}): AuthorizationContext {
  return {
    operation: 'approve',
    actorId: 'user-1',
    instance: makeInstance(),
    opts: {},
    ...over,
  };
}

describe('RateLimitMiddleware — construction', () => {
  it('rejects non-positive capacity', () => {
    expect(() => new RateLimitMiddleware({ capacity: 0, refillTokensPerSecond: 1 })).toThrow(/capacity/);
  });
  it('rejects negative refill rate', () => {
    expect(() => new RateLimitMiddleware({ capacity: 5, refillTokensPerSecond: -1 })).toThrow(/refill/);
  });
  it('rejects costPerRequest > capacity', () => {
    expect(
      () => new RateLimitMiddleware({ capacity: 2, refillTokensPerSecond: 1, costPerRequest: 3 }),
    ).toThrow(/capacity/);
  });
});

describe('RateLimitMiddleware — token bucket', () => {
  it('allows up to capacity, then rejects with ApprovalForbiddenError (403/FORBIDDEN)', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 3, refillTokensPerSecond: 0, clock });
    const ctx = opCtx();
    rl.before(ctx);
    rl.before(ctx);
    rl.before(ctx);
    let err: unknown;
    try {
      rl.before(ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ApprovalForbiddenError);
    expect((err as ApprovalForbiddenError).code).toBe('FORBIDDEN');
    expect((err as ApprovalForbiddenError).toHttpStatus()).toBe(403);
  });

  it('consume-to-zero edge: request hitting zero succeeds, next is rejected', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 0, clock });
    const ctx = opCtx();
    expect(() => rl.before(ctx)).not.toThrow(); // brings to 0
    expect(() => rl.before(ctx)).toThrow(ApprovalForbiddenError);
  });

  it('refill is driven solely by the injected clock', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 2, refillTokensPerSecond: 1, clock });
    const ctx = opCtx();
    rl.before(ctx);
    rl.before(ctx); // bucket now 0
    expect(() => rl.before(ctx)).toThrow();
    clock.advance(1000); // +1 token
    expect(() => rl.before(ctx)).not.toThrow();
    expect(() => rl.before(ctx)).toThrow();
  });

  it('fractional refill is floored at consume time', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 5, refillTokensPerSecond: 1, clock });
    const ctx = opCtx();
    for (let i = 0; i < 5; i++) rl.before(ctx); // drain
    clock.advance(500); // +0.5 token, not enough for cost 1
    expect(rl.peekTokens(ctx)).toBeCloseTo(0.5, 5);
    expect(() => rl.before(ctx)).toThrow();
    clock.advance(500); // now 1.0 token
    expect(() => rl.before(ctx)).not.toThrow();
  });

  it('never exceeds capacity after a long idle (no overflow)', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 3, refillTokensPerSecond: 10, clock });
    const ctx = opCtx();
    rl.before(ctx); // drain a bit
    clock.advance(1_000_000); // huge idle
    expect(rl.peekTokens(ctx)).toBe(3);
  });

  it('clock moving backwards is clamped to zero elapsed (no negative refill)', () => {
    const clock = new ManualClock(10_000);
    const rl = new RateLimitMiddleware({ capacity: 2, refillTokensPerSecond: 1, clock });
    const ctx = opCtx();
    rl.before(ctx);
    rl.before(ctx); // bucket 0
    clock.set(0); // jump backwards
    expect(rl.peekTokens(ctx)).toBe(0);
    expect(() => rl.before(ctx)).toThrow();
  });

  it('default key isolates actorId+operation; one actor cannot starve another', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 0, clock });
    rl.before(opCtx({ actorId: 'a' }));
    expect(() => rl.before(opCtx({ actorId: 'a' }))).toThrow();
    // Different actor has its own full bucket.
    expect(() => rl.before(opCtx({ actorId: 'b' }))).not.toThrow();
  });

  it('different operations for the same actor are isolated', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 0, clock });
    rl.before(opCtx({ operation: 'approve' }));
    expect(() => rl.before(opCtx({ operation: 'reject' }))).not.toThrow();
  });

  it('a custom keyFn collapsing actors shares one bucket', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({
      capacity: 1,
      refillTokensPerSecond: 0,
      clock,
      keyFn: (c) => c.operation,
    });
    rl.before(opCtx({ actorId: 'a' }));
    expect(() => rl.before(opCtx({ actorId: 'b' }))).toThrow(); // shared bucket exhausted
  });

  it('operations without instanceId (submit) are still rate-limited via operation-based default key', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 0, clock });
    const ctx = opCtx({ operation: 'submit', instanceId: undefined });
    rl.before(ctx);
    expect(() => rl.before(ctx)).toThrow();
  });

  it('does not refund tokens in absence of after/onError (no refund implemented)', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 2, refillTokensPerSecond: 0, clock });
    const ctx = opCtx();
    rl.before(ctx);
    expect(rl.peekTokens(ctx)).toBe(1);
    // no after()/onError() exist to call; tokens stay consumed
    expect(rl).not.toHaveProperty('after');
  });

  it('reset() clears buckets', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({ capacity: 1, refillTokensPerSecond: 0, clock });
    const ctx = opCtx();
    rl.before(ctx);
    rl.reset();
    expect(() => rl.before(ctx)).not.toThrow();
  });

  it('custom messageFn is used in the thrown error', () => {
    const clock = new ManualClock(0);
    const rl = new RateLimitMiddleware({
      capacity: 1,
      refillTokensPerSecond: 0,
      clock,
      messageFn: (key) => `nope:${key}`,
    });
    const ctx = opCtx({ actorId: 'u', operation: 'approve' });
    rl.before(ctx);
    expect(() => rl.before(ctx)).toThrow('nope:u:approve');
  });

  it('defaultRateLimitKeyFn uses <anonymous> when actorId is absent', () => {
    expect(defaultRateLimitKeyFn(opCtx({ actorId: undefined, operation: 'submit' }))).toBe('<anonymous>:submit');
  });
});

describe('LoggingMiddleware', () => {
  it('logs before/after with base fields and a clock-measured duration', () => {
    const clock = new ManualClock(1000);
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ clock, logger });
    const ctx = opCtx();
    mw.before(ctx);
    clock.advance(42);
    mw.after(ctx, undefined);
    expect(logger.info).toHaveBeenCalledTimes(2);
    const startCall = logger.info.mock.calls[0]!;
    expect(startCall[0]).toBe('operation.start');
    expect(startCall[1]).toMatchObject({ operation: 'approve', actorId: 'user-1', tenantId: 'tenant-1', instanceId: 'inst-1' });
    const afterCall = logger.info.mock.calls[1]!;
    expect(afterCall[1]).toMatchObject({ durationMs: 42 });
  });

  it('onError logs error code+name, a duration, and does NOT suppress (returns normally)', () => {
    const clock = new ManualClock(0);
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ clock, logger });
    const ctx = opCtx();
    mw.before(ctx);
    clock.advance(5);
    const err = new ApprovalForbiddenError('denied');
    expect(mw.onError(ctx, err)).toBeUndefined(); // returns normally => engine rethrows
    expect(logger.error).toHaveBeenCalledOnce();
    const call = logger.error.mock.calls[0]!;
    expect(call[0]).toBe('operation.error');
    expect(call[1]).toBe(err);
    expect(call[2]).toMatchObject({ durationMs: 5, errorCode: 'FORBIDDEN', errorName: 'ApprovalForbiddenError' });
  });

  it('missing start yields durationMs null (never NaN)', () => {
    const clock = new ManualClock(0);
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ clock, logger });
    const ctx = opCtx();
    // onError without a preceding before()
    mw.onError(ctx, new ApprovalForbiddenError('x'));
    expect(logger.error.mock.calls[0]![2]).toMatchObject({ durationMs: null });
  });

  it('overlapping concurrent ops under the same key pair LIFO without cross-attribution', () => {
    const clock = new ManualClock(0);
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ clock, logger });
    // No instanceId so both correlate by operation 'submit'.
    const ctx = opCtx({ operation: 'submit', instanceId: undefined });
    mw.before(ctx); // start @ 0
    clock.advance(10);
    mw.before(ctx); // start @ 10
    clock.advance(5); // now 15
    mw.after(ctx, undefined); // pops the @15-10=5 start (LIFO)
    clock.advance(100); // now 115
    mw.after(ctx, undefined); // pops the @0 -> 115
    const durations = logger.info.mock.calls.filter((c) => c[0] === 'operation.success').map((c) => c[1]!.durationMs);
    expect(durations).toEqual([5, 115]);
  });

  it('correlation key defaults to instanceId ?? operation', () => {
    expect(defaultLoggingCorrelationKeyFn(opCtx({ instanceId: 'abc' }))).toBe('abc');
    expect(defaultLoggingCorrelationKeyFn(opCtx({ instanceId: undefined, operation: 'submit' }))).toBe('submit');
  });

  it('negative measured elapsed is clamped to 0 (backwards clock)', () => {
    const clock = new ManualClock(1000);
    const logger = spyLogger();
    const mw = new LoggingMiddleware({ clock, logger });
    const ctx = opCtx();
    mw.before(ctx);
    clock.set(0);
    mw.after(ctx, undefined);
    expect(logger.info.mock.calls[1]![1]!.durationMs).toBe(0);
  });
});

describe('RbacAuthorizationPolicy', () => {
  it('allows when actor has a required role (match any)', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['approver'] } },
      roleProvider: () => ['approver'],
    });
    expect(await policy.authorize(authCtx())).toBeUndefined();
  });

  it('denies with a non-empty message when actor lacks the role', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['approver'] } },
      roleProvider: () => ['viewer'],
    });
    const msg = await policy.authorize(authCtx());
    expect(typeof msg).toBe('string');
    expect((msg as string).length).toBeGreaterThan(0);
  });

  it('match:all requires every role', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['a', 'b'], match: 'all' } },
      roleProvider: () => ['a'],
    });
    expect(await policy.authorize(authCtx())).toBeDefined();
    const policy2 = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['a', 'b'], match: 'all' } },
      roleProvider: () => ['a', 'b', 'c'],
    });
    expect(await policy2.authorize(authCtx())).toBeUndefined();
  });

  it('allow-all bypasses the role check', async () => {
    const provider = vi.fn(() => [] as string[]);
    const policy = new RbacAuthorizationPolicy({ rules: { approve: 'allow-all' }, roleProvider: provider });
    expect(await policy.authorize(authCtx())).toBeUndefined();
    expect(provider).not.toHaveBeenCalled();
  });

  it('empty roles: match:all allows vacuously, match:any denies', async () => {
    const all = new RbacAuthorizationPolicy({
      rules: { approve: { roles: [], match: 'all' } },
      roleProvider: () => [],
    });
    expect(await all.authorize(authCtx())).toBeUndefined();
    const any = new RbacAuthorizationPolicy({
      rules: { approve: { roles: [], match: 'any' } },
      roleProvider: () => [],
    });
    expect(await any.authorize(authCtx())).toBeDefined();
  });

  it('default-deny: unconfigured operation is denied with a clear message', async () => {
    const policy = new RbacAuthorizationPolicy({ rules: {}, roleProvider: () => [] });
    const msg = await policy.authorize(authCtx({ operation: 'reassign' }));
    expect(msg).toContain('reassign');
    expect(msg).toContain('default-deny');
  });

  it('default-allow: unconfigured operation is permitted', async () => {
    const policy = new RbacAuthorizationPolicy({ rules: {}, defaultMode: 'allow', roleProvider: () => [] });
    expect(await policy.authorize(authCtx({ operation: 'submit' }))).toBeUndefined();
  });

  it('async roleProvider is supported', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['approver'] } },
      roleProvider: async () => ['approver'],
    });
    expect(await policy.authorize(authCtx())).toBeUndefined();
  });

  it('fail-closed: roleProvider that throws denies and logs (no uncaught rejection)', async () => {
    const logger = spyLogger();
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['approver'] } },
      roleProvider: () => {
        throw new Error('provider down');
      },
      logger,
    });
    const msg = await policy.authorize(authCtx());
    expect(msg).toContain('unable to resolve actor roles');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('fail-closed: roleProvider that rejects denies and logs', async () => {
    const logger = spyLogger();
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['approver'] } },
      roleProvider: async () => {
        throw new Error('async down');
      },
      logger,
    });
    await expect(policy.authorize(authCtx())).resolves.toContain('unable to resolve actor roles');
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('resolves tenantId from ctx.instance.tenantId by default', async () => {
    const provider = vi.fn(() => ['approver'] as string[]);
    const policy = new RbacAuthorizationPolicy({ rules: { approve: { roles: ['approver'] } }, roleProvider: provider });
    await policy.authorize(authCtx({ actorId: 'bob', instance: makeInstance({ tenantId: 'T9' }) }));
    expect(provider).toHaveBeenCalledWith('bob', 'T9');
  });

  it('custom tenantIdFn is honored', async () => {
    const provider = vi.fn(() => ['approver'] as string[]);
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['approver'] } },
      tenantIdFn: () => 'CUSTOM',
      roleProvider: provider,
    });
    await policy.authorize(authCtx());
    expect(provider).toHaveBeenCalledWith('user-1', 'CUSTOM');
  });

  it('handles all operation discriminants including submit/reassign', async () => {
    const ops: AuthorizationContext['operation'][] = [
      'submit', 'approve', 'reject', 'delegate', 'reassign', 'cancel', 'escalate', 'override', 'resubmit', 'addComment',
    ];
    const policy = new RbacAuthorizationPolicy({ rules: {}, defaultMode: 'allow', roleProvider: () => [] });
    for (const operation of ops) {
      await expect(policy.authorize(authCtx({ operation }))).resolves.toBeUndefined();
    }
  });

  it('duplicate roles from the provider do not break matching', async () => {
    const policy = new RbacAuthorizationPolicy({
      rules: { approve: { roles: ['approver'] } },
      roleProvider: () => ['approver', 'approver', 'approver'],
    });
    expect(await policy.authorize(authCtx())).toBeUndefined();
  });
});

describe('CompositeAuthorizationPolicy', () => {
  const allow: IAuthorizationPolicy = { authorize: () => undefined };
  const deny = (m: string): IAuthorizationPolicy => ({ authorize: () => m });
  const throwForbidden = (m: string): IAuthorizationPolicy => ({
    authorize: () => {
      throw new ApprovalForbiddenError(m);
    },
  });

  it('AND: all allow -> allow', async () => {
    const c = new CompositeAuthorizationPolicy({ mode: 'and', policies: [allow, allow] });
    expect(await c.authorize(authCtx())).toBeUndefined();
  });

  it('AND: first denial wins and short-circuits', async () => {
    const second = { authorize: vi.fn(() => undefined) };
    const c = new CompositeAuthorizationPolicy({ mode: 'and', policies: [deny('first'), second] });
    expect(await c.authorize(authCtx())).toBe('first');
    expect(second.authorize).not.toHaveBeenCalled();
  });

  it('AND with empty set allows (vacuous)', async () => {
    const c = new CompositeAuthorizationPolicy({ mode: 'and', policies: [] });
    expect(await c.authorize(authCtx())).toBeUndefined();
  });

  it('OR: allow if any allows', async () => {
    const c = new CompositeAuthorizationPolicy({ mode: 'or', policies: [deny('no'), allow] });
    expect(await c.authorize(authCtx())).toBeUndefined();
  });

  it('OR: all deny -> returns last denial', async () => {
    const c = new CompositeAuthorizationPolicy({ mode: 'or', policies: [deny('a'), deny('b')] });
    expect(await c.authorize(authCtx())).toBe('b');
  });

  it('OR with empty set denies (vacuous)', async () => {
    const c = new CompositeAuthorizationPolicy({ mode: 'or', policies: [] });
    expect(await c.authorize(authCtx())).toContain('vacuously closed');
  });

  it('a child throwing ApprovalForbiddenError is treated as a denial (OR continues to find an allow)', async () => {
    const c = new CompositeAuthorizationPolicy({ mode: 'or', policies: [throwForbidden('blocked'), allow] });
    expect(await c.authorize(authCtx())).toBeUndefined();
  });

  it('a child throwing ApprovalForbiddenError under AND short-circuits with its message', async () => {
    const c = new CompositeAuthorizationPolicy({ mode: 'and', policies: [throwForbidden('blocked'), allow] });
    expect(await c.authorize(authCtx())).toBe('blocked');
  });

  it('empty-string return is treated as allow', async () => {
    const emptyDeny: IAuthorizationPolicy = { authorize: () => '' };
    const c = new CompositeAuthorizationPolicy({ mode: 'and', policies: [emptyDeny] });
    expect(await c.authorize(authCtx())).toBeUndefined();
  });

  it('non-Forbidden errors propagate', async () => {
    const boom: IAuthorizationPolicy = {
      authorize: () => {
        throw new ApprovalError('weird', 'VALIDATION');
      },
    };
    const c = new CompositeAuthorizationPolicy({ mode: 'and', policies: [boom] });
    await expect(c.authorize(authCtx())).rejects.toBeInstanceOf(ApprovalError);
  });

  it('evaluates in deterministic array order (OR returns last denial in order)', async () => {
    const c = new CompositeAuthorizationPolicy({ mode: 'or', policies: [deny('1'), deny('2'), deny('3')] });
    expect(await c.authorize(authCtx())).toBe('3');
  });
});
