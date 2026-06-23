import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

const template: ApprovalTemplateConfig = {
  name: 'Audit',
  documentType: 'doc',
  levels: [
    { level: 1, name: 'L1', mode: 'any', approvers: [{ type: 'user', userId: 'a' }] },
    { level: 2, name: 'L2', mode: 'any', approvers: [{ type: 'user', userId: 'b' }] },
  ],
};

describe('audit log integrity', () => {
  it('records each action exactly once (no duplicate entries)', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter(), tenantId: 't', escalationPollIntervalMs: 999999 });
    await engine.defineTemplate(template);

    const inst = await engine.submit({ templateName: 'Audit', documentId: 'D-1', documentType: 'doc', submittedBy: 'sub' });
    await engine.approve(inst.id, { approverId: 'a', comment: 'ok' });
    await engine.delegate(inst.id, { fromApprover: 'b', toApprover: 'b2', reason: 'leave' });
    await engine.approve(inst.id, { approverId: 'b2' });

    const history = await engine.getHistory(inst.id);
    const counts = history.reduce<Record<string, number>>((acc, e) => {
      acc[e.action] = (acc[e.action] ?? 0) + 1;
      return acc;
    }, {});

    expect(counts).toEqual({ submitted: 1, approved: 2, delegated: 1 });
    expect(history).toHaveLength(4);
    await engine.shutdown();
  });
});
