import type { IAuthorizationPolicy, AuthorizationContext } from '../../engine/IAuthorizationPolicy.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';

/** All operation discriminants the engine may authorize. */
export type AuthorizationOperation = AuthorizationContext['operation'];

/**
 * Resolves the roles held by an actor within a tenant. May be synchronous or
 * asynchronous. A rejection/throw is treated as a fail-closed denial (see
 * {@link RbacAuthorizationPolicy}).
 */
export type RoleProviderFn = (
  actorId: string,
  tenantId: string,
) => Promise<readonly string[]> | readonly string[];

/**
 * Per-operation requirement. Use a `'allow-all'` literal to bypass role checks
 * for an operation, or specify required roles together with the matching
 * semantics.
 */
export type RoleRequirement =
  | 'allow-all'
  | {
      /** Roles considered for this operation. */
      roles: readonly string[];
      /**
       * `'any'` (default): actor must hold at least one of `roles`.
       * `'all'`: actor must hold every role in `roles`.
       */
      match?: 'any' | 'all';
    };

/**
 * Configuration for {@link RbacAuthorizationPolicy}.
 */
export interface RbacAuthorizationPolicyOptions {
  /**
   * Maps an operation to its role requirement. Operations absent from this map
   * fall through to {@link RbacAuthorizationPolicyOptions.defaultMode}.
   */
  rules: Partial<Record<AuthorizationOperation, RoleRequirement>>;
  /**
   * Behaviour for operations with no configured rule.
   * `'deny'` (default): deny with a clear message (closed by default).
   * `'allow'`: permit.
   */
  defaultMode?: 'deny' | 'allow';
  /**
   * The tenant id passed to the {@link RoleProviderFn}. {@link AuthorizationContext}
   * exposes the instance, so this resolves the tenant from it. Defaults to
   * `ctx.instance.tenantId`.
   */
  tenantIdFn?: (ctx: AuthorizationContext) => string;
  /** Resolves the actor's roles. */
  roleProvider: RoleProviderFn;
  /** Injected logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
}

/**
 * Role-based access control policy implementing {@link IAuthorizationPolicy}.
 *
 * Each operation maps to a {@link RoleRequirement}. Roles are resolved via the
 * injected {@link RoleProviderFn} (sync or async). When the actor satisfies the
 * requirement the policy returns `undefined` (allow); otherwise it returns a
 * non-empty denial message.
 *
 * Modes & overrides:
 * - `'allow-all'` requirement bypasses the role check for that operation.
 * - An operation with an empty `roles` list denies under `match: 'any'`
 *   (no role can satisfy "at least one of none") and allows under `match: 'all'`
 *   (vacuously true). Use `'allow-all'` for an explicit unconditional allow.
 * - Operations with no rule follow `defaultMode`: `'deny'` (default, closed) or
 *   `'allow'`.
 *
 * Fail-closed: if the {@link RoleProviderFn} throws or rejects, the policy denies
 * (returns a message) and logs the underlying reason — it never surfaces an
 * uncaught rejection. This holds in both default modes, since a provider failure
 * means roles are unknown.
 */
export class RbacAuthorizationPolicy implements IAuthorizationPolicy {
  private readonly rules: Partial<Record<AuthorizationOperation, RoleRequirement>>;
  private readonly defaultMode: 'deny' | 'allow';
  private readonly tenantIdFn: (ctx: AuthorizationContext) => string;
  private readonly roleProvider: RoleProviderFn;
  private readonly logger: Logger;

  constructor(options: RbacAuthorizationPolicyOptions) {
    this.rules = { ...options.rules };
    this.defaultMode = options.defaultMode ?? 'deny';
    this.tenantIdFn = options.tenantIdFn ?? ((ctx) => ctx.instance.tenantId);
    this.roleProvider = options.roleProvider;
    this.logger = options.logger ?? noopLogger;
  }

  async authorize(ctx: AuthorizationContext): Promise<string | undefined> {
    const requirement = this.rules[ctx.operation];

    if (requirement === undefined) {
      if (this.defaultMode === 'allow') {
        return undefined;
      }
      return `Operation "${ctx.operation}" is not permitted: no authorization rule is configured (default-deny).`;
    }

    if (requirement === 'allow-all') {
      return undefined;
    }

    const required = requirement.roles;
    const match = requirement.match ?? 'any';

    // Empty required list: 'all' is vacuously satisfied; 'any' can never match.
    if (required.length === 0) {
      if (match === 'all') {
        return undefined;
      }
      return `Operation "${ctx.operation}" is denied: no role can satisfy an empty 'any' requirement.`;
    }

    const tenantId = this.tenantIdFn(ctx);

    let roles: readonly string[];
    try {
      roles = await this.roleProvider(ctx.actorId, tenantId);
    } catch (err) {
      this.logger.error('RbacAuthorizationPolicy: roleProvider failed; denying (fail-closed)', err, {
        operation: ctx.operation,
        actorId: ctx.actorId,
        tenantId,
      });
      return `Operation "${ctx.operation}" is denied: unable to resolve actor roles.`;
    }

    const actorRoles = new Set(roles);
    const satisfied =
      match === 'all'
        ? required.every((role) => actorRoles.has(role))
        : required.some((role) => actorRoles.has(role));

    if (satisfied) {
      return undefined;
    }

    const requiredList = required.join(', ');
    const verb = match === 'all' ? 'all of' : 'one of';
    return `Operation "${ctx.operation}" denied: actor "${ctx.actorId}" must have ${verb} role(s): ${requiredList}.`;
  }
}
