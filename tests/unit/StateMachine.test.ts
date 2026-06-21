import { describe, it, expect } from 'vitest';
import { isLevelApproved, isLevelRejected } from '../../src/engine/StateMachine.js';
import type { ApprovalLevelInstance } from '../../src/types/index.js';

function makeLevel(
  mode: ApprovalLevelInstance['mode'],
  approverIds: string[],
  approvedBy: string[],
  rejectedBy: string[],
): ApprovalLevelInstance {
  return {
    level: 1,
    name: 'Test',
    mode,
    approverIds,
    approvedBy,
    rejectedBy,
    status: 'pending',
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
});
