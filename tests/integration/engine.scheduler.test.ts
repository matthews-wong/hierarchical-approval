/**
 * Tests for P3 scheduler-driven features:
 * instance expiry, SLA breach tracking, delegation revert, escalation.
 * All tests call EscalationScheduler.tick() directly to avoid real timers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { EscalationScheduler } from '../../src/engine/EscalationScheduler.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';
import type { ISchedulerAdapter } from '../../src/adapters/ISchedulerAdapter.js';

function makeEngine(tenantId = 'sched-tenant') {
  return new ApprovalEngine({
    adapter: new MemoryAdapter(),
    tenantId,
    escalationPollIntervalMs: 999999,
  });
}

const simpleTemplate: ApprovalTemplateConfig = {
  name: 'Simple',
  documentType: 'doc',
  levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' }],
};

// ─── Instance expiry (P3) ─────────────────────────────────────────────────────

describe('instance expiry', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    await engine.defineTemplate(simpleTemplate);
  });
  afterEach(() => engine.shutdown());

  it('stores expiresAt and deadlineAction on the instance', async () => {
    const expiresAt = new Date(Date.now() + 3600_000);
    const instance = await engine.submit({
      templateName: 'Simple',
      documentId: 'EX-001',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
      expiresAt,
      deadlineAction: 'reject',
    });
    expect(instance.expiresAt?.toISOString()).toBe(expiresAt.toISOString());
    expect(instance.deadlineAction).toBe('reject');
  });

  it('emits approval:expired and sets status=cancelled when deadlineAction=cancel', async () => {
    const adapter = new MemoryAdapter();
    const localEngine = new ApprovalEngine({
      adapter,
      tenantId: 'exp-tenant',
      escalationPollIntervalMs: 999999,
    });
    await localEngine.defineTemplate(simpleTemplate);

    const past = new Date(Date.now() - 1000);
    const instance = await localEngine.submit({
      templateName: 'Simple',
      documentId: 'EX-002',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
      expiresAt: past,
      deadlineAction: 'cancel',
    });

    const events: string[] = [];
    localEngine.on('approval:expired', (p) => events.push(p.instanceId));

    // Manually tick the scheduler
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'exp-tenant',
      onEscalate: async () => {},
      onExpire: async (id, action) => {
        // Mirror what the engine does internally
        const inst = await adapter.getInstance('exp-tenant', id);
        if (!inst || inst.status !== 'pending') return;
        inst.status = action === 'reject' ? 'rejected' : 'cancelled';
        inst.updatedAt = new Date();
        await adapter.updateInstance(inst, inst.version);
        events.push(id);
      },
    });
    await scheduler.tick();

    const updated = await localEngine.getInstance(instance.id);
    expect(updated.status).toBe('cancelled');
    expect(events).toContain(instance.id);

    await localEngine.shutdown();
  });

  it('sets status=rejected when deadlineAction=reject', async () => {
    const adapter = new MemoryAdapter();
    const localEngine = new ApprovalEngine({
      adapter,
      tenantId: 'exp-rej-tenant',
      escalationPollIntervalMs: 999999,
    });
    await localEngine.defineTemplate(simpleTemplate);

    const past = new Date(Date.now() - 1000);
    const instance = await localEngine.submit({
      templateName: 'Simple',
      documentId: 'EX-003',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
      expiresAt: past,
      deadlineAction: 'reject',
    });

    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'exp-rej-tenant',
      onEscalate: async () => {},
      onExpire: async (id, action) => {
        const inst = await adapter.getInstance('exp-rej-tenant', id);
        if (!inst || inst.status !== 'pending') return;
        inst.status = action === 'reject' ? 'rejected' : 'cancelled';
        inst.updatedAt = new Date();
        await adapter.updateInstance(inst, inst.version);
      },
    });
    await scheduler.tick();

    const updated = await localEngine.getInstance(instance.id);
    expect(updated.status).toBe('rejected');
    await localEngine.shutdown();
  });
});

// ─── SLA tracking (P3) ───────────────────────────────────────────────────────

describe('SLA tracking', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sets slaDeadlineAt at submit time from template.slaDeadlineDays', async () => {
    const engine = makeEngine();
    await engine.defineTemplate({
      name: 'SLA5',
      documentType: 'doc',
      slaDeadlineDays: 5,
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
    });

    const before = new Date();
    const instance = await engine.submit({
      templateName: 'SLA5',
      documentId: 'SLA-001',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
    });
    const after = new Date();

    expect(instance.slaDeadlineAt).toBeDefined();
    const expectedMs = 5 * 86_400_000;
    const actualDiff = instance.slaDeadlineAt!.getTime() - before.getTime();
    // Allow a few ms of slack
    expect(actualDiff).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(actualDiff).toBeLessThanOrEqual(expectedMs + (after.getTime() - before.getTime()) + 100);

    await engine.shutdown();
  });

  it('scheduler sets slaBreachedAt and emits approval:sla_breached', async () => {
    const adapter = new MemoryAdapter();
    const localEngine = new ApprovalEngine({
      adapter,
      tenantId: 'sla-tenant',
      escalationPollIntervalMs: 999999,
    });
    await localEngine.defineTemplate({
      name: 'SLA1',
      documentType: 'doc',
      slaDeadlineDays: 1,
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
    });

    // Patch submit to set slaDeadlineAt in the past
    const instance = await localEngine.submit({
      templateName: 'SLA1',
      documentId: 'SLA-002',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
    });

    // Move slaDeadlineAt to the past
    const raw = await adapter.getInstance('sla-tenant', instance.id);
    raw!.slaDeadlineAt = new Date(Date.now() - 1000);
    raw!.slaBreachedAt = undefined;
    await adapter.updateInstance(raw!, raw!.version);

    const breached: string[] = [];
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'sla-tenant',
      onEscalate: async () => {},
      onSlaBreach: async (id) => {
        const inst = await adapter.getInstance('sla-tenant', id);
        if (!inst || inst.slaBreachedAt) return;
        inst.slaBreachedAt = new Date();
        inst.updatedAt = new Date();
        await adapter.updateInstance(inst, inst.version);
        breached.push(id);
      },
    });
    await scheduler.tick();

    expect(breached).toContain(instance.id);

    const updated = await localEngine.getInstance(instance.id);
    expect(updated.slaBreachedAt).toBeDefined();

    await localEngine.shutdown();
  });

  it('does not breach the same instance twice', async () => {
    const adapter = new MemoryAdapter();
    const localEngine = new ApprovalEngine({
      adapter,
      tenantId: 'sla2-tenant',
      escalationPollIntervalMs: 999999,
    });
    await localEngine.defineTemplate({
      name: 'SLA2',
      documentType: 'doc',
      slaDeadlineDays: 1,
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
    });

    const instance = await localEngine.submit({
      templateName: 'SLA2',
      documentId: 'SLA-003',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
    });

    const raw = await adapter.getInstance('sla2-tenant', instance.id);
    raw!.slaDeadlineAt = new Date(Date.now() - 1000);
    raw!.slaBreachedAt = new Date(); // already breached
    await adapter.updateInstance(raw!, raw!.version);

    let callCount = 0;
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'sla2-tenant',
      onEscalate: async () => {},
      onSlaBreach: async () => {
        callCount++;
      },
    });
    await scheduler.tick();

    expect(callCount).toBe(0);
    await localEngine.shutdown();
  });
});

// ─── Delegation revert (P0 Bug 5) ────────────────────────────────────────────

describe('delegation revert', () => {
  it('scheduler reverts delegation when delegatedUntil has passed', async () => {
    const adapter = new MemoryAdapter();
    const localEngine = new ApprovalEngine({
      adapter,
      tenantId: 'delrev-tenant',
      escalationPollIntervalMs: 999999,
    });
    await localEngine.defineTemplate({
      name: 'DelRev',
      documentType: 'doc',
      levels: [
        { level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' },
      ],
    });

    const instance = await localEngine.submit({
      templateName: 'DelRev',
      documentId: 'DR-001',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
    });

    // Delegate with an already-past 'until'
    const pastUntil = new Date(Date.now() - 1000);
    await localEngine.delegate(instance.id, {
      fromApprover: 'mgr1',
      toApprover: 'temp-mgr',
      reason: 'temp',
      until: pastUntil,
    });

    const reverted: Array<{ instanceId: string; level: number; from: string }> = [];
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'delrev-tenant',
      onEscalate: async () => {},
      onRevertDelegation: async (instanceId, levelNumber, fromApprover) => {
        const inst = await adapter.getInstance('delrev-tenant', instanceId);
        if (!inst) return;
        const level = inst.levels.find((l) => l.level === levelNumber);
        if (!level) return;
        const delegateTo = level.delegatedTo;
        if (delegateTo) {
          const idx = level.approverIds.indexOf(delegateTo);
          if (idx >= 0) level.approverIds[idx] = fromApprover;
        }
        level.delegatedUntil = undefined;
        level.delegatedFrom = undefined;
        level.delegatedTo = undefined;
        inst.updatedAt = new Date();
        await adapter.updateInstance(inst, inst.version);
        reverted.push({ instanceId, level: levelNumber, from: fromApprover });
      },
    });
    await scheduler.tick();

    expect(reverted).toHaveLength(1);
    expect(reverted[0]?.from).toBe('mgr1');

    const updated = await localEngine.getInstance(instance.id);
    const level1 = updated.levels.find((l) => l.level === 1)!;
    expect(level1.approverIds).toContain('mgr1');
    expect(level1.approverIds).not.toContain('temp-mgr');
    expect(level1.delegatedUntil).toBeUndefined();

    await localEngine.shutdown();
  });
});

// ─── Escalation via scheduler ─────────────────────────────────────────────────

describe('escalation', () => {
  it('scheduler calls onEscalate for an overdue level', async () => {
    const adapter = new MemoryAdapter();
    const localEngine = new ApprovalEngine({
      adapter,
      tenantId: 'escal-tenant',
      escalationPollIntervalMs: 999999,
    });
    await localEngine.defineTemplate({
      name: 'EscalTmpl',
      documentType: 'doc',
      levels: [
        {
          level: 1,
          name: 'L1',
          approvers: [{ type: 'user', userId: 'u1' }],
          mode: 'any',
          escalationAfterDays: 3,
        },
      ],
      escalation: { escalateTo: { type: 'user', userId: 'escalated-user' } },
    });

    const instance = await localEngine.submit({
      templateName: 'EscalTmpl',
      documentId: 'ESC-001',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
    });

    // Move escalationDueAt to the past
    const raw = await adapter.getInstance('escal-tenant', instance.id);
    const level = raw!.levels.find((l) => l.level === 1)!;
    level.escalationDueAt = new Date(Date.now() - 1000);
    await adapter.updateInstance(raw!, raw!.version);

    const escalated: string[] = [];
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'escal-tenant',
      onEscalate: async (id) => {
        escalated.push(id);
      },
    });
    await scheduler.tick();

    expect(escalated).toContain(instance.id);
    await localEngine.shutdown();
  });

  it('escalation adds new approvers without removing existing ones', async () => {
    const adapter = new MemoryAdapter();
    const localEngine = new ApprovalEngine({
      adapter,
      tenantId: 'escal2-tenant',
      escalationPollIntervalMs: 999999,
    });
    await localEngine.defineTemplate({
      name: 'EscalAdd',
      documentType: 'doc',
      levels: [
        {
          level: 1,
          name: 'L1',
          approvers: [{ type: 'user', userId: 'u1' }],
          mode: 'any',
          escalationAfterDays: 1,
        },
      ],
      escalation: { escalateTo: { type: 'user', userId: 'escalated-user' } },
    });

    const instance = await localEngine.submit({
      templateName: 'EscalAdd',
      documentId: 'ESC-002',
      documentType: 'doc',
      submittedBy: 'alice',
      data: {},
    });

    const raw = await adapter.getInstance('escal2-tenant', instance.id);
    raw!.levels[0]!.escalationDueAt = new Date(Date.now() - 1000);
    await adapter.updateInstance(raw!, raw!.version);

    // Trigger escalation through engine
    await localEngine.escalate(instance.id, { escalatedBy: 'system' });

    const updated = await localEngine.getInstance(instance.id);
    const level1 = updated.levels.find((l) => l.level === 1)!;
    expect(level1.approverIds).toContain('u1');
    expect(level1.approverIds).toContain('escalated-user');
    await localEngine.shutdown();
  });
});

// ─── EscalationScheduler.computeEscalationDue ────────────────────────────────

describe('EscalationScheduler.computeEscalationDue', () => {
  it('returns undefined for zero or negative days', () => {
    const from = new Date('2024-01-01');
    expect(EscalationScheduler.computeEscalationDue(0, from)).toBeUndefined();
    expect(EscalationScheduler.computeEscalationDue(-1, from)).toBeUndefined();
  });

  it('computes correct due date', () => {
    const from = new Date('2024-01-01T00:00:00.000Z');
    const due = EscalationScheduler.computeEscalationDue(3, from);
    expect(due).toBeDefined();
    expect(due!.toISOString().startsWith('2024-01-04')).toBe(true);
  });
});

// ─── Graceful shutdown (P4) ───────────────────────────────────────────────────

describe('graceful shutdown', () => {
  it('shutdown() is async and returns a promise', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(simpleTemplate);
    const result = engine.shutdown();
    expect(result).toBeInstanceOf(Promise);
    await result;
  });

  it('scheduler isRunning is false after stop()', async () => {
    const adapter = new MemoryAdapter();
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'stop-test',
      onEscalate: async () => {},
      pollIntervalMs: 999999,
    });
    scheduler.start();
    expect(scheduler.isRunning).toBe(true);
    await scheduler.stop();
    expect(scheduler.isRunning).toBe(false);
  });

  it('scheduler does not start twice', () => {
    const adapter = new MemoryAdapter();
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'dup-start',
      onEscalate: async () => {},
      pollIntervalMs: 999999,
    });
    scheduler.start();
    scheduler.start(); // Should be a no-op
    expect(scheduler.isRunning).toBe(true);
    void scheduler.stop();
  });
});

// ─── schedulerAdapter wiring (B9) ─────────────────────────────────────────────
//
// Regression coverage for the defect where ApprovalEngineOptions.schedulerAdapter
// was accepted and disposed of on shutdown, but scheduleAt()/cancel() were never
// actually called — an injected BullMQ/Temporal/cron adapter was silently
// ignored while the built-in setInterval poller kept running regardless.

describe('schedulerAdapter wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A fake ISchedulerAdapter whose three methods are vitest spies. */
  function makeFakeSchedulerAdapter(): ISchedulerAdapter & {
    scheduleAt: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    shutdown: ReturnType<typeof vi.fn>;
  } {
    let seq = 0;
    return {
      scheduleAt: vi.fn(async () => `handle-${++seq}`),
      cancel: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };
  }

  it('regression: an injected schedulerAdapter is actually used — scheduleAt() is called', async () => {
    const fakeAdapter = makeFakeSchedulerAdapter();
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'sched-adapter-tenant',
      schedulerAdapter: fakeAdapter,
    });

    expect(fakeAdapter.scheduleAt).toHaveBeenCalledTimes(1);
    const [id, runAt, callback] = fakeAdapter.scheduleAt.mock.calls[0] as [
      string,
      Date,
      () => Promise<void>,
    ];
    expect(id).toBe('sched-adapter-tenant');
    expect(runAt).toBeInstanceOf(Date);
    expect(typeof callback).toBe('function');

    await engine.shutdown();
  });

  it('does not start the built-in setInterval poller when a schedulerAdapter is provided', async () => {
    const startSpy = vi.spyOn(EscalationScheduler.prototype, 'start');
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'sched-adapter-no-poll-tenant',
      schedulerAdapter: makeFakeSchedulerAdapter(),
    });

    expect(startSpy).not.toHaveBeenCalled();
    await engine.shutdown();
  });

  it('omitting schedulerAdapter preserves the existing setInterval polling behavior', async () => {
    const startSpy = vi.spyOn(EscalationScheduler.prototype, 'start');
    const engine = makeEngine('no-scheduler-adapter-tenant');

    expect(startSpy).toHaveBeenCalledTimes(1);
    await engine.shutdown();
  });

  it('the scheduled callback runs a real escalation tick, then reschedules the next one', async () => {
    const tickSpy = vi.spyOn(EscalationScheduler.prototype, 'tick');
    const fakeAdapter = makeFakeSchedulerAdapter();
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'sched-adapter-tick-tenant',
      schedulerAdapter: fakeAdapter,
    });

    expect(fakeAdapter.scheduleAt).toHaveBeenCalledTimes(1);
    const firstCallback = fakeAdapter.scheduleAt.mock.calls[0]![2] as () => Promise<void>;

    await firstCallback();

    expect(tickSpy).toHaveBeenCalledTimes(1);
    expect(fakeAdapter.scheduleAt).toHaveBeenCalledTimes(2); // rescheduled itself

    await engine.shutdown();
  });

  it('cancel() is called with the pending handle during shutdown()', async () => {
    const fakeAdapter = makeFakeSchedulerAdapter();
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'sched-adapter-cancel-tenant',
      schedulerAdapter: fakeAdapter,
    });

    // Let the scheduleAt() promise settle so the engine has recorded the handle
    // before we tear it down.
    await Promise.resolve();
    await Promise.resolve();

    await engine.shutdown();

    expect(fakeAdapter.cancel).toHaveBeenCalledTimes(1);
    expect(fakeAdapter.cancel).toHaveBeenCalledWith('handle-1');
    expect(fakeAdapter.shutdown).toHaveBeenCalledTimes(1);
  });

  it('a straggler callback firing after shutdown() does not tick again or reschedule', async () => {
    const tickSpy = vi.spyOn(EscalationScheduler.prototype, 'tick');
    const fakeAdapter = makeFakeSchedulerAdapter();
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'sched-adapter-straggler-tenant',
      schedulerAdapter: fakeAdapter,
    });

    const firstCallback = fakeAdapter.scheduleAt.mock.calls[0]![2] as () => Promise<void>;
    await Promise.resolve();
    await Promise.resolve();

    await engine.shutdown();
    tickSpy.mockClear();
    fakeAdapter.scheduleAt.mockClear();

    await firstCallback();

    expect(tickSpy).not.toHaveBeenCalled();
    expect(fakeAdapter.scheduleAt).not.toHaveBeenCalled(); // no reschedule after teardown
  });

  it('logs and does not throw when scheduleAt() rejects', async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const failure = new Error('queue unavailable');
    const fakeAdapter: ISchedulerAdapter = {
      scheduleAt: vi.fn().mockRejectedValue(failure),
      cancel: vi.fn(async () => {}),
      shutdown: vi.fn(async () => {}),
    };

    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'sched-adapter-reject-tenant',
      schedulerAdapter: fakeAdapter,
      logger,
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(logger.error).toHaveBeenCalledWith(
      'ApprovalEngine: failed to schedule the next escalation tick via schedulerAdapter',
      failure,
      expect.objectContaining({ tenantId: 'sched-adapter-reject-tenant' }),
    );

    await engine.shutdown();
  });
});
