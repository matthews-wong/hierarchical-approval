import { describe, it, expect } from 'vitest';
import {
  TracingMiddleware,
  defaultTracingCorrelationKeyFn,
  noopTracer,
  SpanStatusCode,
} from '../../../src/plugins/tracing/index.js';
import type {
  SpanAttributeValue,
  SpanStatus,
  TraceSpan,
  Tracer,
} from '../../../src/plugins/tracing/index.js';
import { ApprovalError, ApprovalConflictError } from '../../../src/errors.js';
import type { OperationContext } from '../../../src/engine/IOperationMiddleware.js';
import { makeInstance } from './_helpers.js';

/** A span that records every call for assertions. */
class RecordingSpan implements TraceSpan {
  readonly attributes: Record<string, SpanAttributeValue> = {};
  status: SpanStatus | undefined;
  readonly exceptions: Error[] = [];
  ended = 0;

  setAttribute(key: string, value: SpanAttributeValue): this {
    this.attributes[key] = value;
    return this;
  }
  setStatus(status: SpanStatus): this {
    this.status = status;
    return this;
  }
  recordException(exception: Error): this {
    this.exceptions.push(exception);
    return this;
  }
  end(): void {
    this.ended += 1;
  }
}

/** A tracer capturing every span it starts, with the name/options it was given. */
class RecordingTracer implements Tracer {
  readonly spans: Array<{
    name: string;
    attributes: Record<string, SpanAttributeValue>;
    span: RecordingSpan;
  }> = [];

  startSpan(
    name: string,
    options?: { attributes?: Record<string, SpanAttributeValue> },
  ): RecordingSpan {
    const span = new RecordingSpan();
    this.spans.push({ name, attributes: { ...(options?.attributes ?? {}) }, span });
    return span;
  }
}

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

describe('TracingMiddleware — span lifecycle', () => {
  it('starts a namespaced span on before with creation attributes', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({ tracer });
    mw.before(opCtx());

    expect(tracer.spans).toHaveLength(1);
    const started = tracer.spans[0];
    expect(started.name).toBe('approval.approve');
    expect(started.attributes).toEqual({
      'approval.operation': 'approve',
      'approval.tenant_id': 'tenant-1',
      'approval.actor_id': 'user-1',
      'approval.instance_id': 'inst-1',
    });
    // Not ended until after/onError.
    expect(started.span.ended).toBe(0);
  });

  it('sets OK status, records result attributes, and ends the span on after', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = opCtx();
    mw.before(ctx);
    mw.after(ctx, makeInstance({ status: 'approved', currentLevel: 2 }));

    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: SpanStatusCode.OK });
    expect(span.attributes['approval.result_status']).toBe('approved');
    expect(span.attributes['approval.result_level']).toBe(2);
    expect(span.ended).toBe(1);
  });

  it('tolerates a void result on after (no result attributes, still OK + ended)', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = opCtx();
    mw.before(ctx);
    mw.after(ctx, undefined);

    const { span } = tracer.spans[0];
    expect(span.status).toEqual({ code: SpanStatusCode.OK });
    expect(span.attributes['approval.result_status']).toBeUndefined();
    expect(span.ended).toBe(1);
  });

  it('records the exception, tags error_code, sets ERROR status, and ends on onError', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = opCtx();
    const err = new ApprovalConflictError('inst-1');
    mw.before(ctx);
    mw.onError(ctx, err);

    const { span } = tracer.spans[0];
    expect(span.exceptions).toEqual([err]);
    expect(span.attributes['approval.error_code']).toBe('CONFLICT');
    expect(span.status).toEqual({ code: SpanStatusCode.ERROR, message: err.message });
    expect(span.ended).toBe(1);
  });

  it('does not suppress the error (onError returns normally)', () => {
    const mw = new TracingMiddleware({ tracer: new RecordingTracer() });
    const ctx = opCtx();
    mw.before(ctx);
    expect(() => mw.onError(ctx, new ApprovalError('boom', 'VALIDATION'))).not.toThrow();
  });
});

describe('TracingMiddleware — creation attributes', () => {
  it('omits actor_id and instance_id when absent (e.g. submit)', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({ tracer });
    mw.before(opCtx({ operation: 'submit', instanceId: undefined, actorId: undefined }));

    expect(tracer.spans[0].name).toBe('approval.submit');
    expect(tracer.spans[0].attributes).toEqual({
      'approval.operation': 'submit',
      'approval.tenant_id': 'tenant-1',
    });
  });
});

describe('TracingMiddleware — concurrency', () => {
  it('pairs overlapping same-key spans LIFO without cross-attribution', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({ tracer });
    // Two concurrent submits with no instanceId share the key 'submit'.
    const ctx = opCtx({ operation: 'submit', instanceId: undefined });
    mw.before(ctx); // span A
    mw.before(ctx); // span B
    const [{ span: spanA }, { span: spanB }] = tracer.spans;

    mw.after(ctx, undefined); // ends most-recent -> B
    expect(spanB.ended).toBe(1);
    expect(spanA.ended).toBe(0);

    mw.onError(ctx, new ApprovalError('x', 'VALIDATION')); // ends A
    expect(spanA.ended).toBe(1);
    expect(spanA.status?.code).toBe(SpanStatusCode.ERROR);
  });

  it('after/onError are no-ops when before never ran for the key', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({ tracer });
    const ctx = opCtx();
    // No before() call.
    expect(() => mw.after(ctx, makeInstance())).not.toThrow();
    expect(() => mw.onError(ctx, new ApprovalError('x', 'VALIDATION'))).not.toThrow();
    expect(tracer.spans).toHaveLength(0);
  });
});

describe('TracingMiddleware — configuration', () => {
  it('honors custom spanNamePrefix and attributeNamespace', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({
      tracer,
      spanNamePrefix: 'wf/',
      attributeNamespace: 'wf',
    });
    mw.before(opCtx({ operation: 'reject' }));

    expect(tracer.spans[0].name).toBe('wf/reject');
    expect(tracer.spans[0].attributes['wf.operation']).toBe('reject');
    expect(tracer.spans[0].attributes['wf.tenant_id']).toBe('tenant-1');
  });

  it('honors a custom correlationKeyFn', () => {
    const tracer = new RecordingTracer();
    const mw = new TracingMiddleware({ tracer, correlationKeyFn: (c) => c.tenantId });
    const ctx = opCtx();
    mw.before(ctx);
    mw.after(ctx, makeInstance());
    expect(tracer.spans[0].span.ended).toBe(1);
  });

  it('defaults to the noopTracer and never throws with no tracer wired', () => {
    const mw = new TracingMiddleware();
    const ctx = opCtx();
    expect(() => {
      mw.before(ctx);
      mw.after(ctx, makeInstance());
      mw.onError(ctx, new ApprovalError('x', 'VALIDATION'));
    }).not.toThrow();
  });
});

describe('tracing exports', () => {
  it('defaultTracingCorrelationKeyFn returns instanceId ?? operation', () => {
    expect(defaultTracingCorrelationKeyFn(opCtx())).toBe('inst-1');
    expect(
      defaultTracingCorrelationKeyFn(opCtx({ instanceId: undefined, operation: 'submit' })),
    ).toBe('submit');
  });

  it('noopTracer produces a fully inert span', () => {
    const span = noopTracer.startSpan('x');
    expect(() => {
      span.setAttribute('a', 1);
      span.setStatus({ code: SpanStatusCode.OK });
      span.recordException(new Error('e'));
      span.end();
    }).not.toThrow();
  });

  it('SpanStatusCode matches OpenTelemetry numeric values', () => {
    expect(SpanStatusCode.UNSET).toBe(0);
    expect(SpanStatusCode.OK).toBe(1);
    expect(SpanStatusCode.ERROR).toBe(2);
  });
});
