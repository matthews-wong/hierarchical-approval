import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApprovalEngine, ApprovalError, ApprovalForbiddenError, ApprovalConflictError } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

function makeEngine(tenantId = 'test-tenant') {
  return new ApprovalEngine({
    adapter: new MemoryAdapter(),
    tenantId,
    escalationPollIntervalMs: 999999,
  });
}

const poTemplate: ApprovalTemplateConfig = {
  name: 'Purchase Order',
  documentType: 'purchase_order',
  levels: [
    {
      level: 1,
      name: 'Line Manager',
      approvers: [{ type: 'user', userId: 'manager1' }],
      mode: 'any',
    },
    {
      level: 2,
      name: 'Finance',
      approvers: [{ type: 'user', userId: 'finance1' }],
      mode: 'any',
    },
  ],
};

describe('ApprovalEngine — submit', () => {
  it('creates a pending instance with first level approvers set', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(poTemplate);
    const instance = await engine.submit({
      templateName: 'Purchase Order',
      documentId: 'PO-001',
      documentType: 'purchase_order',
      submittedBy: 'alice',
      data: { amount: 5000 },
    });

    expect(instance.status).toBe('pending');
    expect(instance.currentLevel).toBe(1);
    expect(instance.tenantId).toBe('test-tenant');
    expect(instance.version).toBe(1);
    expect(instance.idempotencyKey).toBeTruthy();
    expect(instance.levels[0]?.approverIds).toContain('manager1');
    expect(instance.levels[1]?.status).toBe('waiting');
    expect(instance.auditLog[0]?.action).toBe('submitted');
    engine.shutdown();
  });

  it('returns the same instance on idempotent re-submit', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(poTemplate);

    const first = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-IDEM', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    const second = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-IDEM', documentType: 'purchase_order', submittedBy: 'alice', data: {} });

    expect(first.id).toBe(second.id);
    engine.shutdown();
  });

  it('applies condition rules to add levels', async () => {
    const engine = makeEngine();
    await engine.defineTemplate({
      ...poTemplate,
      conditions: [
        {
          when: { field: 'amount', operator: '>', value: 10000 },
          addLevels: [{ level: 3, name: 'CFO', approvers: [{ type: 'user', userId: 'cfo' }], mode: 'any' }],
        },
      ],
    });

    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-002', documentType: 'purchase_order', submittedBy: 'alice', data: { amount: 15000 } });
    expect(instance.levels).toHaveLength(3);
    expect(instance.levels[2]?.name).toBe('CFO');
    engine.shutdown();
  });

  it('stores tenantId on the instance', async () => {
    const engine = makeEngine('acme-corp');
    await engine.defineTemplate(poTemplate);
    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-T1', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    expect(instance.tenantId).toBe('acme-corp');
    engine.shutdown();
  });
});

describe('ApprovalEngine — tenant isolation', () => {
  it('two engines with different tenantIds cannot see each other\'s instances', async () => {
    const adapter = new MemoryAdapter();
    const engineA = new ApprovalEngine({ adapter, tenantId: 'tenant-a', escalationPollIntervalMs: 999999 });
    const engineB = new ApprovalEngine({ adapter, tenantId: 'tenant-b', escalationPollIntervalMs: 999999 });

    await engineA.defineTemplate(poTemplate);
    await engineB.defineTemplate(poTemplate);

    const instanceA = await engineA.submit({ templateName: 'Purchase Order', documentId: 'PO-A1', documentType: 'purchase_order', submittedBy: 'alice', data: {} });

    await expect(engineB.getInstance(instanceA.id)).rejects.toThrow('not found');

    engineA.shutdown();
    engineB.shutdown();
  });
});

describe('ApprovalEngine — approve', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    await engine.defineTemplate(poTemplate);
  });

  it('advances to the next level after level-1 is approved', async () => {
    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-003', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    const updated = await engine.approve(instance.id, { approverId: 'manager1' });

    expect(updated.currentLevel).toBe(2);
    expect(updated.status).toBe('pending');
    expect(updated.levels[1]?.status).toBe('pending');
    expect(updated.levels[1]?.approverIds).toContain('finance1');
  });

  it('marks the instance approved after the final level', async () => {
    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-004', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    await engine.approve(instance.id, { approverId: 'manager1' });
    const done = await engine.approve(instance.id, { approverId: 'finance1' });
    expect(done.status).toBe('approved');
  });

  it('throws FORBIDDEN when a non-approver tries to approve', async () => {
    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-005', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    await expect(engine.approve(instance.id, { approverId: 'hacker' })).rejects.toThrow(ApprovalForbiddenError);
  });

  it('throws when approving twice', async () => {
    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-006', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    await engine.approve(instance.id, { approverId: 'manager1' });
    await expect(engine.approve(instance.id, { approverId: 'manager1' })).rejects.toThrow(ApprovalError);
  });

  it('records SOX audit fields when auditCtx is provided', async () => {
    const instance = await engine.submit(
      { templateName: 'Purchase Order', documentId: 'PO-AUDIT', documentType: 'purchase_order', submittedBy: 'alice', data: {} },
      { actorIp: '10.0.0.1', actorRole: 'employee', traceId: 'trace-abc' },
    );
    const updated = await engine.approve(instance.id, { approverId: 'manager1' }, { actorIp: '10.0.0.2', actorRole: 'manager', traceId: 'trace-xyz' });
    const approveEntry = updated.auditLog.find((e) => e.action === 'approved');
    expect(approveEntry?.actorIp).toBe('10.0.0.2');
    expect(approveEntry?.actorRole).toBe('manager');
    expect(approveEntry?.traceId).toBe('trace-xyz');
    expect(approveEntry?.oldValue).toBeDefined();
    expect(approveEntry?.newValue).toBeDefined();
  });

  afterEach(() => engine.shutdown());
});

describe('ApprovalEngine — self-approval prevention', () => {
  it('throws FORBIDDEN when submitter tries to approve their own request', async () => {
    const engine = makeEngine();
    await engine.defineTemplate({
      name: 'Self Test',
      documentType: 'self',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'alice' }], mode: 'any' }],
    });

    const instance = await engine.submit({ templateName: 'Self Test', documentId: 'SELF-001', documentType: 'self', submittedBy: 'alice', data: {} });
    await expect(engine.approve(instance.id, { approverId: 'alice' })).rejects.toThrow(ApprovalForbiddenError);
    engine.shutdown();
  });

  it('throws FORBIDDEN when submitter tries to reject their own request', async () => {
    const engine = makeEngine();
    await engine.defineTemplate({
      name: 'Self Test 2',
      documentType: 'self2',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'alice' }], mode: 'any' }],
    });

    const instance = await engine.submit({ templateName: 'Self Test 2', documentId: 'SELF-002', documentType: 'self2', submittedBy: 'alice', data: {} });
    await expect(engine.reject(instance.id, { approverId: 'alice', reason: 'test' })).rejects.toThrow(ApprovalForbiddenError);
    engine.shutdown();
  });
});

describe('ApprovalEngine — reject', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    await engine.defineTemplate(poTemplate);
  });

  it('marks instance rejected', async () => {
    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-007', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    const rejected = await engine.reject(instance.id, { approverId: 'manager1', reason: 'Over budget' });
    expect(rejected.status).toBe('rejected');
  });

  it('remands to previous level when returnTo=previous', async () => {
    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-008', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    await engine.approve(instance.id, { approverId: 'manager1' });
    const remanded = await engine.reject(instance.id, { approverId: 'finance1', reason: 'Missing invoice', returnTo: 'previous' });
    expect(remanded.status).toBe('pending');
    expect(remanded.currentLevel).toBe(1);
  });

  afterEach(() => engine.shutdown());
});

describe('ApprovalEngine — delegate', () => {
  it('swaps the approver and prevents self-delegation', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(poTemplate);

    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-009', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    await engine.delegate(instance.id, { fromApprover: 'manager1', toApprover: 'manager2', reason: 'On leave' });

    const approvers = await engine.getCurrentApprovers(instance.id);
    expect(approvers).toContain('manager2');
    expect(approvers).not.toContain('manager1');

    await expect(engine.delegate(instance.id, { fromApprover: 'manager2', toApprover: 'manager2', reason: 'test' })).rejects.toThrow(ApprovalForbiddenError);
    engine.shutdown();
  });
});

describe('ApprovalEngine — cancel', () => {
  it('cancels a pending instance', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(poTemplate);
    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-010', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    const cancelled = await engine.cancel(instance.id, { cancelledBy: 'alice', reason: 'No longer needed' });
    expect(cancelled.status).toBe('cancelled');
    engine.shutdown();
  });

  it('throws when cancelling an approved instance', async () => {
    const engine = makeEngine();
    await engine.defineTemplate({ name: 'Simple', documentType: 'simple', levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }] });
    const instance = await engine.submit({ templateName: 'Simple', documentId: 'DOC-001', documentType: 'simple', submittedBy: 'alice', data: {} });
    await engine.approve(instance.id, { approverId: 'u1' });
    await expect(engine.cancel(instance.id, { cancelledBy: 'alice', reason: 'Too late' })).rejects.toThrow(ApprovalError);
    engine.shutdown();
  });
});

describe('ApprovalEngine — optimistic locking', () => {
  it('MemoryAdapter throws ApprovalConflictError on version mismatch', async () => {
    const adapter = new MemoryAdapter();
    const engine = new ApprovalEngine({ adapter, tenantId: 'test', escalationPollIntervalMs: 999999 });
    await engine.defineTemplate(poTemplate);

    const instance = await engine.submit({ templateName: 'Purchase Order', documentId: 'LOCK-001', documentType: 'purchase_order', submittedBy: 'alice', data: {} });

    // Simulate stale version
    const stale = { ...instance, version: 999 };
    await expect(adapter.updateInstance(stale, 999)).rejects.toThrow(ApprovalConflictError);
    engine.shutdown();
  });
});

describe('ApprovalEngine — pagination', () => {
  it('getPendingFor returns paginated results', async () => {
    const engine = makeEngine();
    await engine.defineTemplate({ name: 'Simple', documentType: 'simple', levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' }] });

    await engine.submit({ templateName: 'Simple', documentId: 'P1', documentType: 'simple', submittedBy: 'alice', data: {} });
    await engine.submit({ templateName: 'Simple', documentId: 'P2', documentType: 'simple', submittedBy: 'alice', data: {} });
    await engine.submit({ templateName: 'Simple', documentId: 'P3', documentType: 'simple', submittedBy: 'alice', data: {} });

    const page1 = await engine.getPendingFor('mgr', { limit: 2, offset: 0 });
    expect(page1.total).toBe(3);
    expect(page1.items).toHaveLength(2);

    const page2 = await engine.getPendingFor('mgr', { limit: 2, offset: 2 });
    expect(page2.items).toHaveLength(1);
    engine.shutdown();
  });
});

describe('ApprovalEngine — events', () => {
  it('emits approval:submitted on submit', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(poTemplate);
    const events: string[] = [];
    engine.on('approval:submitted', () => events.push('submitted'));
    await engine.submit({ templateName: 'Purchase Order', documentId: 'PO-EVT-001', documentType: 'purchase_order', submittedBy: 'alice', data: {} });
    expect(events).toContain('submitted');
    engine.shutdown();
  });

  it('emits approval:completed on final approval', async () => {
    const engine = makeEngine();
    await engine.defineTemplate({ name: 'Single Level', documentType: 'single', levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' }] });
    let completed = false;
    engine.on('approval:completed', () => { completed = true; });
    const instance = await engine.submit({ templateName: 'Single Level', documentId: 'EVT-001', documentType: 'single', submittedBy: 'alice', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr' });
    expect(completed).toBe(true);
    engine.shutdown();
  });
});

describe('ApprovalEngine — dynamic resolvers', () => {
  it('resolves approvers using a registered resolver function', async () => {
    const engine = makeEngine();
    engine.registerResolver('directManager', () => 'resolved-manager');
    await engine.defineTemplate({ name: 'Dynamic Template', documentType: 'dynamic', levels: [{ level: 1, name: 'Manager', approvers: [{ type: 'dynamic', resolver: 'directManager' }], mode: 'any' }] });
    const instance = await engine.submit({ templateName: 'Dynamic Template', documentId: 'DYN-001', documentType: 'dynamic', submittedBy: 'alice', data: {} });
    expect(instance.levels[0]?.approverIds).toContain('resolved-manager');
    engine.shutdown();
  });
});

describe('ApprovalEngine — typed errors', () => {
  it('errors have correct class types for instanceof checks', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(poTemplate);

    try {
      await engine.getInstance('non-existent-id');
      expect.fail('should have thrown');
    } catch (err) {
      const { ApprovalNotFoundError } = await import('../../src/errors.js');
      expect(err).toBeInstanceOf(ApprovalNotFoundError);
      expect((err as { code: string }).code).toBe('NOT_FOUND');
    }
    engine.shutdown();
  });
});
