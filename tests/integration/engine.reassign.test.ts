import { describe, it, expect } from 'vitest';
import { ApprovalEngine, ApprovalForbiddenError } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

function makeEngine() {
  return new ApprovalEngine({
    adapter: new MemoryAdapter(),
    tenantId: 'reassign-tenant',
    escalationPollIntervalMs: 999999,
  });
}

const template: ApprovalTemplateConfig = {
  name: 'Two Step',
  documentType: 'doc',
  levels: [
    { level: 1, name: 'L1', mode: 'all', approvers: [{ type: 'user', userId: 'a' }, { type: 'user', userId: 'b' }] },
    { level: 2, name: 'L2', mode: 'any', approvers: [{ type: 'user', userId: 'c' }] },
  ],
};

async function submit(engine: ApprovalEngine, documentId: string) {
  await engine.defineTemplate(template);
  return engine.submit({ templateName: 'Two Step', documentId, documentType: 'doc', submittedBy: 'sub' });
}

describe('ApprovalEngine — reassign', () => {
  it('replaces a pending approver and lets the new approver act', async () => {
    const engine = makeEngine();
    const inst = await submit(engine, 'D-1');

    const events: string[] = [];
    engine.on('approval:reassigned', (e) => events.push(`${e.fromApprover}->${e.toApprover}`));

    const after = await engine.reassign(inst.id, { reassignedBy: 'admin', fromApprover: 'b', toApprover: 'b2', reason: 'on leave' });
    expect(after.levels[0]?.approverIds).toEqual(['a', 'b2']);
    expect(events).toEqual(['b->b2']);
    expect(after.auditLog.some((e) => e.action === 'reassigned')).toBe(true);

    // 'all' mode: a + the reassigned b2 must both approve.
    await engine.approve(inst.id, { approverId: 'a' });
    const done = await engine.approve(inst.id, { approverId: 'b2' });
    expect(done.currentLevel).toBe(2);
    await engine.shutdown();
  });

  it('rejects reassigning an approver who has already acted', async () => {
    const engine = makeEngine();
    const inst = await submit(engine, 'D-2');
    await engine.approve(inst.id, { approverId: 'a' });

    await expect(
      engine.reassign(inst.id, { reassignedBy: 'admin', fromApprover: 'a', toApprover: 'a2', reason: 'x' }),
    ).rejects.toThrow(ApprovalForbiddenError);
    await engine.shutdown();
  });

  it('rejects reassigning a user who is not an approver on the level', async () => {
    const engine = makeEngine();
    const inst = await submit(engine, 'D-3');
    await expect(
      engine.reassign(inst.id, { reassignedBy: 'admin', fromApprover: 'ghost', toApprover: 'x', reason: 'x' }),
    ).rejects.toThrow(/not an approver/);
    await engine.shutdown();
  });

  it('rejects reassigning onto an existing approver (no duplicates)', async () => {
    const engine = makeEngine();
    const inst = await submit(engine, 'D-4');
    await expect(
      engine.reassign(inst.id, { reassignedBy: 'admin', fromApprover: 'a', toApprover: 'b', reason: 'x' }),
    ).rejects.toThrow(/already an approver/);
    await engine.shutdown();
  });

  it('rejects reassigning to the same approver', async () => {
    const engine = makeEngine();
    const inst = await submit(engine, 'D-5');
    await expect(
      engine.reassign(inst.id, { reassignedBy: 'admin', fromApprover: 'a', toApprover: 'a', reason: 'x' }),
    ).rejects.toThrow(/themselves/);
    await engine.shutdown();
  });
});
