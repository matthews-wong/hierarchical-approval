import type { IOperationMiddleware, OperationContext } from '../../engine/IOperationMiddleware.js';
import type { ApprovalInstance } from '../../types/index.js';
import type { ApprovalError } from '../../errors.js';
import type { Clock } from '../../utils/Clock.js';
import { systemClock } from '../../utils/Clock.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';

/**
 * Derives the in-flight correlation key used to match a `before` start time with
 * its `after`/`onError`. Defaults to `instanceId ?? operation`.
 */
export type LoggingCorrelationKeyFn = (ctx: OperationContext) => string;

/**
 * Configuration for {@link LoggingMiddleware}.
 */
export interface LoggingMiddlewareOptions {
  /** Injected logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
  /** Injected clock used to measure durations. Defaults to {@link systemClock}. */
  clock?: Clock;
  /**
   * Correlation key fn used to pair `before` with `after`/`onError` for duration
   * measurement. Defaults to {@link defaultLoggingCorrelationKeyFn}
   * (`instanceId ?? operation`).
   *
   * Operations without an `instanceId` (e.g. `submit`) are correlated by
   * operation name. If two such operations overlap concurrently under the same
   * key, the middleware tracks a per-key stack of start times so durations are
   * not cross-attributed (LIFO pairing).
   */
  correlationKeyFn?: LoggingCorrelationKeyFn;
  /** Message used for the `before` log line. Defaults to `'operation.start'`. */
  startMessage?: string;
  /** Message used for the `after` log line. Defaults to `'operation.success'`. */
  successMessage?: string;
  /** Message used for the `onError` log line. Defaults to `'operation.error'`. */
  errorMessage?: string;
}

/** Default correlation key: `instanceId ?? operation`. */
export function defaultLoggingCorrelationKeyFn(ctx: OperationContext): string {
  return ctx.instanceId ?? ctx.operation;
}

/**
 * Structured before/after/onError logging implemented as an
 * {@link IOperationMiddleware}.
 *
 * On `before` it logs `operation`, `actorId`, `tenantId`, `instanceId` and
 * records a start timestamp from the injected {@link Clock}. On `after`/`onError`
 * it logs the same fields plus a `durationMs` measured against the matching
 * start. `onError` additionally logs the {@link ApprovalError} `code` and does
 * NOT suppress the error (it returns normally, leaving the engine to rethrow).
 *
 * Concurrency: start times are kept in a per-correlation-key stack so overlapping
 * operations that share a key (e.g. multiple `submit`s with no `instanceId`) are
 * paired LIFO and never cross-attribute durations. If `before` never ran for a
 * given key (e.g. an error raised before `before`), `durationMs` is reported as
 * `null` rather than `NaN`.
 */
export class LoggingMiddleware implements IOperationMiddleware {
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly correlationKeyFn: LoggingCorrelationKeyFn;
  private readonly startMessage: string;
  private readonly successMessage: string;
  private readonly errorMessage: string;
  /** Per-key stack of start times (ms) supporting overlapping concurrent ops. */
  private readonly inFlight = new Map<string, number[]>();

  constructor(options: LoggingMiddlewareOptions = {}) {
    this.logger = options.logger ?? noopLogger;
    this.clock = options.clock ?? systemClock;
    this.correlationKeyFn = options.correlationKeyFn ?? defaultLoggingCorrelationKeyFn;
    this.startMessage = options.startMessage ?? 'operation.start';
    this.successMessage = options.successMessage ?? 'operation.success';
    this.errorMessage = options.errorMessage ?? 'operation.error';
  }

  before(ctx: OperationContext): void {
    const key = this.correlationKeyFn(ctx);
    const startMs = this.clock.now().getTime();
    const stack = this.inFlight.get(key);
    if (stack === undefined) {
      this.inFlight.set(key, [startMs]);
    } else {
      stack.push(startMs);
    }
    this.logger.info(this.startMessage, this.baseFields(ctx));
  }

  after(ctx: OperationContext, _result: ApprovalInstance | void): void {
    const durationMs = this.consumeDuration(ctx);
    this.logger.info(this.successMessage, {
      ...this.baseFields(ctx),
      durationMs,
    });
  }

  onError(ctx: OperationContext, error: ApprovalError): void {
    const durationMs = this.consumeDuration(ctx);
    this.logger.error(this.errorMessage, error, {
      ...this.baseFields(ctx),
      durationMs,
      errorCode: error.code,
      errorName: error.name,
    });
    // Intentionally does not suppress: returning normally lets the engine rethrow.
  }

  private baseFields(ctx: OperationContext): Record<string, unknown> {
    return {
      operation: ctx.operation,
      actorId: ctx.actorId,
      tenantId: ctx.tenantId,
      instanceId: ctx.instanceId,
    };
  }

  /**
   * Pop the most recent start time for this key and compute elapsed ms. Returns
   * `null` (never `NaN`) when no matching start exists.
   */
  private consumeDuration(ctx: OperationContext): number | null {
    const key = this.correlationKeyFn(ctx);
    const stack = this.inFlight.get(key);
    if (stack === undefined || stack.length === 0) {
      return null;
    }
    const startMs = stack.pop() as number;
    if (stack.length === 0) {
      this.inFlight.delete(key);
    }
    const elapsed = this.clock.now().getTime() - startMs;
    return Math.max(0, elapsed);
  }
}
