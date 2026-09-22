import type { ApprovalInstance, ApprovalLevelInstance } from '../types/index.js';

export interface AuthorizationContext {
  /** The engine method the actor is attempting to call. */
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
    | 'addComment'
    | 'updateData'
    | 'requestInfo'
    | 'provideInfo'
    | 'addAttachment'
    | 'removeAttachment';
  /** Id of the user or system attempting the operation. */
  actorId: string;
  /** The instance the operation targets, as it stood before the operation ran. */
  instance: Readonly<ApprovalInstance>;
  /** The current level, for level-scoped operations (approve, reject, delegate, etc.); absent otherwise. */
  level?: Readonly<ApprovalLevelInstance>;
  /** The caller's own options object for this operation, passed through unmodified. */
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
