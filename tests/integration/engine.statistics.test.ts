import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { ManualClock } from '../../src/testing/ApprovalTestKit.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

function makeEngine() {
  return new ApprovalEngine({
    adapter: new MemoryAdapter(),
    tenantId: 'stats-tenant',
    escalationPollIntervalMs: 999999,
  });
}

/** Same as {@link makeEngine}, but with an injected clock so cycle-time durations are deterministic. */
function makeEngineWithClock(clock: ManualClock) {
  return new ApprovalEngine({
    adapter: new MemoryAdapter(),
    tenantId: 'stats-tenant',
    escalationPollIntervalMs: 999999,
    clock,
  });
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
      const inst = await engine.submit({
        templateName: 'Simple',
        documentId: id,
        documentType: 'doc',
        submittedBy: 'sub',
      });
      await engine.approve(inst.id, { approverId: 'appr' });
    }
    const toReject = await engine.submit({
      templateName: 'Simple',
      documentId: 'R-1',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    await engine.reject(toReject.id, { approverId: 'appr', reason: 'no' });
    await engine.submit({
      templateName: 'Simple',
      documentId: 'P-1',
      documentType: 'doc',
      submittedBy: 'sub',
    });

    const stats = await engine.getStatistics();
    expect(stats.total).toBe(4);
    expect(stats.byStatus.approved).toBe(2);
    expect(stats.byStatus.rejected).toBe(1);
    expect(stats.byStatus.pending).toBe(1);
    // approved / (approved + rejected) = 2 / 3
    expect(stats.approvalRate).toBeCloseTo(2 / 3, 5);
    await engine.shutdown();
  });

  it('honours a documentType filter', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(template);
    await engine.defineTemplate({ ...template, name: 'Other', documentType: 'invoice' });

    await engine.submit({
      templateName: 'Simple',
      documentId: 'D-1',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    await engine.submit({
      templateName: 'Other',
      documentId: 'I-1',
      documentType: 'invoice',
      submittedBy: 'sub',
    });

    const stats = await engine.getStatistics({ documentType: 'invoice' });
    expect(stats.total).toBe(1);
    expect(stats.byStatus.pending).toBe(1);
    await engine.shutdown();
  });

  it('breaks down counts per template', async () => {
    const engine = makeEngine();
    await engine.defineTemplate({ ...template, name: 'Simple', documentType: 'doc' });
    await engine.defineTemplate({ ...template, name: 'Invoice', documentType: 'invoice' });

    // Simple: 1 approved, 1 rejected
    const s1 = await engine.submit({
      templateName: 'Simple',
      documentId: 'S-1',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    await engine.approve(s1.id, { approverId: 'appr' });
    const s2 = await engine.submit({
      templateName: 'Simple',
      documentId: 'S-2',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    await engine.reject(s2.id, { approverId: 'appr', reason: 'no' });
    // Invoice: 1 pending
    await engine.submit({
      templateName: 'Invoice',
      documentId: 'I-1',
      documentType: 'invoice',
      submittedBy: 'sub',
    });

    const stats = await engine.getStatistics();
    expect(Object.keys(stats.byTemplate).sort()).toEqual(['Invoice', 'Simple']);
    expect(stats.byTemplate.Simple).toEqual({ total: 2, approved: 1, rejected: 1, pending: 0 });
    expect(stats.byTemplate.Invoice).toEqual({ total: 1, approved: 0, rejected: 0, pending: 1 });

    // Combined filter + byTemplate: only the doc-typed template shows up
    const docStats = await engine.getStatistics({ documentType: 'doc' });
    expect(Object.keys(docStats.byTemplate)).toEqual(['Simple']);
    await engine.shutdown();
  });

  it('returns an empty byTemplate when no templates are defined', async () => {
    const engine = makeEngine();
    const stats = await engine.getStatistics();
    expect(stats.byTemplate).toEqual({});
    await engine.shutdown();
  });
});

describe('ApprovalEngine — getStatistics cycleTime', () => {
  it('computes count/average/percentiles/min/max from the injected clock for completed instances', async () => {
    const clock = new ManualClock(new Date('2025-06-01T00:00:00Z'));
    const engine = makeEngineWithClock(clock);
    await engine.defineTemplate(template);

    // Instance A: 1000ms to approve.
    const a = await engine.submit({
      templateName: 'Simple',
      documentId: 'CT-A',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    clock.advance(1000);
    await engine.approve(a.id, { approverId: 'appr' });

    // Instance B: 2000ms to approve.
    const b = await engine.submit({
      templateName: 'Simple',
      documentId: 'CT-B',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    clock.advance(2000);
    await engine.approve(b.id, { approverId: 'appr' });

    // Instance C: 3000ms to reject.
    const c = await engine.submit({
      templateName: 'Simple',
      documentId: 'CT-C',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    clock.advance(3000);
    await engine.reject(c.id, { approverId: 'appr', reason: 'no' });

    // Instance D: 4000ms to cancel.
    const d = await engine.submit({
      templateName: 'Simple',
      documentId: 'CT-D',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    clock.advance(4000);
    await engine.cancel(d.id, { cancelledBy: 'sub', reason: 'no longer needed' });

    // Instance E stays pending — must be excluded from cycle-time entirely.
    await engine.submit({
      templateName: 'Simple',
      documentId: 'CT-E',
      documentType: 'doc',
      submittedBy: 'sub',
    });

    const stats = await engine.getStatistics();
    // durations sorted: [1000, 2000, 3000, 4000]
    expect(stats.cycleTime).toEqual({
      count: 4,
      averageMs: 2500,
      p50Ms: 2000,
      p95Ms: 4000,
      minMs: 1000,
      maxMs: 4000,
    });
    await engine.shutdown();
  });

  it('returns zeroed cycleTime (never NaN) when there are no completed instances', async () => {
    const engine = makeEngine();
    const stats = await engine.getStatistics();
    expect(stats.cycleTime).toEqual({
      count: 0,
      averageMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      minMs: 0,
      maxMs: 0,
    });
    expect(stats.cycleTimeByTemplate).toEqual({});
    await engine.shutdown();
  });

  it('stays zeroed when instances exist but none have completed yet', async () => {
    const clock = new ManualClock(new Date('2025-06-01T00:00:00Z'));
    const engine = makeEngineWithClock(clock);
    await engine.defineTemplate(template);
    await engine.submit({
      templateName: 'Simple',
      documentId: 'CT-PENDING',
      documentType: 'doc',
      submittedBy: 'sub',
    });

    const stats = await engine.getStatistics();
    expect(stats.cycleTime.count).toBe(0);
    expect(stats.cycleTime.averageMs).toBe(0);
    expect(stats.cycleTimeByTemplate).toEqual({});
    await engine.shutdown();
  });

  it('breaks cycleTime down per template, only including templates with completed instances', async () => {
    const clock = new ManualClock(new Date('2025-06-01T00:00:00Z'));
    const engine = makeEngineWithClock(clock);
    await engine.defineTemplate({ ...template, name: 'Simple', documentType: 'doc' });
    await engine.defineTemplate({ ...template, name: 'Invoice', documentType: 'invoice' });

    const s1 = await engine.submit({
      templateName: 'Simple',
      documentId: 'PT-S1',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    clock.advance(1000);
    await engine.approve(s1.id, { approverId: 'appr' });

    const s2 = await engine.submit({
      templateName: 'Simple',
      documentId: 'PT-S2',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    clock.advance(5000);
    await engine.approve(s2.id, { approverId: 'appr' });

    // Invoice stays pending — no completed instances, so it must be absent
    // from cycleTimeByTemplate even though byTemplate still lists it.
    await engine.submit({
      templateName: 'Invoice',
      documentId: 'PT-I1',
      documentType: 'invoice',
      submittedBy: 'sub',
    });

    const stats = await engine.getStatistics();
    expect(Object.keys(stats.byTemplate).sort()).toEqual(['Invoice', 'Simple']);
    expect(Object.keys(stats.cycleTimeByTemplate)).toEqual(['Simple']);
    expect(stats.cycleTimeByTemplate.Simple).toEqual({
      count: 2,
      averageMs: 3000,
      p50Ms: 1000,
      p95Ms: 5000,
      minMs: 1000,
      maxMs: 5000,
    });
    // Overall cycleTime aggregates across all templates matching the filter.
    expect(stats.cycleTime.count).toBe(2);
    await engine.shutdown();
  });

  it('respects a documentType filter combined with getStatistics', async () => {
    const clock = new ManualClock(new Date('2025-06-01T00:00:00Z'));
    const engine = makeEngineWithClock(clock);
    await engine.defineTemplate({ ...template, name: 'Simple', documentType: 'doc' });
    await engine.defineTemplate({ ...template, name: 'Other', documentType: 'invoice' });

    const docInst = await engine.submit({
      templateName: 'Simple',
      documentId: 'DF-1',
      documentType: 'doc',
      submittedBy: 'sub',
    });
    clock.advance(1500);
    await engine.approve(docInst.id, { approverId: 'appr' });

    const invInst = await engine.submit({
      templateName: 'Other',
      documentId: 'DF-2',
      documentType: 'invoice',
      submittedBy: 'sub',
    });
    clock.advance(9000);
    await engine.approve(invInst.id, { approverId: 'appr' });

    const filtered = await engine.getStatistics({ documentType: 'invoice' });
    expect(filtered.cycleTime).toEqual({
      count: 1,
      averageMs: 9000,
      p50Ms: 9000,
      p95Ms: 9000,
      minMs: 9000,
      maxMs: 9000,
    });
    await engine.shutdown();
  });
});
