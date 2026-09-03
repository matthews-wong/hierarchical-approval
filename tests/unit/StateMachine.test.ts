import { describe, it, expect } from 'vitest';
import {
  assertStatus,
  assertApproverOnLevel,
  hasAlreadyActed,
  isLevelApproved,
  isLevelRejected,
} from '../../src/engine/StateMachine.js';
import { ApprovalError, ApprovalForbiddenError } from '../../src/errors.js';
import type { ApprovalInstance, ApprovalLevelInstance } from '../../src/types/index.js';

function makeLevel(
  mode: ApprovalLevelInstance['mode'],
  approverIds: string[],
  approvedBy: string[],
  rejectedBy: string[],
  extra: Partial<ApprovalLevelInstance> = {},
): ApprovalLevelInstance {
  return {
    level: 1,
    name: 'Test',
    mode,
    approverIds,
    approvedBy,
    rejectedBy,
    status: 'pending',
    ...extra,
  };
}

describe('isLevelApproved', () => {
  it('any — approved when at least one approves', () => {
    expect(isLevelApproved(makeLevel('any', ['a', 'b'], ['a'], []))).toBe(true);
    expect(isLevelApproved(makeLevel('any', ['a', 'b'], [], []))).toBe(false);
  });

  it('all — approved only when all approve', () => {
    expect(isLevelApproved(makeLevel('all', ['a', 'b'], ['a', 'b'], []))).toBe(true);
    expect(isLevelApproved(makeLevel('all', ['a', 'b'], ['a'], []))).toBe(false);
  });

  it('majority — approved when more than half approve', () => {
    expect(isLevelApproved(makeLevel('majority', ['a', 'b', 'c'], ['a', 'b'], []))).toBe(true);
    expect(isLevelApproved(makeLevel('majority', ['a', 'b', 'c'], ['a'], []))).toBe(false);
  });

  it('quorum — approved when minApprovals reached (2 of 4)', () => {
    expect(
      isLevelApproved(
        makeLevel('quorum', ['a', 'b', 'c', 'd'], ['a', 'b'], [], { minApprovals: 2 }),
      ),
    ).toBe(true);
    expect(
      isLevelApproved(makeLevel('quorum', ['a', 'b', 'c', 'd'], ['a'], [], { minApprovals: 2 })),
    ).toBe(false);
  });

  it('quorum — throws when minApprovals is invalid or exceeds approvers', () => {
    expect(() => isLevelApproved(makeLevel('quorum', ['a', 'b'], [], []))).toThrow(
      /positive integer/,
    );
    expect(() =>
      isLevelApproved(makeLevel('quorum', ['a', 'b'], [], [], { minApprovals: 3 })),
    ).toThrow(/only 2 approver/);
  });

  it('weighted — approved when cumulative approved weight meets threshold', () => {
    const weights = { cfo: 3, mgr: 1 };
    expect(
      isLevelApproved(
        makeLevel('weighted', ['cfo', 'mgr'], ['cfo'], [], { threshold: 3, weights }),
      ),
    ).toBe(true);
    expect(
      isLevelApproved(
        makeLevel('weighted', ['cfo', 'mgr'], ['mgr'], [], { threshold: 3, weights }),
      ),
    ).toBe(false);
  });

  it('weighted — defaults unlisted approvers to weight 1', () => {
    expect(
      isLevelApproved(makeLevel('weighted', ['a', 'b', 'c'], ['a', 'b'], [], { threshold: 2 })),
    ).toBe(true);
    expect(
      isLevelApproved(makeLevel('weighted', ['a', 'b', 'c'], ['a'], [], { threshold: 2 })),
    ).toBe(false);
  });

  it('weighted — throws when threshold is invalid or unreachable', () => {
    expect(() => isLevelApproved(makeLevel('weighted', ['a'], [], []))).toThrow(/positive number/);
    expect(() =>
      isLevelApproved(makeLevel('weighted', ['a', 'b'], [], [], { threshold: 99 })),
    ).toThrow(/total only/);
  });

  it('weighted — a zero weight is honoured, not treated as free approval', () => {
    // a has weight 0, b defaults to 1: total weight is 1.
    expect(
      isLevelApproved(
        makeLevel('weighted', ['a', 'b'], ['a'], [], { threshold: 1, weights: { a: 0 } }),
      ),
    ).toBe(false);
    expect(
      isLevelApproved(
        makeLevel('weighted', ['a', 'b'], ['a', 'b'], [], { threshold: 1, weights: { a: 0 } }),
      ),
    ).toBe(true);
  });

  it('weighted — negative weights fall back to weight 1', () => {
    expect(
      isLevelApproved(
        makeLevel('weighted', ['a', 'b'], ['a'], [], { threshold: 1, weights: { a: -5 } }),
      ),
    ).toBe(true);
    expect(
      isLevelApproved(
        makeLevel('weighted', ['a', 'b'], ['a'], [], { threshold: 2, weights: { a: -5 } }),
      ),
    ).toBe(false);
  });

  it('throws when the level has no approvers at all', () => {
    expect(() => isLevelApproved(makeLevel('any', [], [], []))).toThrow(/has no approvers/);
  });

  it('unknown mode throws — exhaustiveness guard', () => {
    const bogus = 'bogus' as unknown as ApprovalLevelInstance['mode'];
    expect(() => isLevelApproved(makeLevel(bogus, ['a'], [], []))).toThrow(
      /Unhandled approval mode: bogus/,
    );
  });
});

describe('isLevelRejected', () => {
  it('any — rejected only when all reject', () => {
    expect(isLevelRejected(makeLevel('any', ['a', 'b'], [], ['a', 'b']))).toBe(true);
    expect(isLevelRejected(makeLevel('any', ['a', 'b'], [], ['a']))).toBe(false);
  });

  it('all — rejected when any single approver rejects', () => {
    expect(isLevelRejected(makeLevel('all', ['a', 'b'], [], ['a']))).toBe(true);
    expect(isLevelRejected(makeLevel('all', ['a', 'b'], [], []))).toBe(false);
  });

  it('majority — rejected when majority rejects', () => {
    expect(isLevelRejected(makeLevel('majority', ['a', 'b', 'c'], [], ['a', 'b']))).toBe(true);
    expect(isLevelRejected(makeLevel('majority', ['a', 'b', 'c'], [], ['a']))).toBe(false);
  });

  it('quorum — rejected once quorum becomes unreachable (need 2 of 3)', () => {
    // 2 of 3: one rejection still leaves 2 possible approvals → not rejected.
    expect(
      isLevelRejected(makeLevel('quorum', ['a', 'b', 'c'], [], ['a'], { minApprovals: 2 })),
    ).toBe(false);
    // two rejections leave only 1 possible approval → quorum of 2 unreachable.
    expect(
      isLevelRejected(makeLevel('quorum', ['a', 'b', 'c'], [], ['a', 'b'], { minApprovals: 2 })),
    ).toBe(true);
  });

  it('weighted — rejected once achievable weight drops below threshold', () => {
    const weights = { cfo: 3, mgr: 1 };
    // total weight 4, threshold 3; rejecting mgr (1) leaves 3 → still reachable.
    expect(
      isLevelRejected(
        makeLevel('weighted', ['cfo', 'mgr'], [], ['mgr'], { threshold: 3, weights }),
      ),
    ).toBe(false);
    // rejecting cfo (3) leaves only 1 → threshold 3 unreachable.
    expect(
      isLevelRejected(
        makeLevel('weighted', ['cfo', 'mgr'], [], ['cfo'], { threshold: 3, weights }),
      ),
    ).toBe(true);
  });

  it('weighted — rejecting a zero-weight approver cannot make the level unreachable', () => {
    // a has weight 0, b defaults to 1: total weight 1, threshold 1.
    expect(
      isLevelRejected(
        makeLevel('weighted', ['a', 'b'], [], ['a'], { threshold: 1, weights: { a: 0 } }),
      ),
    ).toBe(false);
    expect(
      isLevelRejected(
        makeLevel('weighted', ['a', 'b'], [], ['b'], { threshold: 1, weights: { a: 0 } }),
      ),
    ).toBe(true);
  });

  it('throws when the level has no approvers at all', () => {
    expect(() => isLevelRejected(makeLevel('any', [], [], []))).toThrow(/has no approvers/);
  });

  it('unknown mode throws — exhaustiveness guard', () => {
    const bogus = 'bogus' as unknown as ApprovalLevelInstance['mode'];
    expect(() => isLevelRejected(makeLevel(bogus, ['a'], [], []))).toThrow(
      /Unhandled approval mode: bogus/,
    );
  });
});

describe('state guards', () => {
  function makeInstance(overrides: Partial<ApprovalInstance> = {}): ApprovalInstance {
    const now = new Date('2026-01-01T00:00:00.000Z');
    return {
      id: 'inst-1',
      tenantId: 't1',
      templateId: 'tpl-1',
      templateName: 'purchase',
      documentId: 'doc-1',
      documentType: 'po',
      submittedBy: 'alice',
      status: 'pending',
      currentLevel: 1,
      version: 1,
      levels: [makeLevel('any', ['alice', 'bob'], [], [])],
      auditLog: [],
      data: {},
      metadata: {},
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  it('assertStatus passes on a matching status', () => {
    expect(() => assertStatus(makeInstance(), 'pending')).not.toThrow();
  });

  it('assertStatus throws ApprovalError INVALID_STATUS naming both statuses', () => {
    const error = (): void => assertStatus(makeInstance({ status: 'approved' }), 'pending');
    expect(error).toThrow(ApprovalError);
    expect(error).toThrow(/Expected instance status "pending" but got "approved"/);
    expect(error).toThrow(expect.objectContaining({ code: 'INVALID_STATUS' }));
  });

  it('assertApproverOnLevel accepts a listed approver and rejects a stranger', () => {
    const level = makeLevel('any', ['alice', 'bob'], [], []);
    expect(() => assertApproverOnLevel(level, 'alice')).not.toThrow();
    const error = (): void => assertApproverOnLevel(level, 'carol');
    expect(error).toThrow(ApprovalForbiddenError);
    expect(error).toThrow(/User "carol" is not an approver for level 1/);
  });

  it('hasAlreadyActed is true for approvers in approvedBy or rejectedBy', () => {
    const level = makeLevel('any', ['alice', 'bob', 'carol'], ['alice'], ['bob']);
    expect(hasAlreadyActed(level, 'alice')).toBe(true);
    expect(hasAlreadyActed(level, 'bob')).toBe(true);
    expect(hasAlreadyActed(level, 'carol')).toBe(false);
  });
});
