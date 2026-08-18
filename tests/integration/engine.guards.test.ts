/**
 * Guards & bug-fix regression tests.
 * Covers: P0 silent bugs and P1 validation guards.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import {
  ApprovalValidationError,
  ApprovalForbiddenError,
  ApprovalTemplateNotFoundError,
} from '../../src/errors.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

function makeEngine(tenantId = 'guard-tenant') {
  return new ApprovalEngine({ adapter: new MemoryAdapter(), tenantId, escalationPollIntervalMs: 999999 });
}

const twoLevelTemplate: ApprovalTemplateConfig = {
  name: 'Two Level',
  documentType: 'doc',
  levels: [
    { level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }], mode: 'any' },
    { level: 2, name: 'L2', approvers: [{ type: 'user', userId: 'fin1' }], mode: 'any' },
  ],
};

// ─── P0 Bug 1: cancelled/rejected instance is NOT returned as idempotent ─────

describe('P0 Bug 1 — idempotency skips terminal instances', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(twoLevelTemplate); });
  afterEach(() => engine.shutdown());

  it('creates a fresh instance after the existing one is cancelled', async () => {
    const first = await engine.submit({ templateName: 'Two Level', documentId: 'DOC-C1', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.cancel(first.id, { cancelledBy: 'alice', reason: 'test' });

    const second = await engine.submit({ templateName: 'Two Level', documentId: 'DOC-C1', documentType: 'doc', submittedBy: 'alice', data: {} });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
  });

  it('creates a fresh instance after the existing one is rejected', async () => {
    const first = await engine.submit({ templateName: 'Two Level', documentId: 'DOC-R1', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.reject(first.id, { approverId: 'mgr1', reason: 'nope' });

    const second = await engine.submit({ templateName: 'Two Level', documentId: 'DOC-R1', documentType: 'doc', submittedBy: 'alice', data: {} });
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');
  });

  it('still returns the active instance when it is pending (normal idempotency)', async () => {
    const first = await engine.submit({ templateName: 'Two Level', documentId: 'DOC-I1', documentType: 'doc', submittedBy: 'alice', data: {} });
    const second = await engine.submit({ templateName: 'Two Level', documentId: 'DOC-I1', documentType: 'doc', submittedBy: 'alice', data: {} });
    expect(second.id).toBe(first.id);
  });
});

// ─── P1 Guard 5: documentType is included in idempotency key ─────────────────

describe('P1 Guard 5 — documentType is part of idempotency key', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    await engine.defineTemplate({ name: 'TypeA', documentType: 'invoice', levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }] });
    await engine.defineTemplate({ name: 'TypeB', documentType: 'expense', levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }] });
  });
  afterEach(() => engine.shutdown());

  it('same documentId with different documentType creates two distinct instances', async () => {
    const a = await engine.submit({ templateName: 'TypeA', documentId: 'DOC-001', documentType: 'invoice', submittedBy: 'alice', data: {} });
    const b = await engine.submit({ templateName: 'TypeB', documentId: 'DOC-001', documentType: 'expense', submittedBy: 'alice', data: {} });
    expect(a.id).not.toBe(b.id);
  });
});

// ─── P0 Bug 6: delegate-after-acting is forbidden ────────────────────────────

describe('P0 Bug 6 — delegate-after-acting', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(twoLevelTemplate); });
  afterEach(() => engine.shutdown());

  it('throws FORBIDDEN when approver delegates after approving', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'DA-001', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1' });
    // Now at level 2 — mgr1 already approved; trying to delegate from level 1 should also be caught
    // Let's test on a fresh instance
    const instance2 = await engine.submit({ templateName: 'Two Level', documentId: 'DA-002', documentType: 'doc', submittedBy: 'alice', data: {} });

    // Manually create a situation: multi-approver level
    const engine2 = makeEngine('multi-tenant');
    await engine2.defineTemplate({
      name: 'Multi',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'mgr1' }, { type: 'user', userId: 'mgr2' }], mode: 'all' }],
    });
    const inst = await engine2.submit({ templateName: 'Multi', documentId: 'DA-003', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine2.approve(inst.id, { approverId: 'mgr1' });
    await expect(engine2.delegate(inst.id, { fromApprover: 'mgr1', toApprover: 'mgr3', reason: 'already acted' }))
      .rejects.toThrow(ApprovalForbiddenError);
    await engine2.shutdown();

    // Cleanup
    void instance2;
  });
});

// ─── P1 Guard 1: zero-level template ─────────────────────────────────────────

describe('P1 Guard 1 — zero active levels after condition evaluation', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    // Template with only one level, plus a condition that skips it
    await engine.defineTemplate({
      name: 'Collapsible',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
      conditions: [{ when: { field: 'skipAll', operator: '==', value: true }, skipLevels: [1] }],
    });
  });
  afterEach(() => engine.shutdown());

  it('throws ApprovalValidationError when all levels are skipped by conditions', async () => {
    await expect(engine.submit({ templateName: 'Collapsible', documentId: 'ZL-001', documentType: 'doc', submittedBy: 'alice', data: { skipAll: true } }))
      .rejects.toThrow(ApprovalValidationError);
  });

  it('succeeds when conditions do not skip all levels', async () => {
    const instance = await engine.submit({ templateName: 'Collapsible', documentId: 'ZL-002', documentType: 'doc', submittedBy: 'alice', data: { skipAll: false } });
    expect(instance.status).toBe('pending');
  });
});

// ─── P1 Guard 2: duplicate level numbers ─────────────────────────────────────

describe('P1 Guard 2 — duplicate level numbers after condition merge', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => {
    engine = makeEngine();
    // Template with static level 1, and a condition that tries to add another level 1
    await engine.defineTemplate({
      name: 'DupLevel',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
      conditions: [{
        when: { field: 'dup', operator: '==', value: true },
        // Intentionally conflicts with static level 1 — validator should have blocked this,
        // but submit also guards in case it slips through (e.g. via direct adapter writes)
        addLevels: [{ level: 2, name: 'L2', approvers: [{ type: 'user', userId: 'u2' }], mode: 'any' },
                    { level: 2, name: 'L2-dup', approvers: [{ type: 'user', userId: 'u3' }], mode: 'any' }],
      }],
    });
  });
  afterEach(() => engine.shutdown());

  it('throws ApprovalValidationError when addLevels produces duplicate level numbers', async () => {
    await expect(engine.submit({ templateName: 'DupLevel', documentId: 'DL-001', documentType: 'doc', submittedBy: 'alice', data: { dup: true } }))
      .rejects.toThrow(ApprovalValidationError);
  });
});

// ─── P1 Guard 3: returnTo='previous' at level 1 throws ───────────────────────

describe('P1 Guard 3 — returnTo=previous at first level', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(twoLevelTemplate); });
  afterEach(() => engine.shutdown());

  it('throws ApprovalValidationError instead of silently rejecting', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'RP-001', documentType: 'doc', submittedBy: 'alice', data: {} });
    await expect(engine.reject(instance.id, { approverId: 'mgr1', reason: 'bad', returnTo: 'previous' }))
      .rejects.toThrow(ApprovalValidationError);
  });

  it('still succeeds with returnTo=previous at level 2', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'RP-002', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.approve(instance.id, { approverId: 'mgr1' });
    const remanded = await engine.reject(instance.id, { approverId: 'fin1', reason: 'bad', returnTo: 'previous' });
    expect(remanded.status).toBe('pending');
    expect(remanded.currentLevel).toBe(1);
  });
});

// ─── P1 Guard 4: duplicate template name ─────────────────────────────────────

describe('P1 Guard 4 — duplicate template name', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(twoLevelTemplate); });
  afterEach(() => engine.shutdown());

  it('throws ApprovalValidationError when re-defining an existing template name', async () => {
    await expect(engine.defineTemplate(twoLevelTemplate)).rejects.toThrow(ApprovalValidationError);
  });

  it('a different tenant can define a template with the same name', async () => {
    const engineB = makeEngine('other-tenant');
    await expect(engineB.defineTemplate(twoLevelTemplate)).resolves.toBeTruthy();
    await engineB.shutdown();
  });
});

// ─── P0 Bug 4 + templateSnapshot ─────────────────────────────────────────────

describe('P0 Bug 4 — templateSnapshot captured at submit time', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); });
  afterEach(() => engine.shutdown());

  it('instance carries templateSnapshot with escalation config', async () => {
    await engine.defineTemplate({
      name: 'Escal',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any', escalationAfterDays: 3 }],
      escalation: { escalateTo: { type: 'user', userId: 'escalation-user' } },
    });
    const instance = await engine.submit({ templateName: 'Escal', documentId: 'SNAP-001', documentType: 'doc', submittedBy: 'alice', data: {} });
    expect(instance.templateSnapshot).toBeDefined();
    expect(instance.templateSnapshot?.escalation?.escalateTo).toMatchObject({ type: 'user', userId: 'escalation-user' });
  });

  it('instance carries templateSnapshot with slaDeadlineDays', async () => {
    await engine.defineTemplate({
      name: 'SLATemplate',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
      slaDeadlineDays: 5,
    });
    const instance = await engine.submit({ templateName: 'SLATemplate', documentId: 'SNAP-002', documentType: 'doc', submittedBy: 'alice', data: {} });
    expect(instance.templateSnapshot?.slaDeadlineDays).toBe(5);
    expect(instance.slaDeadlineAt).toBeDefined();
  });
});

// ─── P0 Bug 5: delegatedUntil stored ─────────────────────────────────────────

describe('P0 Bug 5 — delegatedUntil is stored on level instance', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(async () => { engine = makeEngine(); await engine.defineTemplate(twoLevelTemplate); });
  afterEach(() => engine.shutdown());

  it('stores delegatedUntil, delegatedFrom, and delegatedTo on the level', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'DU-001', documentType: 'doc', submittedBy: 'alice', data: {} });
    const until = new Date(Date.now() + 86_400_000);
    await engine.delegate(instance.id, { fromApprover: 'mgr1', toApprover: 'mgr2', reason: 'on leave', until });

    const updated = await engine.getInstance(instance.id);
    const level1 = updated.levels.find((l) => l.level === 1)!;
    expect(level1.delegatedTo).toBe('mgr2');
    expect(level1.delegatedFrom).toBe('mgr1');
    expect(level1.delegatedUntil).toBeDefined();
  });

  it('delegate without until does not set delegatedUntil', async () => {
    const instance = await engine.submit({ templateName: 'Two Level', documentId: 'DU-002', documentType: 'doc', submittedBy: 'alice', data: {} });
    await engine.delegate(instance.id, { fromApprover: 'mgr1', toApprover: 'mgr2', reason: 'permanent' });

    const updated = await engine.getInstance(instance.id);
    const level1 = updated.levels.find((l) => l.level === 1)!;
    expect(level1.delegatedUntil).toBeUndefined();
  });
});

// ─── validateTemplate — synchronous preflight checks ─────────────────────────

describe('validateTemplate', () => {
  let engine: ReturnType<typeof makeEngine>;

  beforeEach(() => { engine = makeEngine(); });
  afterEach(() => engine.shutdown());

  it('returns valid for a well-formed template', () => {
    const result = engine.validateTemplate({
      name: 'Good',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('errors when levels array is empty', () => {
    const result = engine.validateTemplate({ name: 'Bad', documentType: 'doc', levels: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'levels')).toBe(true);
  });

  it('errors when a level has no approvers', () => {
    const result = engine.validateTemplate({
      name: 'Bad2',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [], mode: 'any' }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.startsWith('levels[0]'))).toBe(true);
  });

  it('errors on duplicate level numbers', () => {
    const result = engine.validateTemplate({
      name: 'Dup',
      documentType: 'doc',
      levels: [
        { level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' },
        { level: 1, name: 'L1-dup', approvers: [{ type: 'user', userId: 'u2' }], mode: 'any' },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Duplicate'))).toBe(true);
  });

  it('errors when escalationAfterDays is zero or negative', () => {
    const result = engine.validateTemplate({
      name: 'BadEscal',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any', escalationAfterDays: 0 }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('escalationAfterDays'))).toBe(true);
  });

  it('defineTemplate throws when validateTemplate returns errors', async () => {
    await expect(engine.defineTemplate({ name: 'Fail', documentType: 'doc', levels: [] }))
      .rejects.toThrow(ApprovalValidationError);
  });
});

// ─── StateMachine: empty approver guard ──────────────────────────────────────

describe('StateMachine — empty approver guard', () => {
  it('isLevelApproved throws ApprovalValidationError when approverIds is empty', async () => {
    const { isLevelApproved } = await import('../../src/engine/StateMachine.js');
    const level = { level: 1, name: 'L1', mode: 'all' as const, approverIds: [], approvedBy: [], rejectedBy: [], status: 'pending' as const, approverConfigs: [] };
    expect(() => isLevelApproved(level)).toThrow(ApprovalValidationError);
  });

  it('isLevelRejected throws ApprovalValidationError when approverIds is empty', async () => {
    const { isLevelRejected } = await import('../../src/engine/StateMachine.js');
    const level = { level: 1, name: 'L1', mode: 'any' as const, approverIds: [], approvedBy: [], rejectedBy: [], status: 'pending' as const, approverConfigs: [] };
    expect(() => isLevelRejected(level)).toThrow(ApprovalValidationError);
  });
});

// ─── ApprovalTemplateNotFoundError on missing template ────────────────────────

describe('template not found', () => {
  it('throws ApprovalTemplateNotFoundError when accessing a non-existent template', async () => {
    const engine = makeEngine();
    await expect(engine.getTemplate('ghost')).rejects.toThrow(ApprovalTemplateNotFoundError);
    await engine.shutdown();
  });
});
