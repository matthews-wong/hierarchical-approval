import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { EscalationScheduler } from '../../src/engine/EscalationScheduler.js';
import type { Clock } from '../../src/utils/Clock.js';
import type { InfoRequestedEvent, InfoProvidedEvent } from '../../src/types/index.js';

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

describe('request for information', () => {
  let clock: TestClock;
  let adapter: MemoryAdapter;
  let engine: ApprovalEngine;

  beforeEach(async () => {
    clock = new TestClock();
    adapter = new MemoryAdapter();
    engine = new ApprovalEngine({ adapter, clock });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        {
          level: 1,
          name: 'Manager',
          approvers: [{ type: 'user', userId: 'mgr' }],
          mode: 'any',
          escalationAfterDays: 3,
        },
        { level: 2, name: 'Finance', approvers: [{ type: 'user', userId: 'fin' }], mode: 'any' },
      ],
      slaDeadlineDays: 10,
      escalation: { afterDays: 3, escalateTo: { type: 'user', userId: 'boss' } },
    });
  });

  const submit = async () =>
    engine.submit({
      templateName: 'PO',
      documentId: `doc-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: { amount: 1 },
    });

  it('opens a question without rejecting or losing approvers', async () => {
    const i = await submit();
    const held = await engine.requestInfo(i.id, {
      approverId: 'mgr',
      question: 'Which cost centre?',
    });

    expect(held.status).toBe('pending');
    expect(held.infoRequest?.askedBy).toBe('mgr');
    expect(held.infoRequest?.question).toBe('Which cost centre?');
    expect(held.infoRequest?.level).toBe(1);
    expect(held.levels[0]?.approverIds).toEqual(['mgr']);
  });

  it('emits approval:info_requested addressed to the submitter', async () => {
    const events: InfoRequestedEvent[] = [];
    engine.on('approval:info_requested', (e) => events.push(e));
    const i = await submit();
    await engine.requestInfo(i.id, { approverId: 'mgr', question: 'Why?' });

    expect(events).toHaveLength(1);
    expect(events[0]?.recipients).toEqual(['buyer']);
    expect(events[0]?.question).toBe('Why?');
  });

  it('answering clears the hold and reports how long it was held', async () => {
    const events: InfoProvidedEvent[] = [];
    engine.on('approval:info_provided', (e) => events.push(e));

    const i = await submit();
    await engine.requestInfo(i.id, { approverId: 'mgr', question: 'Why?' });
    clock.advanceDays(2);
    const resumed = await engine.provideInfo(i.id, {
      respondedBy: 'buyer',
      response: 'Cost centre 42',
    });

    expect(resumed.infoRequest).toBeUndefined();
    expect(events[0]?.heldForMs).toBe(2 * DAY);
    expect(events[0]?.recipients).toEqual(['mgr']);
  });

  it('gives back exactly the time spent on hold', async () => {
    const i = await submit();
    const escalationBefore = i.levels[0]?.escalationDueAt?.getTime();
    const slaBefore = i.slaDeadlineAt?.getTime();

    await engine.requestInfo(i.id, { approverId: 'mgr', question: 'Why?' });
    clock.advanceDays(2);
    const resumed = await engine.provideInfo(i.id, { respondedBy: 'buyer', response: 'ok' });

    expect(resumed.levels[0]?.escalationDueAt?.getTime()).toBe((escalationBefore ?? 0) + 2 * DAY);
    expect(resumed.slaDeadlineAt?.getTime()).toBe((slaBefore ?? 0) + 2 * DAY);
  });

  it('does not invent a deadline that was never configured', async () => {
    const i = await submit();
    await engine.requestInfo(i.id, { approverId: 'mgr', question: 'Why?' });
    clock.advanceDays(1);
    const resumed = await engine.provideInfo(i.id, { respondedBy: 'buyer', response: 'ok' });
    // Level 2 has no escalation configured and is not even open yet.
    expect(resumed.levels[1]?.escalationDueAt).toBeUndefined();
    expect(resumed.expiresAt).toBeUndefined();
  });

  it('the scheduler does not escalate an instance while it is on hold', async () => {
    const escalated: string[] = [];
    const scheduler = new EscalationScheduler({
      adapter,
      tenantId: 'default',
      clock,
      onEscalate: async (id) => {
        escalated.push(id);
      },
    });

    const i = await submit();
    await engine.requestInfo(i.id, { approverId: 'mgr', question: 'Why?' });

    clock.advanceDays(5); // well past the 3-day escalation
    await scheduler.tick();
    expect(escalated).toEqual([]);

    await engine.provideInfo(i.id, { respondedBy: 'buyer', response: 'ok' });
    clock.advanceDays(5);
    await scheduler.tick();
    expect(escalated).toEqual([i.id]);
  });

  it('the approval proceeds normally once answered', async () => {
    const i = await submit();
    await engine.requestInfo(i.id, { approverId: 'mgr', question: 'Why?' });
    await engine.provideInfo(i.id, { respondedBy: 'buyer', response: 'ok' });

    const after = await engine.approve(i.id, { approverId: 'mgr' });
    expect(after.levels[0]?.status).toBe('approved');
    expect(after.levels[1]?.status).toBe('pending');
  });

  it('records both sides in the audit trail', async () => {
    const i = await submit();
    await engine.requestInfo(i.id, { approverId: 'mgr', question: 'Which cost centre?' });
    clock.advanceDays(1);
    await engine.provideInfo(i.id, { respondedBy: 'buyer', response: 'CC-42' });

    const history = await engine.getHistory(i.id);
    const asked = history.find((h) => h.action === 'info_requested');
    const answered = history.find((h) => h.action === 'info_provided');
    expect(asked?.actorId).toBe('mgr');
    expect(asked?.comment).toBe('Which cost centre?');
    expect(answered?.actorId).toBe('buyer');
    expect(answered?.comment).toBe('CC-42');
    expect(answered?.newValue?.['heldForMs']).toBe(DAY);
  });

  describe('guards', () => {
    it('refuses a second question while one is open', async () => {
      const i = await submit();
      await engine.requestInfo(i.id, { approverId: 'mgr', question: 'A?' });
      await expect(engine.requestInfo(i.id, { approverId: 'mgr', question: 'B?' })).rejects.toThrow(
        /already open/,
      );
    });

    it('refuses an answer when nothing was asked', async () => {
      const i = await submit();
      await expect(
        engine.provideInfo(i.id, { respondedBy: 'buyer', response: 'x' }),
      ).rejects.toThrow(/No clarification request is open/);
    });

    it('refuses a question from someone who is not an approver on the level', async () => {
      const i = await submit();
      await expect(
        engine.requestInfo(i.id, { approverId: 'stranger', question: 'Why?' }),
      ).rejects.toThrow(/not an approver/i);
    });

    it('refuses a question on a non-pending instance', async () => {
      const i = await submit();
      await engine.cancel(i.id, { cancelledBy: 'buyer', reason: 'x' });
      await expect(
        engine.requestInfo(i.id, { approverId: 'mgr', question: 'Why?' }),
      ).rejects.toThrow();
    });

    it('is subject to the authorization policy', async () => {
      const denying = new ApprovalEngine({
        adapter: new MemoryAdapter(),
        authorizationPolicy: {
          authorize: (ctx) => (ctx.operation === 'requestInfo' ? 'nope' : undefined),
        },
      });
      await denying.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        ],
      });
      const i = await denying.submit({
        templateName: 'PO',
        documentId: 'd1',
        documentType: 'purchase_order',
        submittedBy: 'buyer',
        data: {},
      });
      await expect(
        denying.requestInfo(i.id, { approverId: 'mgr', question: 'Why?' }),
      ).rejects.toThrow(/nope/);
    });
  });
});
