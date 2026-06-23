import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

function makeEngine() {
  return new ApprovalEngine({
    adapter: new MemoryAdapter(),
    tenantId: 'stats-tenant',
    escalationPollIntervalMs: 999999,
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

  it('honours a documentType filter', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(template);
    await engine.defineTemplate({ ...template, name: 'Other', documentType: 'invoice' });

    await engine.submit({ templateName: 'Simple', documentId: 'D-1', documentType: 'doc', submittedBy: 'sub' });
    await engine.submit({ templateName: 'Other', documentId: 'I-1', documentType: 'invoice', submittedBy: 'sub' });

    const stats = await engine.getStatistics({ documentType: 'invoice' });
    expect(stats.total).toBe(1);
    expect(stats.byStatus.pending).toBe(1);
    await engine.shutdown();
  });
});
