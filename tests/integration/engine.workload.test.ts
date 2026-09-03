import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { Clock } from '../../src/utils/Clock.js';

class TestClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

const DAY = 86_400_000;

const one = (n: number, name: string, userId: string, extra: Record<string, unknown> = {}) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
  ...extra,
});

describe('getWorkload', () => {
  let clock: TestClock;
  let engine: ApprovalEngine;

  beforeEach(async () => {
    clock = new TestClock();
    engine = new ApprovalEngine({ adapter: new MemoryAdapter(), clock });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [one(1, 'Manager', 'alice'), one(2, 'Finance', 'bob')],
    });
  });

  const submit = (id: string, documentType = 'purchase_order', templateName = 'PO') =>
    engine.submit({
      templateName,
      documentId: id,
      documentType,
      submittedBy: 'buyer',
      data: {},
    });

  const rowFor = async (id: string) =>
    (await engine.getWorkload()).find((w) => w.approverId === id);

  it('is empty when nothing is pending', async () => {
    expect(await engine.getWorkload()).toEqual([]);
  });

  it('counts open levels per approver', async () => {
    await submit('po-1');
    await submit('po-2');

    const workload = await engine.getWorkload();
    expect(workload).toHaveLength(1); // bob's level is still waiting
    expect(workload[0]).toMatchObject({ approverId: 'alice', pending: 2, instances: 2 });
  });

  it('follows the work as the chain advances', async () => {
    const i = await submit('po-1');
    await engine.approve(i.id, { approverId: 'alice' });

    const workload = await engine.getWorkload();
    expect(workload.map((w) => w.approverId)).toEqual(['bob']);
  });

  it('sorts busiest first', async () => {
    await engine.defineTemplate({
      name: 'SOLO',
      documentType: 'other',
      levels: [one(1, 'Solo', 'carol')],
    });
    await submit('po-1');
    await submit('po-2');
    await submit('o-1', 'other', 'SOLO');

    const workload = await engine.getWorkload();
    expect(workload.map((w) => `${w.approverId}:${w.pending}`)).toEqual(['alice:2', 'carol:1']);
  });

  it('reports the age of the oldest item', async () => {
    await submit('po-1');
    clock.advanceDays(3);
    await submit('po-2');
    clock.advanceDays(1);

    const alice = await rowFor('alice');
    expect(alice?.oldestPendingAt?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(alice?.oldestAgeMs).toBe(4 * DAY);
  });

  it('counts overdue levels against their escalation deadline', async () => {
    await engine.defineTemplate({
      name: 'ESC',
      documentType: 'esc',
      levels: [one(1, 'Manager', 'alice', { escalationAfterDays: 2 })],
    });
    await submit('e-1', 'esc', 'ESC');

    expect((await rowFor('alice'))?.overdue).toBe(0);
    clock.advanceDays(3);
    expect((await rowFor('alice'))?.overdue).toBe(1);
  });

  it('counts items paused by a clarification request', async () => {
    const i = await submit('po-1');
    expect((await rowFor('alice'))?.onHold).toBe(0);

    await engine.requestInfo(i.id, { approverId: 'alice', question: 'Which cost centre?' });
    expect((await rowFor('alice'))?.onHold).toBe(1);
  });

  it('drops an approver who has already voted on an open level', async () => {
    await engine.defineTemplate({
      name: 'BOARD',
      documentType: 'board',
      levels: [
        {
          level: 1,
          name: 'Board',
          mode: 'quorum',
          minApprovals: 2,
          approvers: [
            { type: 'user', userId: 'd1' },
            { type: 'user', userId: 'd2' },
          ],
        },
      ],
    });
    const i = await submit('b-1', 'board', 'BOARD');
    await engine.approve(i.id, { approverId: 'd1' });

    const workload = await engine.getWorkload();
    // d1 owes nothing more even though the level is still collecting votes.
    expect(workload.map((w) => w.approverId)).toEqual(['d2']);
  });

  it('counts each open branch of a parallel group', async () => {
    await engine.defineTemplate({
      name: 'PAR',
      documentType: 'contract',
      levels: [
        one(1, 'Finance', 'dana', { group: 'review' }),
        one(2, 'Legal', 'dana', { group: 'review' }),
      ],
    });
    await submit('c-1', 'contract', 'PAR');

    const dana = await rowFor('dana');
    // Two open levels, but only one document.
    expect(dana?.pending).toBe(2);
    expect(dana?.instances).toBe(1);
  });

  it('ignores terminal instances', async () => {
    const i = await submit('po-1');
    await engine.cancel(i.id, { cancelledBy: 'buyer', reason: 'x' });
    expect(await engine.getWorkload()).toEqual([]);
  });

  it('scopes by document type', async () => {
    await engine.defineTemplate({
      name: 'SOLO',
      documentType: 'other',
      levels: [one(1, 'Solo', 'carol')],
    });
    await submit('po-1');
    await submit('o-1', 'other', 'SOLO');

    const workload = await engine.getWorkload({ documentType: 'other' });
    expect(workload.map((w) => w.approverId)).toEqual(['carol']);
  });
});
