import type { IOperationMiddleware, OperationContext } from '../../engine/IOperationMiddleware.js';
import type { ApprovalInstance } from '../../types/index.js';
import type { ApprovalError } from '../../errors.js';
import type { SpanAttributeValue, TraceSpan, Tracer } from './ITracer.js';
import { noopTracer, SpanStatusCode } from './ITracer.js';

const DEFAULT_SPAN_NAME_PREFIX = 'approval.';
const DEFAULT_ATTRIBUTE_NAMESPACE = 'approval';

/**
 * Derives the in-flight correlation key used to match a `before` span with its
 * `after`/`onError`. Defaults to `instanceId ?? operation`.
 */
export type TracingCorrelationKeyFn = (ctx: OperationContext) => string;

/** Default correlation key: `instanceId ?? operation`. */
export function defaultTracingCorrelationKeyFn(ctx: OperationContext): string {
  return ctx.instanceId ?? ctx.operation;
}

/**
 * Configuration for {@link TracingMiddleware}.
 */
export interface TracingMiddlewareOptions {
  /**
   * Injected tracer. Defaults to {@link noopTracer}. A real OpenTelemetry
   * `Tracer` is structurally compatible and may be passed directly.
   */
  tracer?: Tracer;
  /** Prefix for span names. Span name is `${prefix}${operation}`. Defaults to `'approval.'`. */
  spanNamePrefix?: string;
  /**
   * Namespace prefixing every attribute key (e.g. `approval.tenant_id`).
   * Defaults to `'approval'`.
   */
  attributeNamespace?: string;
  /**
   * Correlation key fn used to pair `before` with `after`/`onError`. Defaults to
   * {@link defaultTracingCorrelationKeyFn} (`instanceId ?? operation`).
   *
   * Operations without an `instanceId` (e.g. `submit`) are correlated by
   * operation name. Overlapping operations that share a key are tracked as a
   * per-key stack so spans are paired LIFO and never cross-attributed.
   */
  correlationKeyFn?: TracingCorrelationKeyFn;
}

/**
 * Distributed-tracing instrumentation implemented as an
 * {@link IOperationMiddleware}. Wraps every engine operation
 * (`submit`, `approve`, `reject`, …) in a span.
 *
 * On `before` it starts a span named `${spanNamePrefix}${operation}` with
 * `operation`, `tenant_id`, `actor_id` and `instance_id` attributes, and pushes
 * it onto a per-correlation-key stack. On `after` it records the resulting
 * instance's status/level, sets status `OK`, and ends the span. On `onError` it
 * calls `recordException`, tags `error_code`, sets status `ERROR`, ends the span,
 * and does NOT suppress the error (the engine rethrows).
 *
 * Because middleware cannot wrap a callback around the engine call, spans are
 * created with `startSpan` and ended manually rather than via `startActiveSpan`;
 * consequently they are not installed as the active context, so downstream spans
 * (e.g. inside a storage adapter) are not auto-parented. Correlate via the
 * emitted attributes if you need the linkage.
 *
 * Concurrency: spans are kept in a per-correlation-key stack, so overlapping
 * operations sharing a key (e.g. multiple `submit`s with no `instanceId`) are
 * paired LIFO. If `before` never ran for a key (e.g. an error raised before
 * `before`), `after`/`onError` become no-ops instead of ending a foreign span.
 */
export class TracingMiddleware implements IOperationMiddleware {
  private readonly tracer: Tracer;
  private readonly spanNamePrefix: string;
  private readonly attributeNamespace: string;
  private readonly correlationKeyFn: TracingCorrelationKeyFn;
  /** Per-key stack of open spans supporting overlapping concurrent ops. */
  private readonly inFlight = new Map<string, TraceSpan[]>();

  constructor(options: TracingMiddlewareOptions = {}) {
    this.tracer = options.tracer ?? noopTracer;
    this.spanNamePrefix = options.spanNamePrefix ?? DEFAULT_SPAN_NAME_PREFIX;
    this.attributeNamespace = options.attributeNamespace ?? DEFAULT_ATTRIBUTE_NAMESPACE;
    this.correlationKeyFn = options.correlationKeyFn ?? defaultTracingCorrelationKeyFn;
  }

  before(ctx: OperationContext): void {
    const span = this.tracer.startSpan(`${this.spanNamePrefix}${ctx.operation}`, {
      attributes: this.baseAttributes(ctx),
    });
    const key = this.correlationKeyFn(ctx);
    const stack = this.inFlight.get(key);
    if (stack === undefined) {
      this.inFlight.set(key, [span]);
    } else {
      stack.push(span);
    }
  }

  after(ctx: OperationContext, result: ApprovalInstance | void): void {
    const span = this.consumeSpan(ctx);
    if (span === undefined) {
      return;
    }
    if (result !== undefined && result !== null) {
      span.setAttribute(this.attr('result_status'), result.status);
      span.setAttribute(this.attr('result_level'), result.currentLevel);
    }
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }

  onError(ctx: OperationContext, error: ApprovalError): void {
    const span = this.consumeSpan(ctx);
    if (span === undefined) {
      return;
    }
    span.recordException(error);
    span.setAttribute(this.attr('error_code'), error.code);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
    span.end();
    // Intentionally does not suppress: returning normally lets the engine rethrow.
  }

  /** Namespaced attribute key, e.g. `approval.tenant_id`. */
  private attr(suffix: string): string {
    return `${this.attributeNamespace}.${suffix}`;
  }

  /** Build the creation-time attributes, omitting keys whose value is undefined. */
  private baseAttributes(ctx: OperationContext): Record<string, SpanAttributeValue> {
    const attributes: Record<string, SpanAttributeValue> = {
      [this.attr('operation')]: ctx.operation,
      [this.attr('tenant_id')]: ctx.tenantId,
    };
    if (ctx.actorId !== undefined) {
      attributes[this.attr('actor_id')] = ctx.actorId;
    }
    if (ctx.instanceId !== undefined) {
      attributes[this.attr('instance_id')] = ctx.instanceId;
    }
    return attributes;
  }

  /**
   * Pop the most recent open span for this key. Returns `undefined` when no
   * matching span exists (e.g. `before` never ran for this correlation key).
   */
  private consumeSpan(ctx: OperationContext): TraceSpan | undefined {
    const key = this.correlationKeyFn(ctx);
    const stack = this.inFlight.get(key);
    if (stack === undefined || stack.length === 0) {
      return undefined;
    }
    const span = stack.pop();
    if (stack.length === 0) {
      this.inFlight.delete(key);
    }
    return span;
  }
}
