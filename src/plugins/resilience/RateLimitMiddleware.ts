import type { IOperationMiddleware, OperationContext } from '../../engine/IOperationMiddleware.js';
import type { Clock } from '../../utils/Clock.js';
import { systemClock } from '../../utils/Clock.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import { ApprovalForbiddenError } from '../../errors.js';

/**
 * Derives the bucket key for an operation. Requests sharing a key share a bucket.
 *
 * NOTE: A key fn that returns the same key for different actors deliberately
 * collapses them into a single shared bucket. The default key isolates by
 * `actorId + operation`, so one actor/operation can never starve another.
 */
export type RateLimitKeyFn = (ctx: OperationContext) => string;

/**
 * Configuration for {@link RateLimitMiddleware}.
 */
export interface RateLimitOptions {
  /**
   * Maximum number of tokens a bucket can hold (the burst size). A bucket
   * starts full at `capacity` and never exceeds it on refill.
   */
  capacity: number;
  /**
   * Sustained refill rate in tokens per second. Refill is computed solely from
   * the injected {@link Clock}; advancing the clock by `1 / refillTokensPerSecond`
   * seconds restores exactly one token (fractional accrual is tracked and floored
   * at consume time).
   */
  refillTokensPerSecond: number;
  /**
   * Maps an {@link OperationContext} to a bucket key. Defaults to
   * `${actorId}:${operation}` (with a stable fallback when `actorId` is absent),
   * isolating each actor/operation pair into its own bucket.
   */
  keyFn?: RateLimitKeyFn;
  /**
   * Number of tokens a single request consumes. Defaults to `1`.
   */
  costPerRequest?: number;
  /**
   * Builds the {@link ApprovalForbiddenError} message thrown on exhaustion.
   * Receives the resolved bucket key and the operation context.
   */
  messageFn?: (key: string, ctx: OperationContext) => string;
  /** Injected clock for deterministic refill. Defaults to {@link systemClock}. */
  clock?: Clock;
  /** Injected logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
}

interface Bucket {
  /** Current whole+fractional token balance, in [0, capacity]. */
  tokens: number;
  /** Epoch millis of the last refill computation, per the injected clock. */
  lastRefillMs: number;
}

/**
 * Default bucket key: isolates each `actorId + operation` pair. When `actorId`
 * is absent (e.g. system-initiated ops) it falls back to a stable anonymous
 * marker so such requests still share a coherent per-operation bucket.
 */
export function defaultRateLimitKeyFn(ctx: OperationContext): string {
  return `${ctx.actorId ?? '<anonymous>'}:${ctx.operation}`;
}

/**
 * Token-bucket rate limiter implemented as an {@link IOperationMiddleware}.
 *
 * Tokens are consumed in {@link RateLimitMiddleware.before} — i.e. after the
 * engine has performed authorization and input validation but before any state
 * mutation, per the middleware contract. On exhaustion `before` throws an
 * {@link ApprovalForbiddenError} (code `FORBIDDEN`, HTTP 403).
 *
 * Refill is driven exclusively by the injected {@link Clock}: the number of
 * tokens accrued since the last touch is `elapsedSeconds * refillTokensPerSecond`,
 * clamped so the balance never exceeds `capacity`. No `Date.now()` or real timers
 * are used, so a `ManualClock` makes refill fully reproducible. A clock that
 * appears to move backwards is clamped to zero elapsed time (never negative).
 *
 * `after()`/`onError()` are intentionally not implemented: consumed tokens are
 * NOT refunded on success or failure. Buckets are keyed independently via the
 * configurable key fn so distinct actor/operation pairs cannot starve each other.
 */
export class RateLimitMiddleware implements IOperationMiddleware {
  private readonly capacity: number;
  private readonly refillTokensPerSecond: number;
  private readonly keyFn: RateLimitKeyFn;
  private readonly costPerRequest: number;
  private readonly messageFn: (key: string, ctx: OperationContext) => string;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly buckets = new Map<string, Bucket>();

  constructor(options: RateLimitOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new Error('RateLimitMiddleware: capacity must be a positive finite number.');
    }
    if (!Number.isFinite(options.refillTokensPerSecond) || options.refillTokensPerSecond < 0) {
      throw new Error('RateLimitMiddleware: refillTokensPerSecond must be a non-negative finite number.');
    }
    const cost = options.costPerRequest ?? 1;
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new Error('RateLimitMiddleware: costPerRequest must be a positive finite number.');
    }
    if (cost > options.capacity) {
      throw new Error('RateLimitMiddleware: costPerRequest cannot exceed capacity (request could never succeed).');
    }
    this.capacity = options.capacity;
    this.refillTokensPerSecond = options.refillTokensPerSecond;
    this.keyFn = options.keyFn ?? defaultRateLimitKeyFn;
    this.costPerRequest = cost;
    this.messageFn =
      options.messageFn ??
      ((key) => `Rate limit exceeded for "${key}". Please retry later.`);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Consume one request's cost from the relevant bucket. Throws
   * {@link ApprovalForbiddenError} when insufficient tokens remain.
   *
   * Edge case: the request that brings a bucket exactly to zero succeeds; the
   * next request (before any refill) is rejected.
   */
  before(ctx: OperationContext): void {
    const key = this.keyFn(ctx);
    const nowMs = this.clock.now().getTime();
    const bucket = this.refill(key, nowMs);

    if (bucket.tokens >= this.costPerRequest) {
      bucket.tokens -= this.costPerRequest;
      return;
    }

    const message = this.messageFn(key, ctx);
    this.logger.warn('RateLimitMiddleware: request rejected', {
      key,
      operation: ctx.operation,
      actorId: ctx.actorId,
      tenantId: ctx.tenantId,
      instanceId: ctx.instanceId,
      tokensRemaining: bucket.tokens,
      costPerRequest: this.costPerRequest,
    });
    throw new ApprovalForbiddenError(message);
  }

  /**
   * Returns the current (refilled) token balance for the bucket a context maps
   * to, without consuming. Primarily for tests/observability.
   */
  peekTokens(ctx: OperationContext): number {
    const key = this.keyFn(ctx);
    const bucket = this.buckets.get(key);
    // No bucket yet: a fresh bucket would start full at capacity. Do NOT create one.
    if (bucket === undefined) return this.capacity;

    // Compute the projected balance from a read-only snapshot without mutating
    // or persisting anything back into the stored bucket.
    const nowMs = this.clock.now().getTime();
    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    const accrued = (elapsedMs / 1000) * this.refillTokensPerSecond;
    return Math.min(this.capacity, bucket.tokens + accrued);
  }

  /** Clears all buckets (e.g. for test isolation or manual reset). */
  reset(): void {
    this.buckets.clear();
  }

  /**
   * Lazily create the bucket (starting full) and accrue tokens for the elapsed
   * time since its last touch, clamped to `capacity`. Backwards clock movement
   * yields zero elapsed time.
   */
  private refill(key: string, nowMs: number): Bucket {
    let bucket = this.buckets.get(key);
    if (bucket === undefined) {
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(key, bucket);
      return bucket;
    }

    const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
    if (elapsedMs > 0) {
      const accrued = (elapsedMs / 1000) * this.refillTokensPerSecond;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + accrued);
      bucket.lastRefillMs = nowMs;
    }
    return bucket;
  }
}
