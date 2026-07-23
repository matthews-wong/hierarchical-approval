/**
 * Minimal, dependency-free tracing port modeled on the OpenTelemetry
 * `@opentelemetry/api` `Tracer`/`Span` shapes.
 *
 * A real OpenTelemetry `Tracer` (from `trace.getTracer('...')`) is structurally
 * assignable to {@link Tracer}, so callers may pass it directly. This library
 * never imports `@opentelemetry/api`, keeping OpenTelemetry a soft
 * (bring-your-own) dependency: install and wire it if you want traces, or use
 * the {@link noopTracer} default and pay nothing.
 */

/** Attribute values permitted on a span. Matches the OTel primitive subset. */
export type SpanAttributeValue = string | number | boolean;

/**
 * Span status codes. Numerically identical to OpenTelemetry's `SpanStatusCode`
 * (`UNSET = 0`, `OK = 1`, `ERROR = 2`) so a status set here maps onto a real
 * OTel backend without translation.
 */
export const SpanStatusCode = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;
export type SpanStatusCode = (typeof SpanStatusCode)[keyof typeof SpanStatusCode];

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface SpanOptions {
  /** Attributes attached at span creation. */
  attributes?: Record<string, SpanAttributeValue>;
}

/**
 * The subset of the OpenTelemetry `Span` surface this plug-in uses. Return types
 * are `unknown` so that both fluent (`this`-returning, like OTel) and
 * void-returning implementations satisfy the contract.
 */
export interface TraceSpan {
  setAttribute(key: string, value: SpanAttributeValue): unknown;
  setStatus(status: SpanStatus): unknown;
  recordException(exception: Error): unknown;
  end(): void;
}

/** The subset of the OpenTelemetry `Tracer` surface this plug-in uses. */
export interface Tracer {
  startSpan(name: string, options?: SpanOptions): TraceSpan;
}

/** A span that records nothing. Shared singleton — safe because it holds no state. */
const NOOP_SPAN: TraceSpan = {
  setAttribute(): TraceSpan {
    return NOOP_SPAN;
  },
  setStatus(): TraceSpan {
    return NOOP_SPAN;
  },
  recordException(): void {},
  end(): void {},
};

/**
 * A tracer that produces no telemetry. The default for {@link TracingMiddleware}
 * so that adding the middleware without wiring a backend is a no-op.
 */
export const noopTracer: Tracer = {
  startSpan(): TraceSpan {
    return NOOP_SPAN;
  },
};
