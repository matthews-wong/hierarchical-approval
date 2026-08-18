import type { ApproverConfig, ResolverFn } from '../types/index.js';
import { ApprovalValidationError } from '../errors.js';

export interface OrgProvider {
  getUsersByRole(role: string, tenantId?: string): Promise<string[]> | string[];
  /** Optional: resolve users by department name. */
  getUsersByDepartment?(dept: string, tenantId?: string): Promise<string[]> | string[];
  /** Optional: resolve the direct manager of a user. */
  getManagerOf?(userId: string, tenantId?: string): Promise<string | null> | string | null;
  /** Optional: resolve the skip-level manager of a user. */
  getSkipLevelManagerOf?(userId: string, tenantId?: string): Promise<string | null> | string | null;
  /** Optional: resolve users matching a custom attribute/value pair. */
  getUsersByAttribute?(attr: string, value: unknown, tenantId?: string): Promise<string[]> | string[];
}

export type ApproverResolverFn = (
  config: Record<string, unknown>,
  ctx: { submittedBy: string; data: Record<string, unknown>; orgProvider?: OrgProvider },
) => Promise<string[]> | string[];

export class LevelResolver {
  private resolvers = new Map<string, ResolverFn>();
  private approverTypes = new Map<string, ApproverResolverFn>();

  register(name: string, fn: ResolverFn): void {
    this.resolvers.set(name, fn);
  }

  registerApproverType(typeName: string, fn: ApproverResolverFn): void {
    this.approverTypes.set(typeName, fn);
  }

  async resolveApprovers(
    approvers: ApproverConfig[],
    submittedBy: string,
    data: Record<string, unknown>,
    orgProvider?: OrgProvider,
  ): Promise<string[]> {
    const resolved: string[] = [];

    for (const approver of approvers) {
      switch (approver.type) {
        case 'user':
          resolved.push((approver as { type: 'user'; userId: string }).userId);
          break;
        case 'role': {
          if (!orgProvider) {
            throw new Error(
              `Cannot resolve role "${(approver as { type: 'role'; role: string }).role}" without an orgProvider configured on ApprovalEngine.`,
            );
          }
          const users = await orgProvider.getUsersByRole(
            (approver as { type: 'role'; role: string }).role,
          );
          resolved.push(...users);
          break;
        }
        case 'dynamic': {
          const fn = this.resolvers.get((approver as { type: 'dynamic'; resolver: string }).resolver);
          if (!fn) {
            throw new Error(
              `No resolver registered for "${(approver as { type: 'dynamic'; resolver: string }).resolver}". Call engine.registerResolver("${(approver as { type: 'dynamic'; resolver: string }).resolver}", fn) first.`,
            );
          }
          const userId = await fn(submittedBy, data);
          resolved.push(userId);
          break;
        }
        default: {
          // Custom approver type registered via engine.registerApproverType()
          const customFn = this.approverTypes.get(approver.type);
          if (!customFn) {
            throw new ApprovalValidationError(
              `Unknown approver type "${approver.type}". Register it with engine.registerApproverType("${approver.type}", fn) first.`,
            );
          }
          const ids = await customFn(approver as Record<string, unknown>, { submittedBy, data, orgProvider });
          resolved.push(...ids);
          break;
        }
      }
    }

    const result = [...new Set(resolved)];
    if (result.length === 0) {
      throw new ApprovalValidationError(
        'No approvers resolved for this level. Check your approver configuration — role may have no members or dynamic resolver returned empty.',
      );
    }
    return result;
  }
}
