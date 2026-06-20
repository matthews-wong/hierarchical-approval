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

export function isLevelApproved(level: ApprovalLevelInstance): boolean {
  const { mode, approverIds, approvedBy } = level;
  const total = approverIds.length;
  if (total === 0) {
    throw new ApprovalValidationError(
      `Level ${level.level} ("${level.name}") has no approvers. Ensure resolvers return at least one user.`,
    );
  }
  const count = approvedBy.length;

  switch (mode) {
    case 'any':
      return count >= 1;
    case 'all':
      return count >= total;
    case 'majority':
      return count > Math.floor(total / 2);
  }
}

export function isLevelRejected(level: ApprovalLevelInstance): boolean {
  const { mode, approverIds, rejectedBy } = level;
  const total = approverIds.length;
  if (total === 0) {
    throw new ApprovalValidationError(
      `Level ${level.level} ("${level.name}") has no approvers. Ensure resolvers return at least one user.`,
    );
  }
  const rejectCount = rejectedBy.length;

  switch (mode) {
    case 'any':
      return rejectCount >= total;
    case 'all':
      return rejectCount >= 1;
    case 'majority':
      return rejectCount > Math.floor(total / 2);
  }
}
