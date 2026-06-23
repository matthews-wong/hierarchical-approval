import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { weekendCalendar } from '../../src/utils/BusinessCalendar.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

const template: ApprovalTemplateConfig = {
  name: 'Calendar',
  documentType: 'doc',
  levels: [
    {
      level: 1,
      name: 'L1',
      mode: 'any',
      approvers: [{ type: 'user', userId: 'appr' }],
      escalationAfterDays: 2,
    },
  ],
};

describe('ApprovalEngine — business calendar', () => {
  it('computes escalationDueAt in business days when a calendar is configured', async () => {
    // Fixed clock: Friday 2026-06-19 09:00.
    const fixed = new Date('2026-06-19T09:00:00');
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'cal-tenant',
      escalationPollIntervalMs: 999999,
      clock: { now: () => fixed },
      calendar: weekendCalendar(),
    });
    await engine.defineTemplate(template);

    const inst = await engine.submit({ templateName: 'Calendar', documentId: 'C-1', documentType: 'doc', submittedBy: 'sub' });
    // Fri + 2 business days = Tue 2026-06-23 (skips Sat/Sun).
    const due = inst.levels[0]?.escalationDueAt;
    expect(due?.getDate()).toBe(23);
    expect(due?.getMonth()).toBe(5);
    await engine.shutdown();
  });

  it('uses plain calendar days when no calendar is configured', async () => {
    const fixed = new Date('2026-06-19T09:00:00');
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'cal-tenant-2',
      escalationPollIntervalMs: 999999,
      clock: { now: () => fixed },
    });
    await engine.defineTemplate(template);

    const inst = await engine.submit({ templateName: 'Calendar', documentId: 'C-2', documentType: 'doc', submittedBy: 'sub' });
    // Fri + 2 calendar days = Sun 2026-06-21.
    const due = inst.levels[0]?.escalationDueAt;
    expect(due?.getDate()).toBe(21);
    await engine.shutdown();
  });
});
