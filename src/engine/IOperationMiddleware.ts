import type { ApprovalInstance } from '../types/index.js';
import type { ApprovalError } from '../errors.js';

/** The engine method a middleware hook is running around. */
export type EngineOperation =
  | 'submit'
  | 'approve'
  | 'reject'
  | 'delegate'
  | 'reassign'
  | 'cancel'
  | 'updateData'
  | 'requestInfo'
  | 'provideInfo'
  | 'addAttachment'
  | 'removeAttachment'
  | 'addComment'
  | 'resubmit'
  | 'override';

/** Context passed to an {@link IOperationMiddleware} hook for one engine call. */
export interface OperationContext<T = unknown> {
  operation: EngineOperation;
  /** The target instance's id, for operations that act on an existing instance. */
  instanceId?: string;
  /** Id of the user or system performing the operation, when known. */
  actorId?: string;
  /** The engine's configured tenant id (defaults to `'default'`). */
  tenantId: string;
  /** The caller's own input for this operation, e.g. the submit payload or decision comment. */
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
