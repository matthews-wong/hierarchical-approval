import { describe, it, expect } from 'vitest';
import { isLevelApproved, isLevelRejected } from '../../src/engine/StateMachine.js';
import type { ApprovalLevelInstance } from '../../src/types/index.js';

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
    expect(isLevelApproved(makeLevel('quorum', ['a', 'b', 'c', 'd'], ['a', 'b'], [], { minApprovals: 2 }))).toBe(true);
    expect(isLevelApproved(makeLevel('quorum', ['a', 'b', 'c', 'd'], ['a'], [], { minApprovals: 2 }))).toBe(false);
  });

  it('quorum — throws when minApprovals is invalid or exceeds approvers', () => {
    expect(() => isLevelApproved(makeLevel('quorum', ['a', 'b'], [], []))).toThrow(/positive integer/);
    expect(() => isLevelApproved(makeLevel('quorum', ['a', 'b'], [], [], { minApprovals: 3 }))).toThrow(/only 2 approver/);
  });

  it('weighted — approved when cumulative approved weight meets threshold', () => {
    const weights = { cfo: 3, mgr: 1 };
    expect(isLevelApproved(makeLevel('weighted', ['cfo', 'mgr'], ['cfo'], [], { threshold: 3, weights }))).toBe(true);
    expect(isLevelApproved(makeLevel('weighted', ['cfo', 'mgr'], ['mgr'], [], { threshold: 3, weights }))).toBe(false);
  });

  it('weighted — defaults unlisted approvers to weight 1', () => {
    expect(isLevelApproved(makeLevel('weighted', ['a', 'b', 'c'], ['a', 'b'], [], { threshold: 2 }))).toBe(true);
    expect(isLevelApproved(makeLevel('weighted', ['a', 'b', 'c'], ['a'], [], { threshold: 2 }))).toBe(false);
  });

  it('weighted — throws when threshold is invalid or unreachable', () => {
    expect(() => isLevelApproved(makeLevel('weighted', ['a'], [], []))).toThrow(/positive number/);
    expect(() => isLevelApproved(makeLevel('weighted', ['a', 'b'], [], [], { threshold: 99 }))).toThrow(/total only/);
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
    expect(isLevelRejected(makeLevel('quorum', ['a', 'b', 'c'], [], ['a'], { minApprovals: 2 }))).toBe(false);
    // two rejections leave only 1 possible approval → quorum of 2 unreachable.
    expect(isLevelRejected(makeLevel('quorum', ['a', 'b', 'c'], [], ['a', 'b'], { minApprovals: 2 }))).toBe(true);
  });

  it('weighted — rejected once achievable weight drops below threshold', () => {
    const weights = { cfo: 3, mgr: 1 };
    // total weight 4, threshold 3; rejecting mgr (1) leaves 3 → still reachable.
    expect(isLevelRejected(makeLevel('weighted', ['cfo', 'mgr'], [], ['mgr'], { threshold: 3, weights }))).toBe(false);
    // rejecting cfo (3) leaves only 1 → threshold 3 unreachable.
    expect(isLevelRejected(makeLevel('weighted', ['cfo', 'mgr'], [], ['cfo'], { threshold: 3, weights }))).toBe(true);
  });
});
