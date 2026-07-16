import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';
import type { Clock } from '../../src/utils/Clock.js';

function makeEngine() {
  return new ApprovalEngine({
    adapter: new MemoryAdapter(),
    tenantId: 'stats-tenant',
    escalationPollIntervalMs: 999999,
  });
}

/** Returns a clock whose now() is backed by a mutable timestamp, for deterministic tests. */
function controllableClock(start: Date): { clock: Clock; advance: (ms: number) => void } {
  let t = start.getTime();
  return {
    clock: { now: () => new Date(t) },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

const template: ApprovalTemplateConfig = {
  name: 'Simple',
  documentType: 'doc',
  levels: [{ level: 1, name: 'L1', mode: 'any', approvers: [{ type: 'user', userId: 'appr' }] }],
};

describe('ApprovalEngine — getStatistics', () => {
  it('returns zeroed stats for an empty tenant', async () => {
    const engine = makeEngine();
    const stats = await engine.getStatistics();
    expect(stats.total).toBe(0);
    expect(stats.byStatus.pending).toBe(0);
    expect(stats.approvalRate).toBe(0);
    expect(stats.overdue).toBe(0);
    await engine.shutdown();
  });

  it('counts instances by status and computes approval rate', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(template);

    // 2 approved, 1 rejected, 1 pending
    for (const id of ['A-1', 'A-2']) {
      const inst = await engine.submit({ templateName: 'Simple', documentId: id, documentType: 'doc', submittedBy: 'sub' });
      await engine.approve(inst.id, { approverId: 'appr' });
    }
    const toReject = await engine.submit({ templateName: 'Simple', documentId: 'R-1', documentType: 'doc', submittedBy: 'sub' });
    await engine.reject(toReject.id, { approverId: 'appr', reason: 'no' });
    await engine.submit({ templateName: 'Simple', documentId: 'P-1', documentType: 'doc', submittedBy: 'sub' });

    const stats = await engine.getStatistics();
    expect(stats.total).toBe(4);
    expect(stats.byStatus.approved).toBe(2);
    expect(stats.byStatus.rejected).toBe(1);
    expect(stats.byStatus.pending).toBe(1);
    // approved / (approved + rejected) = 2 / 3
    expect(stats.approvalRate).toBeCloseTo(2 / 3, 5);
    await engine.shutdown();
  });

  it('breaks down counts per template name', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(template);
    await engine.defineTemplate({ ...template, name: 'Other', documentType: 'invoice' });

    // 2 under 'Simple', 1 under 'Other'
    for (const id of ['D-1', 'D-2']) {
      await engine.submit({ templateName: 'Simple', documentId: id, documentType: 'doc', submittedBy: 'sub' });
    }
    await engine.submit({ templateName: 'Other', documentId: 'I-1', documentType: 'invoice', submittedBy: 'sub' });

    const stats = await engine.getStatistics();
    expect(stats.byTemplate).toEqual({ Simple: 2, Other: 1 });
    await engine.shutdown();
  });

  it('computes average and median cycle time over resolved instances', async () => {
    const { clock, advance } = controllableClock(new Date('2026-01-01T00:00:00Z'));
    const engine = new ApprovalEngine({
      adapter: new MemoryAdapter(),
      tenantId: 'stats-tenant',
      escalationPollIntervalMs: 999999,
      clock,
    });
    await engine.defineTemplate(template);

    // Resolved instance A: submitted at t0, approved 1000ms later.
    const a = await engine.submit({ templateName: 'Simple', documentId: 'A', documentType: 'doc', submittedBy: 'sub' });
    advance(1000);
    await engine.approve(a.id, { approverId: 'appr' });

    // Resolved instance B: submitted at t0, rejected 3000ms later.
    const b = await engine.submit({ templateName: 'Simple', documentId: 'B', documentType: 'doc', submittedBy: 'sub' });
    advance(3000);
    await engine.reject(b.id, { approverId: 'appr', reason: 'no' });

    // Unresolved instance C: still pending — must not influence cycle time.
    await engine.submit({ templateName: 'Simple', documentId: 'C', documentType: 'doc', submittedBy: 'sub' });

    const stats = await engine.getStatistics();
    // Cycle times: [1000, 3000] -> avg 2000, median 2000.
    expect(stats.avgCycleTimeMs).toBe(2000);
    expect(stats.medianCycleTimeMs).toBe(2000);
    // Pending instance excluded from cycle-time denominator but still counted.
    expect(stats.total).toBe(3);
    expect(stats.byStatus.pending).toBe(1);
    await engine.shutdown();
  });

  it('reports zero cycle-time metrics when nothing is resolved', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(template);
    await engine.submit({ templateName: 'Simple', documentId: 'P-1', documentType: 'doc', submittedBy: 'sub' });

    const stats = await engine.getStatistics();
    expect(stats.avgCycleTimeMs).toBe(0);
    expect(stats.medianCycleTimeMs).toBe(0);
    expect(stats.byTemplate).toEqual({ Simple: 1 });
    await engine.shutdown();
  });
});
