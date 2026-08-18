import type { ApprovalInstance, ApprovalLevelInstance } from '../types/index.js';

export interface AuthorizationContext {
  operation:
    | 'submit'
    | 'approve'
    | 'reject'
    | 'delegate'
    | 'reassign'
    | 'cancel'
    | 'escalate'
    | 'override'
    | 'resubmit'
    | 'addComment';
  actorId: string;
  instance: Readonly<ApprovalInstance>;
  level?: Readonly<ApprovalLevelInstance>;
  opts: Record<string, unknown>;
}

export interface IAuthorizationPolicy {
  /**
   * Return undefined to allow the operation.
   * Return a non-empty string to deny — the engine throws ApprovalForbiddenError(message).
   * Throwing ApprovalForbiddenError directly is also permitted.
   */
  authorize(ctx: AuthorizationContext): Promise<string | undefined> | string | undefined;
}
