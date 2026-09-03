/**
 * Unit tests for EscalationScheduler tick branches not reachable through the
 * integration suite: default deadlineAction, delegation-revert gating,
 * SLA re-report suppression, and the per-handler error paths.
 */
import { describe, it, expect, vi } from 'vitest';
import { EscalationScheduler } from '../../src/engine/EscalationScheduler.js';
import type { IStorageAdapter } from '../../src/adapters/IStorageAdapter.js';
import type { Logger } from '../../src/utils/Logger.js';
import type { ApprovalInstance } from '../../src/types/index.js';

const NOW = new Date('2026-08-12T12:00:00.000Z');
const PAST = new Date('2026-08-01T12:00:00.000Z');
const FUTURE = new Date('2026-08-20T12:00:00.000Z');

// Test fixture: a pending instance carrying every field the scheduler reads.
// Cast through unknown — the literal is intentionally a partial ApprovalInstance.
function makeInstance(overrides: Record<string, unknown> = {}): ApprovalInstance {
  return {
    id: 'inst-1',
    tenantId: 't',
    templateName: 'T',
    documentId: 'D-1',
    documentType: 'doc',
    submittedBy: 'alice',
    status: 'pending',
    currentLevel: 1,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    levels: [
      { level: 1, name: 'L1', status: 'pending', approvers: [{ type: 'user', userId: 'bob' }] },
    ],
    ...overrides,
  } as unknown as ApprovalInstance;
}

function makeLogger() {
  const calls = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() };
  return { calls, logger: calls as unknown as Logger };
}

function makeScheduler(overrides: Record<string, unknown> = {}) {
  const adapter = { getOverdueInstances: vi.fn() } as unknown as IStorageAdapter;
  const { calls, logger } = makeLogger();
  const handlers = {
    onEscalate: vi.fn(async () => {}),
    onExpire: vi.fn(async () => {}),
    onSlaBreach: vi.fn(async () => {}),
    onRevertDelegation: vi.fn(async () => {}),
  };
  const scheduler = new EscalationScheduler({
    adapter,
    tenantId: 't',
    clock: { now: () => NOW },
    logger,
    ...handlers,
    ...overrides,
  });
  return { scheduler, adapter, handlers, calls };
}

describe('EscalationScheduler — expiry', () => {
  it('expired instance triggers onExpire with its stored deadlineAction and skips escalation', async () => {
    const { scheduler, adapter, handlers } = makeScheduler();
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({
        expiresAt: PAST,
        deadlineAction: 'reject',
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'pending',
            approvers: [{ type: 'user', userId: 'bob' }],
            escalationDueAt: PAST,
          },
        ],
      }),
    ]);

    await scheduler.tick();

    expect(handlers.onExpire).toHaveBeenCalledWith('inst-1', 'reject');
    expect(handlers.onEscalate).not.toHaveBeenCalled();
  });

  it('defaults the deadlineAction to cancel when the instance omits it', async () => {
    const { scheduler, adapter, handlers } = makeScheduler();
    adapter.getOverdueInstances.mockResolvedValue([makeInstance({ expiresAt: PAST })]);

    await scheduler.tick();

    expect(handlers.onExpire).toHaveBeenCalledWith('inst-1', 'cancel');
  });

  it('an expired instance still skips escalation when no onExpire handler is wired', async () => {
    const { scheduler, adapter, handlers } = makeScheduler({ onExpire: undefined });
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({
        expiresAt: PAST,
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'pending',
            approvers: [{ type: 'user', userId: 'bob' }],
            escalationDueAt: PAST,
          },
        ],
      }),
    ]);

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(handlers.onEscalate).not.toHaveBeenCalled();
  });
});

describe('EscalationScheduler — delegation revert', () => {
  it('reverts only pending levels whose delegatedUntil has passed', async () => {
    const { scheduler, adapter, handlers } = makeScheduler();
    const expiredLevel = {
      level: 1,
      name: 'L1',
      status: 'pending' as const,
      approvers: [{ type: 'user', userId: 'bob' }],
      delegatedUntil: PAST,
      delegatedFrom: 'alice',
    };
    const futureLevel = {
      level: 2,
      name: 'L2',
      status: 'pending' as const,
      approvers: [{ type: 'user', userId: 'carol' }],
      delegatedUntil: FUTURE,
      delegatedFrom: 'alice',
    };
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({ currentLevel: 2, levels: [expiredLevel, futureLevel] }),
    ]);

    await scheduler.tick();

    expect(handlers.onRevertDelegation).toHaveBeenCalledTimes(1);
    expect(handlers.onRevertDelegation).toHaveBeenCalledWith('inst-1', 1, 'alice');
  });

  it('does not revert a level that is no longer pending', async () => {
    const { scheduler, adapter, handlers } = makeScheduler();
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'approved' as const,
            approvers: [{ type: 'user', userId: 'bob' }],
            delegatedUntil: PAST,
            delegatedFrom: 'alice',
          },
        ],
      }),
    ]);

    await scheduler.tick();

    expect(handlers.onRevertDelegation).not.toHaveBeenCalled();
  });
});

describe('EscalationScheduler — SLA breach', () => {
  it('reports a breach and still escalates in the same tick', async () => {
    const { scheduler, adapter, handlers } = makeScheduler();
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({
        slaDeadlineAt: PAST,
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'pending',
            approvers: [{ type: 'user', userId: 'bob' }],
            escalationDueAt: PAST,
          },
        ],
      }),
    ]);

    await scheduler.tick();

    expect(handlers.onSlaBreach).toHaveBeenCalledWith('inst-1');
    expect(handlers.onEscalate).toHaveBeenCalledWith('inst-1', 1);
  });

  it('does not re-report a breach that is already recorded', async () => {
    const { scheduler, adapter, handlers } = makeScheduler();
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({
        slaDeadlineAt: PAST,
        slaBreachedAt: PAST,
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'pending',
            approvers: [{ type: 'user', userId: 'bob' }],
            escalationDueAt: PAST,
          },
        ],
      }),
    ]);

    await scheduler.tick();

    expect(handlers.onSlaBreach).not.toHaveBeenCalled();
    expect(handlers.onEscalate).toHaveBeenCalledWith('inst-1', 1);
  });
});

describe('EscalationScheduler — error paths', () => {
  it('logs a throwing onSlaBreach and still escalates', async () => {
    const { scheduler, adapter, handlers, calls } = makeScheduler();
    handlers.onSlaBreach.mockRejectedValue(new Error('boom'));
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({
        slaDeadlineAt: PAST,
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'pending',
            approvers: [{ type: 'user', userId: 'bob' }],
            escalationDueAt: PAST,
          },
        ],
      }),
    ]);

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to record SLA breach'),
      expect.any(Error),
      expect.objectContaining({ tenantId: 't', instanceId: 'inst-1' }),
    );
    expect(handlers.onEscalate).toHaveBeenCalledWith('inst-1', 1);
  });

  it('a throwing onEscalate is logged and later instances are still processed', async () => {
    const { scheduler, adapter, handlers, calls } = makeScheduler();
    handlers.onEscalate
      .mockRejectedValueOnce(new Error('escalate boom'))
      .mockResolvedValue(undefined);
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({
        id: 'inst-1',
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'pending',
            approvers: [{ type: 'user', userId: 'bob' }],
            escalationDueAt: PAST,
          },
        ],
      }),
      makeInstance({
        id: 'inst-2',
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'pending',
            approvers: [{ type: 'user', userId: 'bob' }],
            escalationDueAt: PAST,
          },
        ],
      }),
    ]);

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to process instance'),
      expect.any(Error),
      expect.objectContaining({ instanceId: 'inst-1' }),
    );
    expect(handlers.onEscalate).toHaveBeenCalledTimes(2);
    expect(handlers.onEscalate).toHaveBeenLastCalledWith('inst-2', 1);
  });

  it('logs a failed overdue-instances fetch and touches no handlers', async () => {
    const { scheduler, adapter, handlers, calls } = makeScheduler();
    adapter.getOverdueInstances.mockRejectedValue(new Error('db down'));

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to fetch overdue instances'),
      expect.any(Error),
      expect.objectContaining({ tenantId: 't' }),
    );
    expect(handlers.onEscalate).not.toHaveBeenCalled();
    expect(handlers.onExpire).not.toHaveBeenCalled();
    expect(handlers.onSlaBreach).not.toHaveBeenCalled();
    expect(handlers.onRevertDelegation).not.toHaveBeenCalled();
  });

  it('logs a throwing onRevertDelegation and still escalates', async () => {
    const { scheduler, adapter, handlers, calls } = makeScheduler();
    handlers.onRevertDelegation.mockRejectedValue(new Error('revert boom'));
    adapter.getOverdueInstances.mockResolvedValue([
      makeInstance({
        levels: [
          {
            level: 1,
            name: 'L1',
            status: 'pending',
            approvers: [{ type: 'user', userId: 'bob' }],
            delegatedUntil: PAST,
            delegatedFrom: 'alice',
            escalationDueAt: PAST,
          },
        ],
      }),
    ]);

    await expect(scheduler.tick()).resolves.toBeUndefined();

    expect(calls.error).toHaveBeenCalledWith(
      expect.stringContaining('failed to revert delegation'),
      expect.any(Error),
      expect.objectContaining({ tenantId: 't', instanceId: 'inst-1', levelNumber: 1 }),
    );
    expect(handlers.onEscalate).toHaveBeenCalledWith('inst-1', 1);
  });
});
