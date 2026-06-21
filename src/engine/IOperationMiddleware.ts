import type { ApprovalInstance } from '../types/index.js';
import type { ApprovalError } from '../errors.js';

export interface OperationContext<T = unknown> {
  operation: string;
  instanceId?: string;
  actorId?: string;
  tenantId: string;
  input: T;
}

export interface IOperationMiddleware {
  /** Runs after authorization and input validation, before state mutations. */
  before?(ctx: OperationContext): Promise<void> | void;
  /** Runs after successful completion of the operation. */
  after?(ctx: OperationContext, result: ApprovalInstance | void): Promise<void> | void;
  /** Runs when an ApprovalError is thrown. Does not suppress the error. */
  onError?(ctx: OperationContext, error: ApprovalError): Promise<void> | void;
}
