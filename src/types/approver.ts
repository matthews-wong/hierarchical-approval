export type ApproverConfig =
  | { type: 'user'; userId: string }
  | { type: 'role'; role: string }
  | { type: 'dynamic'; resolver: string }
  /** Custom approver type registered via engine.registerApproverType(). */
  | { type: string; [key: string]: unknown };

/** An {@link ApproverConfig} resolved down to a concrete user. */
export interface ResolvedApprover {
  userId: string;
  /** The config entry this approver was resolved from. */
  source: ApproverConfig;
}

/**
 * Resolves a `{ type: 'dynamic' }` approver to a concrete user id, given the
 * submitter and the document's data. Registered via
 * {@link ApprovalEngine.registerResolver}.
 */
export type ResolverFn = (
  submittedBy: string,
  data: Record<string, unknown>,
) => Promise<string> | string;
