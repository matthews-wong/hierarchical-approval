import type { ApproverConfig, ResolverFn } from '../types/index.js';
import { ApprovalValidationError } from '../errors.js';

/** Cap on transitive out-of-office substitution, so a cover cycle terminates. */
const MAX_OOO_HOPS = 5;

export interface OrgProvider {
  getUsersByRole(role: string, tenantId?: string): Promise<string[]> | string[];
  /** Optional: resolve users by department name. */
  getUsersByDepartment?(dept: string, tenantId?: string): Promise<string[]> | string[];
  /** Optional: resolve the direct manager of a user. */
  getManagerOf?(userId: string, tenantId?: string): Promise<string | null> | string | null;
  /** Optional: resolve the skip-level manager of a user. */
  getSkipLevelManagerOf?(userId: string, tenantId?: string): Promise<string | null> | string | null;
  /** Optional: resolve users matching a custom attribute/value pair. */
  getUsersByAttribute?(
    attr: string,
    value: unknown,
    tenantId?: string,
  ): Promise<string[]> | string[];
}

/**
 * Supplies out-of-office cover so an approver on leave does not stall a chain.
 *
 * Consulted whenever a level's approvers are resolved — at submit, when a level
 * activates, and when a chain is previewed. Kept as an injected provider rather
 * than engine-owned state because absence lives in the HR or directory system
 * that already knows about leave; duplicating it here would guarantee the two
 * disagree.
 */
export interface OutOfOfficeProvider {
  /**
   * @param userId - The approver about to be assigned.
   * @param at - The moment cover is being resolved for.
   * @returns The user to stand in, or null/undefined when the approver is available.
   */
  getDelegateFor(
    userId: string,
    at: Date,
  ): Promise<string | null | undefined> | string | null | undefined;
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

  /**
   * Copy every custom resolver and approver type onto another resolver.
   *
   * Used when the engine builds a throwaway copy of itself for a simulation: a
   * simulation that could not resolve the caller's own `dynamic` approvers
   * would answer a different question from the one asked.
   */
  copyRegistrationsTo(target: LevelResolver): void {
    for (const [name, fn] of this.resolvers) target.register(name, fn);
    for (const [name, fn] of this.approverTypes) target.registerApproverType(name, fn);
  }

  async resolveApprovers(
    approvers: ApproverConfig[],
    submittedBy: string,
    data: Record<string, unknown>,
    orgProvider?: OrgProvider,
    outOfOffice?: OutOfOfficeProvider,
    at?: Date,
    /**
     * Filled with `original -> stand-in` for each approver replaced by
     * out-of-office cover, so the caller can carry anything keyed by the
     * original id (such as a weighted level's vote weight) across to the
     * substitute.
     */
    substitutions?: Map<string, string>,
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
          const fn = this.resolvers.get(
            (approver as { type: 'dynamic'; resolver: string }).resolver,
          );
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
          const ids = await customFn(approver as Record<string, unknown>, {
            submittedBy,
            data,
            orgProvider,
          });
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
    return this.applyOutOfOffice(result, outOfOffice, at, substitutions);
  }

  /**
   * Replace approvers who are away with their cover.
   *
   * Substitution is transitive up to {@link MAX_OOO_HOPS} so an A→B→C chain of
   * absences still lands on someone present, but a cycle (A covers B while B
   * covers A) simply stops rather than looping — leaving the original approver
   * assigned, which is visible and fixable, unlike a hang.
   *
   * A provider that throws is treated as "no cover known": an HR lookup failing
   * must not block an approval from being routed at all.
   */
  private async applyOutOfOffice(
    userIds: string[],
    provider: OutOfOfficeProvider | undefined,
    at: Date | undefined,
    substitutions?: Map<string, string>,
  ): Promise<string[]> {
    if (!provider) return userIds;
    const asOf = at ?? new Date();
    const covered: string[] = [];

    for (const original of userIds) {
      let current = original;
      const seen = new Set<string>([current]);
      for (let hop = 0; hop < MAX_OOO_HOPS; hop++) {
        let delegate: string | null | undefined;
        try {
          delegate = await provider.getDelegateFor(current, asOf);
        } catch {
          break;
        }
        if (!delegate || delegate === current || seen.has(delegate)) break;
        seen.add(delegate);
        current = delegate;
      }
      if (current !== original) substitutions?.set(original, current);
      covered.push(current);
    }

    return [...new Set(covered)];
  }
}
