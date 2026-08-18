export type ApproverConfig =
  | { type: 'user'; userId: string }
  | { type: 'role'; role: string }
  | { type: 'dynamic'; resolver: string }
  /** Custom approver type registered via engine.registerApproverType(). */
  | { type: string; [key: string]: unknown };

export interface ResolvedApprover {
  userId: string;
  source: ApproverConfig;
}

export type ResolverFn = (
  submittedBy: string,
  data: Record<string, unknown>,
) => Promise<string> | string;
