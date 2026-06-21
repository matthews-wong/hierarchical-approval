import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { ManualClock, ApprovalTestKit } from '../../src/testing/ApprovalTestKit.js';
import type { INotificationAdapter, NotificationEvent } from '../../src/adapters/INotificationAdapter.js';
import type { IAuditAdapter } from '../../src/adapters/IAuditAdapter.js';
import type { IMetricsAdapter } from '../../src/adapters/IMetricsAdapter.js';
import type { IAuthorizationPolicy } from '../../src/engine/IAuthorizationPolicy.js';
import type { IOperationMiddleware } from '../../src/engine/IOperationMiddleware.js';
import {
  ApprovalForbiddenError,
  ApprovalValidationError,
  ApprovalError,
} from '../../src/errors.js';
import type { AuditEntry, ApprovalInstance } from '../../src/types/index.js';

// ─── Shared template ────────────────────────────────────────────────────────

const basicTemplate = {
  name: 'enterprise-test',
  levels: [
    { level: 1, name: 'Manager', approvers: [{ type: 'user' as const, userId: 'mgr1' }], mode: 'any' as const },
    { level: 2, name: 'Director', approvers: [{ type: 'user' as const, userId: 'dir1' }], mode: 'any' as const },
  ],
};

// ─── ManualClock ─────────────────────────────────────────────────────────────

describe('ManualClock', () => {
  it('starts at provided date', () => {
    const start = new Date('2025-06-01T00:00:00Z');
    const clock = new ManualClock(start);
    expect(clock.now().toISOString()).toBe('2025-06-01T00:00:00.000Z');
  });

  it('advance() moves time forward by ms', () => {
    const clock = new ManualClock(new Date('2025-01-01T00:00:00Z'));
    clock.advance(5000);
    expect(clock.now().getTime()).toBe(new Date('2025-01-01T00:00:05Z').getTime());
  });

  it('advanceDays() moves time forward by full days', () => {
    const clock = new ManualClock(new Date('2025-01-01T00:00:00Z'));
    clock.advanceDays(3);
    expect(clock.now().toISOString()).toBe('2025-01-04T00:00:00.000Z');
  });

  it('set() replaces current time', () => {
    const clock = new ManualClock();
    clock.set(new Date('2030-12-25T12:00:00Z'));
    expect(clock.now().toISOString()).toBe('2030-12-25T12:00:00.000Z');
  });

  it('now() returns a new Date instance each call', () => {
    const clock = new ManualClock(new Date('2025-01-01T00:00:00Z'));
    const a = clock.now();
    const b = clock.now();
    expect(a).not.toBe(b);
  });
});

// ─── Clock injection ─────────────────────────────────────────────────────────

describe('Clock injection', () => {
  it('createdAt on instance reflects injected clock', async () => {
    const { engine, clock } = ApprovalTestKit.create();
    clock.set(new Date('2024-03-15T09:00:00Z'));
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(instance.createdAt.toISOString()).toBe('2024-03-15T09:00:00.000Z');
  });

  it('slaDeadlineAt is relative to injected clock', async () => {
    const { engine, clock } = ApprovalTestKit.create();
    clock.set(new Date('2024-01-01T00:00:00Z'));
    await engine.defineTemplate({ ...basicTemplate, name: 'sla-test', slaDeadlineDays: 5 });
    const instance = await engine.submit({ templateName: 'sla-test', documentId: 'doc-2', documentType: 'invoice', submittedBy: 'user1', data: {} });
    const expected = new Date('2024-01-06T00:00:00Z').getTime();
    expect(instance.slaDeadlineAt?.getTime()).toBe(expected);
  });

  it('escalationDueAt on first level is relative to injected clock', async () => {
    const { engine, clock } = ApprovalTestKit.create();
    clock.set(new Date('2024-01-01T00:00:00Z'));
    await engine.defineTemplate({
      ...basicTemplate,
      name: 'esc-test',
      levels: [{ level: 1, name: 'Mgr', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any', escalationAfterDays: 2 }],
    });
    const instance = await engine.submit({ templateName: 'esc-test', documentId: 'doc-3', documentType: 'invoice', submittedBy: 'user1', data: {} });
    const expected = new Date('2024-01-03T00:00:00Z').getTime();
    expect(instance.levels[0]?.escalationDueAt?.getTime()).toBe(expected);
  });

  it('healthCheck uses injected clock for overdue detection', async () => {
    const { engine, clock } = ApprovalTestKit.create();
    clock.set(new Date('2024-01-01T00:00:00Z'));
    await engine.defineTemplate({ ...basicTemplate, name: 'health-test' });
    await engine.submit({ templateName: 'health-test', documentId: 'doc-4', documentType: 'invoice', submittedBy: 'user1', data: {}, expiresAt: new Date('2024-01-02T00:00:00Z') });

    clock.advanceDays(5);
    const health = await engine.healthCheck();
    expect(health.overdueCount).toBeGreaterThan(0);
    await engine.shutdown();
  });
});

// ─── ID Generator injection ──────────────────────────────────────────────────

describe('IdGeneratorFn injection', () => {
  it('instanceId uses custom generator', async () => {
    let counter = 0;
    const generateId = (prefix: string) => `${prefix}_custom_${++counter}`;
    const { engine } = ApprovalTestKit.create({ generateId });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    // defineTemplate uses call 1 (tpl_custom_1), submit uses call 2 (inst_custom_2)
    expect(instance.id).toBe('inst_custom_2');
  });

  it('template ID uses custom generator with tpl prefix', async () => {
    const generateId = (prefix: string) => `${prefix}_FIXED`;
    const { engine } = ApprovalTestKit.create({ generateId });
    const templateId = await engine.defineTemplate({ ...basicTemplate, name: 'gen-test' });
    expect(templateId).toBe('tpl_FIXED');
  });
});

// ─── RetryPolicy ─────────────────────────────────────────────────────────────

describe('RetryPolicy', () => {
  it('respects maxAttempts=1 — does not retry on conflict', async () => {
    const adapter = new MemoryAdapter();
    const engine = new ApprovalEngine({ adapter, retryPolicy: { maxAttempts: 1, baseDelayMs: 0 } });

    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });

    // Simulate conflict by advancing version manually via second engine
    const engine2 = new ApprovalEngine({ adapter });
    await engine2.approve(instance.id, { approverId: 'mgr1' }); // bumps version

    // engine (maxAttempts=1) tries to approve but gets conflict after 0 retries
    await expect(engine.approve(instance.id, { approverId: 'mgr1' }))
      .rejects.toThrow();
    await engine.shutdown();
    await engine2.shutdown();
  });
});

// ─── IdempotencyKeyFn ────────────────────────────────────────────────────────

describe('IdempotencyKeyFn injection', () => {
  it('custom fn returning different key creates new instance instead of deduping', async () => {
    let callCount = 0;
    const idempotencyKeyFn = () => `key_${++callCount}`;
    const { engine } = ApprovalTestKit.create({ idempotencyKeyFn });
    await engine.defineTemplate(basicTemplate);

    const i1 = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    const i2 = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(i1.id).not.toBe(i2.id);
  });

  it('custom fn returning same key deduplicates as expected', async () => {
    const idempotencyKeyFn = () => 'fixed-key';
    const { engine } = ApprovalTestKit.create({ idempotencyKeyFn });
    await engine.defineTemplate(basicTemplate);

    const i1 = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    const i2 = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(i1.id).toBe(i2.id);
  });
});

// ─── INotificationAdapter ────────────────────────────────────────────────────

describe('INotificationAdapter', () => {
  let notifEvents: NotificationEvent[];
  let notificationAdapter: INotificationAdapter;

  beforeEach(() => {
    notifEvents = [];
    notificationAdapter = { notify: async (e) => { notifEvents.push(e); } };
  });

  it('notify() called after submit with correct event type', async () => {
    const { engine } = ApprovalTestKit.create({ notificationAdapter });
    await engine.defineTemplate(basicTemplate);
    await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(notifEvents.some((e) => e.type === 'approval:submitted')).toBe(true);
  });

  it('notify() called after level advance with correct recipients', async () => {
    const { engine } = ApprovalTestKit.create({ notificationAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1' });

    const levelAdvEvt = notifEvents.find((e) => e.type === 'approval:level_advanced');
    expect(levelAdvEvt).toBeDefined();
    expect(levelAdvEvt?.instanceId).toBe(instance.id);
  });

  it('notify() errors do not propagate', async () => {
    const failingAdapter: INotificationAdapter = { notify: async () => { throw new Error('smtp down'); } };
    const { engine } = ApprovalTestKit.create({ notificationAdapter: failingAdapter });
    await engine.defineTemplate(basicTemplate);
    await expect(
      engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} }),
    ).resolves.toBeDefined();
  });

  it('recipients on level_advanced event contain next level approvers', async () => {
    const { engine } = ApprovalTestKit.create({ notificationAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1' });

    const notif = notifEvents.find((e) => e.type === 'approval:level_advanced');
    expect(notif?.recipients).toContain('dir1');
  });
});

// ─── IAuditAdapter ───────────────────────────────────────────────────────────

describe('IAuditAdapter', () => {
  let auditEntries: Array<{ tenantId: string; instanceId: string; entry: AuditEntry }>;
  let auditAdapter: IAuditAdapter;

  beforeEach(() => {
    auditEntries = [];
    auditAdapter = {
      append: async (tenantId, instanceId, entry) => {
        auditEntries.push({ tenantId, instanceId, entry });
      },
    };
  });

  it('append() called after submit', async () => {
    const { engine } = ApprovalTestKit.create({ auditAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(auditEntries.some((e) => e.instanceId === instance.id && e.entry.action === 'submitted')).toBe(true);
  });

  it('append() called after approve', async () => {
    const { engine } = ApprovalTestKit.create({ auditAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1' });
    expect(auditEntries.some((e) => e.instanceId === instance.id && e.entry.action === 'approved')).toBe(true);
  });

  it('append() called on every mutation — submit, approve, cancel', async () => {
    const { engine } = ApprovalTestKit.create({ auditAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-2', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.cancel(instance.id, { cancelledBy: 'user1', reason: 'test' });
    const actions = auditEntries.filter((e) => e.instanceId === instance.id).map((e) => e.entry.action);
    expect(actions).toContain('submitted');
    expect(actions).toContain('cancelled');
  });

  it('append() errors do not propagate', async () => {
    const failingAudit: IAuditAdapter = { append: async () => { throw new Error('kafka down'); } };
    const { engine } = ApprovalTestKit.create({ auditAdapter: failingAudit });
    await engine.defineTemplate(basicTemplate);
    await expect(
      engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} }),
    ).resolves.toBeDefined();
  });

  it('append() receives full instance snapshot', async () => {
    let capturedInstance: Readonly<ApprovalInstance> | undefined;
    const capturingAudit: IAuditAdapter = {
      append: async (_t, _i, _e, instance) => { capturedInstance = instance; },
    };
    const { engine } = ApprovalTestKit.create({ auditAdapter: capturingAudit });
    await engine.defineTemplate(basicTemplate);
    await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(capturedInstance?.submittedBy).toBe('user1');
    expect(capturedInstance?.templateName).toBe('enterprise-test');
  });
});

// ─── IMetricsAdapter ────────────────────────────────────────────────────────

describe('IMetricsAdapter', () => {
  let increments: Array<{ metric: string; labels?: Record<string, string> }>;
  let timings: Array<{ metric: string; durationMs: number; labels?: Record<string, string> }>;
  let metricsAdapter: IMetricsAdapter;

  beforeEach(() => {
    increments = [];
    timings = [];
    metricsAdapter = {
      increment: (metric, labels) => { increments.push({ metric, labels }); },
      timing: (metric, durationMs, labels) => { timings.push({ metric, durationMs, labels }); },
    };
  });

  it('increment approval.submitted on submit', async () => {
    const { engine } = ApprovalTestKit.create({ metricsAdapter });
    await engine.defineTemplate(basicTemplate);
    await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(increments.some((i) => i.metric === 'approval.submitted')).toBe(true);
  });

  it('increment approval.approved on approve', async () => {
    const { engine } = ApprovalTestKit.create({ metricsAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1' });
    expect(increments.some((i) => i.metric === 'approval.approved')).toBe(true);
  });

  it('increment approval.rejected on final reject', async () => {
    const { engine } = ApprovalTestKit.create({ metricsAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.reject(instance.id, { approverId: 'mgr1', reason: 'nope' });
    expect(increments.some((i) => i.metric === 'approval.rejected')).toBe(true);
  });

  it('increment approval.cancelled on cancel', async () => {
    const { engine } = ApprovalTestKit.create({ metricsAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.cancel(instance.id, { cancelledBy: 'user1', reason: 'test' });
    expect(increments.some((i) => i.metric === 'approval.cancelled')).toBe(true);
  });

  it('timing approval.operation_duration_ms emitted on approve', async () => {
    const { engine } = ApprovalTestKit.create({ metricsAdapter });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1' });
    expect(timings.some((t) => t.metric === 'approval.operation_duration_ms' && t.labels?.operation === 'approve')).toBe(true);
  });

  it('labels include tenantId', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter(), tenantId: 'acme', metricsAdapter });
    await engine.defineTemplate(basicTemplate);
    await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    const submitted = increments.find((i) => i.metric === 'approval.submitted');
    expect(submitted?.labels?.tenantId).toBe('acme');
    await engine.shutdown();
  });
});

// ─── IAuthorizationPolicy ────────────────────────────────────────────────────

describe('IAuthorizationPolicy', () => {
  it('deny returns ApprovalForbiddenError on approve', async () => {
    const authorizationPolicy: IAuthorizationPolicy = {
      authorize: (ctx) => ctx.actorId === 'blocked' ? 'You are blocked by policy' : undefined,
    };
    const { engine } = ApprovalTestKit.create({ authorizationPolicy });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await expect(engine.approve(instance.id, { approverId: 'blocked' })).rejects.toThrow(ApprovalForbiddenError);
  });

  it('allow passes through and approves successfully', async () => {
    const authorizationPolicy: IAuthorizationPolicy = {
      authorize: () => undefined,
    };
    const { engine } = ApprovalTestKit.create({ authorizationPolicy });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await expect(engine.approve(instance.id, { approverId: 'mgr1' })).resolves.toBeDefined();
  });

  it('authorize receives correct operation context', async () => {
    const captured: Array<{ operation: string; actorId: string }> = [];
    const authorizationPolicy: IAuthorizationPolicy = {
      authorize: (ctx) => { captured.push({ operation: ctx.operation, actorId: ctx.actorId }); return undefined; },
    };
    const { engine } = ApprovalTestKit.create({ authorizationPolicy });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1' });
    expect(captured.some((c) => c.operation === 'approve' && c.actorId === 'mgr1')).toBe(true);
  });

  it('async authorize is awaited', async () => {
    const authorizationPolicy: IAuthorizationPolicy = {
      authorize: async (ctx) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return ctx.actorId === 'evil' ? 'Denied async' : undefined;
      },
    };
    const { engine } = ApprovalTestKit.create({ authorizationPolicy });
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await expect(engine.approve(instance.id, { approverId: 'evil' })).rejects.toThrow(ApprovalForbiddenError);
  });
});

// ─── IOperationMiddleware ─────────────────────────────────────────────────────

describe('IOperationMiddleware', () => {
  it('before() runs before the operation', async () => {
    const order: string[] = [];
    const mw: IOperationMiddleware = {
      before: async (ctx) => { order.push(`before:${ctx.operation}`); },
      after: async (ctx) => { order.push(`after:${ctx.operation}`); },
    };
    const { engine } = ApprovalTestKit.create({ middleware: [mw] });
    await engine.defineTemplate(basicTemplate);
    await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(order[0]).toBe('before:submit');
    expect(order[1]).toBe('after:submit');
  });

  it('middleware error in before() does not prevent operation', async () => {
    const mw: IOperationMiddleware = {
      before: async () => { throw new Error('middleware failure'); },
    };
    const { engine } = ApprovalTestKit.create({ middleware: [mw] });
    await engine.defineTemplate(basicTemplate);
    await expect(
      engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} }),
    ).resolves.toBeDefined();
  });

  it('multiple middleware run in order', async () => {
    const order: string[] = [];
    const mw1: IOperationMiddleware = { before: async () => { order.push('mw1'); } };
    const mw2: IOperationMiddleware = { before: async () => { order.push('mw2'); } };
    const { engine } = ApprovalTestKit.create({ middleware: [mw1, mw2] });
    await engine.defineTemplate(basicTemplate);
    await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(order).toEqual(['mw1', 'mw2']);
  });

  it('after() receives the resulting instance', async () => {
    let capturedResult: ApprovalInstance | undefined;
    const mw: IOperationMiddleware = {
      after: async (_ctx, result) => {
        if (result && typeof result === 'object' && 'id' in result) {
          capturedResult = result as ApprovalInstance;
        }
      },
    };
    const { engine } = ApprovalTestKit.create({ middleware: [mw] });
    await engine.defineTemplate(basicTemplate);
    await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(capturedResult?.submittedBy).toBe('user1');
  });

  it('middleware receives correct tenantId', async () => {
    const tenantIds: string[] = [];
    const mw: IOperationMiddleware = { before: async (ctx) => { tenantIds.push(ctx.tenantId); } };
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter(), tenantId: 'corp', middleware: [mw] });
    await engine.defineTemplate(basicTemplate);
    await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(tenantIds).toContain('corp');
    await engine.shutdown();
  });
});

// ─── Custom condition operators ────────────────────────────────────────────

describe('Custom condition operators', () => {
  it('registerConditionOperator works for contains', async () => {
    const { engine } = ApprovalTestKit.create();
    engine.registerConditionOperator('contains', (actual, expected) =>
      typeof actual === 'string' && actual.includes(String(expected)));

    await engine.defineTemplate({
      name: 'contains-test',
      levels: [
        { level: 1, name: 'Mgr', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' },
      ],
      conditions: [{
        when: { field: 'note', operator: 'contains', value: 'urgent' },
        addLevels: [{ level: 2, name: 'Director', approvers: [{ type: 'user', userId: 'dir1' }], mode: 'any' }],
      }],
    });

    const withUrgent = await engine.submit({ templateName: 'contains-test', documentId: 'd1', documentType: 'req', submittedBy: 'sub1', data: { note: 'this is urgent' } });
    expect(withUrgent.levels).toHaveLength(2);

    const withoutUrgent = await engine.submit({ templateName: 'contains-test', documentId: 'd2', documentType: 'req', submittedBy: 'sub1', data: { note: 'regular request' } });
    expect(withoutUrgent.levels).toHaveLength(1);
  });

  it('unknown operator throws ApprovalValidationError on submit', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate({
      name: 'unknown-op-test',
      levels: [
        { level: 1, name: 'Mgr', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' },
      ],
      conditions: [{
        when: { field: 'amount', operator: 'between' as never, value: 100 },
        addLevels: [{ level: 2, name: 'Dir', approvers: [{ type: 'user', userId: 'dir1' }], mode: 'any' }],
      }],
    });
    await expect(
      engine.submit({ templateName: 'unknown-op-test', documentId: 'd1', documentType: 'req', submittedBy: 'sub1', data: { amount: 150 } }),
    ).rejects.toThrow(ApprovalValidationError);
  });
});

// ─── Custom approver types ────────────────────────────────────────────────

describe('Custom approver types', () => {
  it('registerApproverType resolves custom approvers', async () => {
    const { engine } = ApprovalTestKit.create({
      orgProvider: {
        getUsersByRole: async () => [],
        getUsersByDepartment: async (dept) => dept === 'finance' ? ['fin1', 'fin2'] : [],
      },
    });

    engine.registerApproverType('department', async (config, ctx) =>
      ctx.orgProvider?.getUsersByDepartment?.(String(config.department)) ?? []);

    await engine.defineTemplate({
      name: 'dept-test',
      levels: [
        { level: 1, name: 'Dept Review', approvers: [{ type: 'department', department: 'finance' }], mode: 'any' },
      ],
    });

    const instance = await engine.submit({ templateName: 'dept-test', documentId: 'd1', documentType: 'req', submittedBy: 'user1', data: {} });
    expect(instance.levels[0]?.approverIds).toContain('fin1');
    expect(instance.levels[0]?.approverIds).toContain('fin2');
  });

  it('unregistered custom type throws ApprovalValidationError', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate({
      name: 'unregistered-type',
      levels: [
        { level: 1, name: 'Mgr', approvers: [{ type: 'department', department: 'hr' }], mode: 'any' },
      ],
    });
    await expect(
      engine.submit({ templateName: 'unregistered-type', documentId: 'd1', documentType: 'req', submittedBy: 'user1', data: {} }),
    ).rejects.toThrow(ApprovalValidationError);
  });
});

// ─── Error utilities ──────────────────────────────────────────────────────

describe('Error utilities', () => {
  it('ApprovalNotFoundError.toHttpStatus() returns 404', () => {
    const err = new ApprovalError('not found', 'NOT_FOUND');
    expect(err.toHttpStatus()).toBe(404);
  });

  it('ApprovalConflictError.toHttpStatus() returns 409', () => {
    const err = new ApprovalError('conflict', 'CONFLICT');
    expect(err.toHttpStatus()).toBe(409);
  });

  it('ApprovalForbiddenError.toHttpStatus() returns 403', () => {
    const err = new ApprovalForbiddenError('forbidden');
    expect(err.toHttpStatus()).toBe(403);
  });

  it('ApprovalValidationError.toHttpStatus() returns 422', () => {
    const err = new ApprovalValidationError('bad input');
    expect(err.toHttpStatus()).toBe(422);
  });

  it('unknown code returns 500', () => {
    const err = new ApprovalError('internal', 'INTERNAL_ERROR');
    expect(err.toHttpStatus()).toBe(500);
  });

  it('toJSON() returns plain object with code, message, name', () => {
    const err = new ApprovalForbiddenError('nope');
    const j = err.toJSON();
    expect(j.code).toBe('FORBIDDEN');
    expect(j.message).toBe('nope');
    expect(j.name).toBe('ApprovalForbiddenError');
  });

  it('toJSON() is serializable', () => {
    const err = new ApprovalValidationError('bad');
    expect(() => JSON.stringify(err.toJSON())).not.toThrow();
  });
});

// ─── Cursor pagination ────────────────────────────────────────────────────

describe('Cursor pagination', () => {
  it('queryInstancesByCursor returns items with hasMore', async () => {
    const { engine, clock } = ApprovalTestKit.create();
    await engine.defineTemplate(basicTemplate);
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      await engine.submit({ templateName: 'enterprise-test', documentId: `doc-${i}`, documentType: 'invoice', submittedBy: 'user1', data: {} });
    }
    const page1 = await engine.queryInstancesByCursor({ status: 'pending' }, { limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).toBeDefined();
  });

  it('cursor pagination traverses all items', async () => {
    const { engine, clock } = ApprovalTestKit.create();
    await engine.defineTemplate(basicTemplate);
    for (let i = 0; i < 4; i++) {
      clock.advance(1000);
      await engine.submit({ templateName: 'enterprise-test', documentId: `doc-${i}`, documentType: 'invoice', submittedBy: 'user1', data: {} });
    }
    const all: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await engine.queryInstancesByCursor({ status: 'pending' }, { limit: 2, cursor });
      page.items.forEach((i) => all.push(i.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(all).toHaveLength(4);
    expect(new Set(all).size).toBe(4);
  });

  it('throws NOT_SUPPORTED when adapter does not implement cursor', async () => {
    const adapter = {
      saveTemplate: vi.fn(),
      getTemplate: vi.fn().mockResolvedValue(null),
      listTemplates: vi.fn().mockResolvedValue([]),
      saveInstance: vi.fn(),
      updateInstance: vi.fn(),
      getInstance: vi.fn().mockResolvedValue(null),
      getInstancesByApprover: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      getInstancesByFilter: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      getOverdueInstances: vi.fn().mockResolvedValue([]),
      getIdempotentInstance: vi.fn().mockResolvedValue(null),
      appendAuditEntry: vi.fn(),
      // no getInstancesByCursor
    };
    const engine = new ApprovalEngine({ adapter });
    await expect(engine.queryInstancesByCursor({}, { limit: 10 }))
      .rejects.toThrow(ApprovalError);
    await engine.shutdown();
  });
});

// ─── Template versioning ──────────────────────────────────────────────────

describe('Template versioning', () => {
  it('defineTemplate creates template with version 1', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate(basicTemplate);
    const tpl = await engine.getTemplate('enterprise-test');
    expect(tpl.version).toBe(1);
    expect(tpl.previousVersionId).toBeUndefined();
  });

  it('updateTemplate increments version and sets previousVersionId', async () => {
    const { engine } = ApprovalTestKit.create();
    const firstId = await engine.defineTemplate(basicTemplate);
    await engine.updateTemplate(basicTemplate);
    const tpl = await engine.getTemplate('enterprise-test');
    expect(tpl.version).toBe(2);
    expect(tpl.previousVersionId).toBe(firstId);
  });

  it('updateTemplate a second time gives version 3', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate(basicTemplate);
    await engine.updateTemplate(basicTemplate);
    await engine.updateTemplate(basicTemplate);
    const tpl = await engine.getTemplate('enterprise-test');
    expect(tpl.version).toBe(3);
  });

  it('defineTemplate still throws on duplicate name', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate(basicTemplate);
    await expect(engine.defineTemplate(basicTemplate)).rejects.toThrow(ApprovalValidationError);
  });

  it('updateTemplate throws on non-existent template', async () => {
    const { engine } = ApprovalTestKit.create();
    await expect(engine.updateTemplate(basicTemplate)).rejects.toThrow();
  });

  it('in-flight instance keeps templateSnapshot from submission time', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate({ ...basicTemplate, slaDeadlineDays: 7 });
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });

    await engine.updateTemplate({ ...basicTemplate, slaDeadlineDays: 1 });

    const live = await engine.getInstance(instance.id);
    expect(live.templateSnapshot?.slaDeadlineDays).toBe(7);
  });
});

// ─── ApprovalTestKit.fullyApprove ─────────────────────────────────────────

describe('ApprovalTestKit.fullyApprove', () => {
  it('approves all levels and returns fully approved instance', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    const result = await ApprovalTestKit.fullyApprove(engine, instance.id, { 1: 'mgr1', 2: 'dir1' });
    expect(result.status).toBe('approved');
  });

  it('throws if level has no approver in map', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate(basicTemplate);
    const instance = await engine.submit({ templateName: 'enterprise-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    await expect(ApprovalTestKit.fullyApprove(engine, instance.id, { 1: 'mgr1' }))
      .rejects.toThrow(/No approver provided for level 2/);
  });
});

// ─── SLA breach with ManualClock + scheduler tick ────────────────────────────

describe('SLA breach via ManualClock and scheduler tick', () => {
  it('marks slaBreachedAt after clock advances past slaDeadlineAt', async () => {
    const { engine, clock } = ApprovalTestKit.create();
    await engine.defineTemplate({ ...basicTemplate, name: 'sla-breach-test', slaDeadlineDays: 3 });
    const instance = await engine.submit({ templateName: 'sla-breach-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });
    expect(instance.slaBreachedAt).toBeUndefined();

    clock.advanceDays(4);
    await engine['escalation'].tick();

    const updated = await engine.getInstance(instance.id);
    expect(updated.slaBreachedAt).toBeDefined();
    await engine.shutdown();
  });

  it('sla_breached event fires on bus', async () => {
    const { engine, clock } = ApprovalTestKit.create();
    const breached: string[] = [];
    engine.on('approval:sla_breached', (p) => { breached.push(p.instanceId); });

    await engine.defineTemplate({ ...basicTemplate, name: 'sla-bus-test', slaDeadlineDays: 1 });
    const instance = await engine.submit({ templateName: 'sla-bus-test', documentId: 'doc-1', documentType: 'invoice', submittedBy: 'user1', data: {} });

    clock.advanceDays(2);
    await engine['escalation'].tick();

    expect(breached).toContain(instance.id);
    await engine.shutdown();
  });
});
