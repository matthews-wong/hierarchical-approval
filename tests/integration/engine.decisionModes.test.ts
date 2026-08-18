import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

function makeEngine() {
  return new ApprovalEngine({
    adapter: new MemoryAdapter(),
    tenantId: 'modes-tenant',
    escalationPollIntervalMs: 999999,
  });
}

const quorumTemplate: ApprovalTemplateConfig = {
  name: 'Board Quorum',
  documentType: 'resolution',
  levels: [
    {
      level: 1,
      name: 'Board',
      mode: 'quorum',
      minApprovals: 2,
      approvers: [
        { type: 'user', userId: 'd1' },
        { type: 'user', userId: 'd2' },
        { type: 'user', userId: 'd3' },
      ],
    },
  ],
};

const weightedTemplate: ApprovalTemplateConfig = {
  name: 'Weighted Spend',
  documentType: 'spend',
  levels: [
    {
      level: 1,
      name: 'Exec Committee',
      mode: 'weighted',
      threshold: 3,
      weights: { cfo: 3, mgr: 1 },
      approvers: [
        { type: 'user', userId: 'cfo' },
        { type: 'user', userId: 'mgr' },
      ],
    },
  ],
};

describe('ApprovalEngine — quorum mode', () => {
  it('completes only after minApprovals distinct approvals', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(quorumTemplate);
    const inst = await engine.submit({ templateName: 'Board Quorum', documentId: 'R-1', documentType: 'resolution', submittedBy: 'sec' });

    const afterFirst = await engine.approve(inst.id, { approverId: 'd1' });
    expect(afterFirst.status).toBe('pending');

    const afterSecond = await engine.approve(inst.id, { approverId: 'd2' });
    expect(afterSecond.status).toBe('approved');
    await engine.shutdown();
  });

  it('rejects once the quorum becomes mathematically unreachable', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(quorumTemplate);
    const inst = await engine.submit({ templateName: 'Board Quorum', documentId: 'R-2', documentType: 'resolution', submittedBy: 'sec' });

    await engine.reject(inst.id, { approverId: 'd1', reason: 'no' });
    const afterSecond = await engine.reject(inst.id, { approverId: 'd2', reason: 'no' });
    // Only d3 remains → quorum of 2 impossible → instance rejected.
    expect(afterSecond.status).toBe('rejected');
    await engine.shutdown();
  });

  it('rejects an invalid quorum template at definition time', async () => {
    const engine = makeEngine();
    await expect(
      engine.defineTemplate({
        name: 'Bad Quorum',
        documentType: 'x',
        levels: [{ level: 1, name: 'L1', mode: 'quorum', approvers: [{ type: 'user', userId: 'a' }] }],
      }),
    ).rejects.toThrow(/minApprovals/);
    await engine.shutdown();
  });
});

describe('ApprovalEngine — weighted mode', () => {
  it('approves when a single high-weight approver meets the threshold', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(weightedTemplate);
    const inst = await engine.submit({ templateName: 'Weighted Spend', documentId: 'S-1', documentType: 'spend', submittedBy: 'req' });

    const result = await engine.approve(inst.id, { approverId: 'cfo' });
    expect(result.status).toBe('approved');
    await engine.shutdown();
  });

  it('does not approve on a low-weight vote alone', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(weightedTemplate);
    const inst = await engine.submit({ templateName: 'Weighted Spend', documentId: 'S-2', documentType: 'spend', submittedBy: 'req' });

    const result = await engine.approve(inst.id, { approverId: 'mgr' });
    expect(result.status).toBe('pending');
    await engine.shutdown();
  });

  it('rejects when the high-weight approver rejects and threshold is unreachable', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(weightedTemplate);
    const inst = await engine.submit({ templateName: 'Weighted Spend', documentId: 'S-3', documentType: 'spend', submittedBy: 'req' });

    const result = await engine.reject(inst.id, { approverId: 'cfo', reason: 'over budget' });
    expect(result.status).toBe('rejected');
    await engine.shutdown();
  });
});
