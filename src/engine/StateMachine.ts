import type { ApprovalInstance, ApprovalLevelInstance } from '../types/index.js';
import { ApprovalError, ApprovalForbiddenError, ApprovalValidationError } from '../errors.js';

export { ApprovalError };

export function assertStatus(
  instance: ApprovalInstance,
  expected: ApprovalInstance['status'],
): void {
  if (instance.status !== expected) {
    throw new ApprovalError(
      `Expected instance status "${expected}" but got "${instance.status}".`,
      'INVALID_STATUS',
    );
  }
}

export function assertApproverOnLevel(level: ApprovalLevelInstance, approverId: string): void {
  if (!level.approverIds.includes(approverId)) {
    throw new ApprovalForbiddenError(
      `User "${approverId}" is not an approver for level ${level.level}.`,
    );
  }
}

export function hasAlreadyActed(level: ApprovalLevelInstance, approverId: string): boolean {
  return level.approvedBy.includes(approverId) || level.rejectedBy.includes(approverId);
}

function assertHasApprovers(level: ApprovalLevelInstance): number {
  const total = level.approverIds.length;
  if (total === 0) {
    throw new ApprovalValidationError(
      `Level ${level.level} ("${level.name}") has no approvers. Ensure resolvers return at least one user.`,
    );
  }
  return total;
}

/** Resolve the minimum-approvals threshold for a quorum level, validating configuration. */
function quorumThreshold(level: ApprovalLevelInstance, total: number): number {
  const min = level.minApprovals;
  if (min === undefined || !Number.isInteger(min) || min < 1) {
    throw new ApprovalValidationError(
      `Level ${level.level} ("${level.name}") uses 'quorum' mode but minApprovals is not a positive integer (got ${String(min)}).`,
    );
  }
  if (min > total) {
    throw new ApprovalValidationError(
      `Level ${level.level} ("${level.name}") requires ${min} approvals (quorum) but only ${total} approver(s) are assigned.`,
    );
  }
  return min;
}

function weightOf(level: ApprovalLevelInstance, approverId: string): number {
  const w = level.weights?.[approverId];
  return typeof w === 'number' && w >= 0 ? w : 1;
}

function sumWeights(level: ApprovalLevelInstance, ids: string[]): number {
  return ids.reduce((acc, id) => acc + weightOf(level, id), 0);
}

/** Resolve the weight threshold for a weighted level, validating configuration. */
function weightedThreshold(level: ApprovalLevelInstance, totalWeight: number): number {
  const threshold = level.threshold;
  if (threshold === undefined || threshold <= 0) {
    throw new ApprovalValidationError(
      `Level ${level.level} ("${level.name}") uses 'weighted' mode but threshold is not a positive number (got ${String(threshold)}).`,
    );
  }
  if (threshold > totalWeight) {
    throw new ApprovalValidationError(
      `Level ${level.level} ("${level.name}") needs a weight of ${threshold} but the assigned approvers total only ${totalWeight}.`,
    );
  }
  return threshold;
}

export function isLevelApproved(level: ApprovalLevelInstance): boolean {
  const total = assertHasApprovers(level);
  const { mode, approvedBy } = level;
  const count = approvedBy.length;

  switch (mode) {
    case 'any':
      return count >= 1;
    case 'all':
      return count >= total;
    case 'majority':
      return count > Math.floor(total / 2);
    case 'quorum':
      return count >= quorumThreshold(level, total);
    case 'weighted': {
      const totalWeight = sumWeights(level, level.approverIds);
      return sumWeights(level, approvedBy) >= weightedThreshold(level, totalWeight);
    }
  }
}

export function isLevelRejected(level: ApprovalLevelInstance): boolean {
  const total = assertHasApprovers(level);
  const { mode, rejectedBy } = level;
  const rejectCount = rejectedBy.length;

  switch (mode) {
    case 'any':
      return rejectCount >= total;
    case 'all':
      return rejectCount >= 1;
    case 'majority':
      return rejectCount > Math.floor(total / 2);
    case 'quorum': {
      // Rejected once the remaining (not-yet-rejected) approvers can no longer reach the quorum.
      const min = quorumThreshold(level, total);
      return total - rejectCount < min;
    }
    case 'weighted': {
      // Rejected once the achievable weight (total minus rejected) drops below the threshold.
      const totalWeight = sumWeights(level, level.approverIds);
      const threshold = weightedThreshold(level, totalWeight);
      return totalWeight - sumWeights(level, rejectedBy) < threshold;
    }
  }
}
