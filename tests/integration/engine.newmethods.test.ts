/**
 * Tests for P2 new developer-facing APIs:
 * validateTemplate, canApprove, listTemplates, addComment,
 * resubmit, previewApprovalChain, bulkApprove, bulkReject, override
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import {
  ApprovalForbiddenError,
  ApprovalValidationError,
} from '../../src/errors.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

function makeEngine(tenantId = 'methods-tenant') {
  return new ApprovalEngine({ adapter: new MemoryAdapter(), tenantId, escalationPollIntervalMs: 999999 });
}

const simpleTemplate: ApprovalTemplateConfig = {
  name: 'Simple',
  documentType: 'doc',
  levels: [{ level: 1, name: 'Approver', approvers: [{ type: 'user', userId: 'approver1' }], mode: 'any' }],
};

const twoLevelTemplate: ApprovalTemplateConfig = {
  name: 'Two Level',
  documentType: 'doc',
  levels: [
    { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' },
    { level: 2, name: 'Finance', approvers: [{ type: 'user', userId: 'fin1' }], mode: 'any' },
  ],
};

// ─── listTemplates ────────────────────────────────────────────────────────────

describe('listTemplates', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(() => { engine = makeEngine(); });
  afterEach(() => engine.shutdown());

  it('returns empty array when no templates defined', async () => {
    const list = await engine.listTemplates();
    expect(list).toHaveLength(0);
  });

  it('returns all templates for the tenant', async () => {
    await engine.defineTemplate(simpleTemplate);
    await engine.defineTemplate(twoLevelTemplate);
    const list = await engine.listTemplates();
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.name)).toContain('Simple');
    expect(list.map((t) => t.name)).toContain('Two Level');
  });

  it('is isolated by tenant', async () => {
    const adapter = new MemoryAdapter();
    const engineA = new ApprovalEngine({ adapter, tenantId: 'tenantA', escalationPollIntervalMs: 999999 });
    const engineB = new ApprovalEngine({ adapter, tenantId: 'tenantB', escalationPollIntervalMs: 999999 });

    await engineA.defineTemplate(simpleTemplate);
    const listB = await engineB.listTemplates();
    expect(listB).toHaveLength(0);

    await engineA.shutdown();
    await engineB.shutdown();
  });
});

// ─── canApprove ───────────────────────────────────────────────────────────────

describe('canApprove', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(twoLevelTemplate); });
  afterEach(() => engine.shutdown());

  it('returns eligible=true for the current level approver', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'CA-001', documentType: 'doc', submittedBy: 'alice', data: {} });
    const result = await engine.canApprove(instance.id, 'mgr1');
    expect(result.eligible).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('returns not_an_approver for someone not in the approver list', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'CA-002', documentType: 'doc', submittedBy: 'alice', data: {} });
    const result = await engine.canApprove(instance.id, 'hacker');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('not_an_approver');
  });

  it('returns self_approval for the submitter', async () => {
    const engine2 = makeEngine('self-tenant');
    await engine2.defineTemplate({ name: 'Self', documentType: 'doc', levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'alice' }], mode: 'any' }] });
    const instance = await engine2.submit({ templateName: 'Self', documentId: 'CA-003', documentType: 'doc', submittedBy: 'alice', data: {} });
    const result = await engine2.canApprove(instance.id, 'alice');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('self_approval');
    await engine2.shutdown();
  });

  it('returns already_acted after the approver has approved', async () => {
    const engine3 = makeEngine('acted-tenant');
    await engine3.defineTemplate({ name: 'Multi', documentType: 'doc', levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }, { type: 'user', userId: 'mgr2' }], mode: 'all' }] });
    const instance = await engine3.submit({ templateName: 'Multi', documentId: 'CA-004', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine3.approve(instance.id, { approverId: 'mgr1' });
    const result = await engine3.canApprove(instance.id, 'mgr1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('already_acted');
    await engine3.shutdown();
  });

  it('returns wrong_status for a non-pending instance', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'CA-005', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.cancel(instance.id, { cancelledBy: 'alice', reason: 'test' });
    const result = await engine.canApprove(instance.id, 'mgr1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('wrong_status');
  });

  it('returns wrong_status for non-existent instance (never throws)', async () => {
    const result = await engine.canApprove('ghost-instance', 'mgr1');
    expect(result.eligible).toBe(false);
    expect(result.reason).toBe('wrong_status');
  });
});

// ─── addComment ───────────────────────────────────────────────────────────────

describe('addComment', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(twoLevelTemplate); });
  afterEach(() => engine.shutdown());

  it('appends a commented audit entry without changing status or level', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'COM-001', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.addComment(instance.id, { actorId: 'observer', comment: 'Looks good so far' });

    const updated = await engine.getInstance(instance.id);
    expect(updated.status).toBe('pending');
    expect(updated.currentLevel).toBe(1);

    const commentEntry = updated.auditLog.find((e) => e.action === 'commented');
    expect(commentEntry).toBeDefined();
    expect(commentEntry?.actorId).toBe('observer');
    expect(commentEntry?.comment).toBe('Looks good so far');
  });

  it('non-approvers can also comment', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'COM-002', documentType: 'doc', submittedBy: 'alice', data: {} });
    await expect(engine.addComment(instance.id, { actorId: 'any-user', comment: 'FYI' })).resolves.not.toThrow();
  });
});

// ─── resubmit ─────────────────────────────────────────────────────────────────

describe('resubmit', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    await engine.defineTemplate({
      ...twoLevelTemplate,
      conditions: [{ when: { field: 'amount', operator: '>', value: 10000 }, addLevels: [{ level: 3, name: 'CFO', approvers: [{ type: 'user', userId: 'cfo1' }], mode: 'any' }] }],
    });
  });
  afterEach(() => engine.shutdown());

  it('creates a new linked instance from a rejected one', async () => {
    const original = await engine.submit({ templateName: 'Two Level', documentId: 'RS-001', documentType: 'doc', submittedBy: 'alice', data: { amount: 5000 } });
    await engine.reject(original.id, { approverId: 'mgr1', reason: 'missing info' });

    const resubmitted = await engine.resubmit(original.id, { resubmittedBy: 'alice', reason: 'added invoices', updatedData: { notes: 'added' } });
    expect(resubmitted.parentInstanceId).toBe(original.id);
    expect(resubmitted.status).toBe('pending');
    expect(resubmitted.id).not.toBe(original.id);
  });

  it('merges updatedData with original data and re-evaluates conditions', async () => {
    const original = await engine.submit({ templateName: 'Two Level', documentId: 'RS-002', documentType: 'doc', submittedBy: 'alice', data: { amount: 5000 } });
    await engine.reject(original.id, { approverId: 'mgr1', reason: 'too low' });

    // Bump amount over 10000 to trigger the CFO condition
    const resubmitted = await engine.resubmit(original.id, { resubmittedBy: 'alice', updatedData: { amount: 15000 } });
    expect(resubmitted.levels).toHaveLength(3);
    expect(resubmitted.levels.find((l) => l.name === 'CFO')).toBeDefined();
  });

  it('emits approval:resubmitted event', async () => {
    const events: string[] = [];
    engine.on('approval:resubmitted', (p) => events.push(p.instanceId));

    const original = await engine.submit({ templateName: 'Two Level', documentId: 'RS-003', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.reject(original.id, { approverId: 'mgr1', reason: 'nope' });
    const resubmitted = await engine.resubmit(original.id, { resubmittedBy: 'alice' });

    expect(events).toContain(resubmitted.id);
  });

  it('throws FORBIDDEN when trying to resubmit a non-rejected instance', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'RS-004', documentType: 'doc', submittedBy: 'alice', data: {} });
    await expect(engine.resubmit(instance.id, { resubmittedBy: 'alice' })).rejects.toThrow(ApprovalForbiddenError);
  });
});

// ─── previewApprovalChain ─────────────────────────────────────────────────────

describe('previewApprovalChain', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    await engine.defineTemplate({
      name: 'Preview',
      documentType: 'doc',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' },
        { level: 2, name: 'Finance', approvers: [{ type: 'user', userId: 'fin1' }], mode: 'any' },
      ],
      conditions: [{ when: { field: 'amount', operator: '>', value: 10000 }, addLevels: [{ level: 3, name: 'CFO', approvers: [{ type: 'user', userId: 'cfo1' }], mode: 'any' }] }],
    });
  });
  afterEach(() => engine.shutdown());

  it('returns all base levels for data below condition threshold', async () => {
    const result = await engine.previewApprovalChain('Preview', { amount: 5000 }, 'alice');
    expect(result.levels).toHaveLength(2);
    expect(result.levels[0]?.resolvedApprovers).toContain('mgr1');
    expect(result.levels[1]?.resolvedApprovers).toContain('fin1');
  });

  it('includes conditional level when threshold is exceeded', async () => {
    const result = await engine.previewApprovalChain('Preview', { amount: 15000 }, 'alice');
    expect(result.levels).toHaveLength(3);
    expect(result.levels.find((l) => l.name === 'CFO')).toBeDefined();
    expect(result.conditionsApplied).toContain(0);
  });

  it('does not persist any instance', async () => {
    await engine.previewApprovalChain('Preview', { amount: 5000 }, 'alice');
    const pending = await engine.getPendingFor('mgr1');
    expect(pending.total).toBe(0);
  });
});

// ─── bulkApprove / bulkReject ─────────────────────────────────────────────────

describe('bulkApprove', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(simpleTemplate); });
  afterEach(() => engine.shutdown());

  it('approves multiple instances and returns succeeded list', async () => {
    const inst1 = await engine.submit({ templateName: 'Simple', documentId: 'B1', documentType: 'doc', submittedBy: 'alice', data: {} });
    const inst2 = await engine.submit({ templateName: 'Simple', documentId: 'B2', documentType: 'doc', submittedBy: 'alice', data: {} });
    const inst3 = await engine.submit({ templateName: 'Simple', documentId: 'B3', documentType: 'doc', submittedBy: 'alice', data: {} });

    const result = await engine.bulkApprove([inst1.id, inst2.id, inst3.id], { approverId: 'approver1' });
    expect(result.total).toBe(3);
    expect(result.succeeded).toHaveLength(3);
    expect(result.failed).toHaveLength(0);
    expect(result.succeeded.every((i) => i.status === 'approved')).toBe(true);
  });

  it('isolates failures — valid items succeed even when one fails', async () => {
    const inst1 = await engine.submit({ templateName: 'Simple', documentId: 'BF-1', documentType: 'doc', submittedBy: 'alice', data: {} });
    const inst2 = await engine.submit({ templateName: 'Simple', documentId: 'BF-2', documentType: 'doc', submittedBy: 'alice', data: {} });

    const result = await engine.bulkApprove([inst1.id, 'does-not-exist', inst2.id], { approverId: 'approver1' });
    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.instanceId).toBe('does-not-exist');
  });

  it('throws ApprovalValidationError when exceeding maxBulkItems', async () => {
    const engine2 = new ApprovalEngine({ adapter: new MemoryAdapter(), tenantId: 'x', escalationPollIntervalMs: 999999, maxBulkItems: 2 });
    await engine2.defineTemplate(simpleTemplate);
    await expect(engine2.bulkApprove(['a', 'b', 'c'], { approverId: 'approver1' })).rejects.toThrow(ApprovalValidationError);
    await engine2.shutdown();
  });
});

describe('bulkReject', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(simpleTemplate); });
  afterEach(() => engine.shutdown());

  it('rejects multiple instances and collects failures independently', async () => {
    const inst1 = await engine.submit({ templateName: 'Simple', documentId: 'BR-1', documentType: 'doc', submittedBy: 'alice', data: {} });
    const inst2 = await engine.submit({ templateName: 'Simple', documentId: 'BR-2', documentType: 'doc', submittedBy: 'alice', data: {} });

    const result = await engine.bulkReject([inst1.id, 'bad-id', inst2.id], { approverId: 'approver1', reason: 'mass reject' });
    expect(result.succeeded).toHaveLength(2);
    expect(result.failed).toHaveLength(1);
    expect(result.succeeded.every((i) => i.status === 'rejected')).toBe(true);
  });
});

// ─── override ─────────────────────────────────────────────────────────────────

describe('override', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); });
  afterEach(() => engine.shutdown());

  it('force-approves a pending instance when allowOverride=true', async () => {
    await engine.defineTemplate({ name: 'Overridable', documentType: 'doc', allowOverride: true, levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' }, { level: 2, name: 'L2', approvers: [{ type: 'user', userId: 'fin1' }], mode: 'any' }] });
    const instance = await engine.submit({ templateName: 'Overridable', documentId: 'OV-001', documentType: 'doc', submittedBy: 'alice', data: {} });

    const overridden = await engine.override(instance.id, { overriddenBy: 'super-admin', justification: 'Urgent — board approval' });
    expect(overridden.status).toBe('approved');

    const overrideEntry = overridden.auditLog.find((e) => e.action === 'overridden');
    expect(overrideEntry).toBeDefined();
    expect(overrideEntry?.actorId).toBe('super-admin');
    expect(overrideEntry?.reason).toBe('Urgent — board approval');
  });

  it('emits approval:overridden and approval:completed events', async () => {
    await engine.defineTemplate({ name: 'Overridable2', documentType: 'doc', allowOverride: true, levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' }] });
    const instance = await engine.submit({ templateName: 'Overridable2', documentId: 'OV-002', documentType: 'doc', submittedBy: 'alice', data: {} });

    const emittedEvents: string[] = [];
    engine.on('approval:overridden', () => emittedEvents.push('overridden'));
    engine.on('approval:completed', () => emittedEvents.push('completed'));

    await engine.override(instance.id, { overriddenBy: 'admin', justification: 'emergency' });
    expect(emittedEvents).toContain('overridden');
    expect(emittedEvents).toContain('completed');
  });

  it('throws FORBIDDEN when allowOverride is false (default)', async () => {
    await engine.defineTemplate({ name: 'NoOverride', documentType: 'doc', levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' }] });
    const instance = await engine.submit({ templateName: 'NoOverride', documentId: 'OV-003', documentType: 'doc', submittedBy: 'alice', data: {} });
    await expect(engine.override(instance.id, { overriddenBy: 'admin', justification: 'test' })).rejects.toThrow(ApprovalForbiddenError);
  });

  it('throws FORBIDDEN when overriddenBy is the submitter', async () => {
    await engine.defineTemplate({ name: 'Overridable3', documentType: 'doc', allowOverride: true, levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' }] });
    const instance = await engine.submit({ templateName: 'Overridable3', documentId: 'OV-004', documentType: 'doc', submittedBy: 'alice', data: {} });
    await expect(engine.override(instance.id, { overriddenBy: 'alice', justification: 'self override' })).rejects.toThrow(ApprovalForbiddenError);
  });
});

// ─── healthCheck ──────────────────────────────────────────────────────────────

describe('healthCheck', () => {
  it('returns healthy when adapter responds and no overdue instances', async () => {
    const engine = makeEngine();
    await engine.defineTemplate(simpleTemplate);
    const result = await engine.healthCheck();
    expect(result.status).toBe('healthy');
    expect(result.adapter).toBe('connected');
    expect(result.escalationRunning).toBe(true);
    await engine.shutdown();
  });

  it('escalationRunning is false after shutdown', async () => {
    const engine = makeEngine();
    await engine.shutdown();
    const result = await engine.healthCheck();
    expect(result.escalationRunning).toBe(false);
  });
});

// ─── getHistory ───────────────────────────────────────────────────────────────

describe('getHistory', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(twoLevelTemplate); });
  afterEach(() => engine.shutdown());

  it('returns the full audit log for an instance', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'HIS-001', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1', comment: 'LGTM' });

    const history = await engine.getHistory(instance.id);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some((e) => e.action === 'submitted')).toBe(true);
    expect(history.some((e) => e.action === 'approved')).toBe(true);
  });
});

// ─── queryInstances ────────────────────────────────────────────────────────────

describe('queryInstances', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    await engine.defineTemplate(simpleTemplate);
  });
  afterEach(() => engine.shutdown());

  it('filters by status', async () => {
    const i1 = await engine.submit({ templateName: 'Simple', documentId: 'Q1', documentType: 'doc', submittedBy: 'alice', data: {} });
    const i2 = await engine.submit({ templateName: 'Simple', documentId: 'Q2', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.cancel(i1.id, { cancelledBy: 'alice', reason: 'test' });

    const pending = await engine.queryInstances({ status: 'pending' });
    const cancelled = await engine.queryInstances({ status: 'cancelled' });

    expect(pending.items.every((i) => i.status === 'pending')).toBe(true);
    expect(cancelled.items.every((i) => i.status === 'cancelled')).toBe(true);
    void i2;
  });

  it('filters by submittedBy', async () => {
    await engine.submit({ templateName: 'Simple', documentId: 'Q3', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.submit({ templateName: 'Simple', documentId: 'Q4', documentType: 'doc', submittedBy: 'bob', data: {} });

    const aliceOnly = await engine.queryInstances({ submittedBy: 'alice' });
    expect(aliceOnly.items.every((i) => i.submittedBy === 'alice')).toBe(true);
  });
});
