import { Inject } from '@nestjs/common';

/**
 * DI token under which the configured {@link ApprovalEngine} instance is
 * provided by {@link HierarchicalApprovalModule}.
 */
export const APPROVAL_ENGINE = Symbol('HIERARCHICAL_APPROVAL_ENGINE');

/**
 * Parameter/property decorator that injects the configured `ApprovalEngine`.
 *
 * @example
 * ```ts
 * @Injectable()
 * class InvoiceService {
 *   constructor(@InjectApprovalEngine() private readonly approvals: ApprovalEngine) {}
 * }
 * ```
 */
export function InjectApprovalEngine(): ReturnType<typeof Inject> {
  return Inject(APPROVAL_ENGINE);
}
