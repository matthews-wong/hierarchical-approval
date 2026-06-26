import type { IAuthorizationPolicy, AuthorizationContext } from '../../engine/IAuthorizationPolicy.js';
import { ApprovalForbiddenError } from '../../errors.js';

/**
 * How child policies are combined.
 * - `'and'`: every policy must allow; the first denial wins (short-circuits) and
 *   its message is returned.
 * - `'or'`: at least one policy must allow; deny only if all deny, returning the
 *   last denial message encountered.
 */
export type CompositeMode = 'and' | 'or';

/**
 * Configuration for {@link CompositeAuthorizationPolicy}.
 */
export interface CompositeAuthorizationPolicyOptions {
  /**
   * Child policies evaluated in array order (deterministic).
   */
  policies: readonly IAuthorizationPolicy[];
  /** Combination semantics. See {@link CompositeMode}. */
  mode: CompositeMode;
}

/**
 * Combines multiple {@link IAuthorizationPolicy} instances under selectable AND
 * or OR semantics, implementing {@link IAuthorizationPolicy} itself.
 *
 * Evaluation order is the child array order, deterministically.
 *
 * A child "denies" if it returns a non-empty string OR throws an
 * {@link ApprovalForbiddenError}; both forms are normalized to a denial message.
 * (Any other thrown error is not an authorization decision and is allowed to
 * propagate.) A child "allows" if it returns `undefined`.
 *
 * Empty policy set:
 * - `'and'` allows (vacuous truth — nothing to object).
 * - `'or'` denies (vacuous falsity — nothing to grant access).
 */
export class CompositeAuthorizationPolicy implements IAuthorizationPolicy {
  private readonly policies: readonly IAuthorizationPolicy[];
  private readonly mode: CompositeMode;

  constructor(options: CompositeAuthorizationPolicyOptions) {
    this.policies = [...options.policies];
    this.mode = options.mode;
  }

  async authorize(ctx: AuthorizationContext): Promise<string | undefined> {
    if (this.mode === 'and') {
      return this.evaluateAnd(ctx);
    }
    return this.evaluateOr(ctx);
  }

  /** AND: first denial short-circuits and wins; empty set allows. */
  private async evaluateAnd(ctx: AuthorizationContext): Promise<string | undefined> {
    for (const policy of this.policies) {
      const denial = await this.evaluateOne(policy, ctx);
      if (denial !== undefined) {
        return denial;
      }
    }
    return undefined;
  }

  /**
   * OR: allow as soon as any policy allows; if all deny, return the last denial
   * message. Empty set denies.
   */
  private async evaluateOr(ctx: AuthorizationContext): Promise<string | undefined> {
    if (this.policies.length === 0) {
      return 'Access denied: no authorization policies are configured (OR composite is vacuously closed).';
    }
    let lastDenial = 'Access denied: no policy granted access.';
    for (const policy of this.policies) {
      const denial = await this.evaluateOne(policy, ctx);
      if (denial === undefined) {
        return undefined;
      }
      lastDenial = denial;
    }
    return lastDenial;
  }

  /**
   * Evaluate a single child, normalizing its decision to either `undefined`
   * (allow) or a non-empty denial message. A thrown {@link ApprovalForbiddenError}
   * is treated as a denial; other errors propagate.
   */
  private async evaluateOne(
    policy: IAuthorizationPolicy,
    ctx: AuthorizationContext,
  ): Promise<string | undefined> {
    try {
      const result = await policy.authorize(ctx);
      if (result === undefined) {
        return undefined;
      }
      // Defensive: a child returning an empty string is treated as allow per the
      // IAuthorizationPolicy contract ("non-empty string to deny").
      return result.length > 0 ? result : undefined;
    } catch (err) {
      if (err instanceof ApprovalForbiddenError) {
        return err.message;
      }
      throw err;
    }
  }
}
