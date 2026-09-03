import type { ApproverConfig } from './approver.js';

export type ApprovalMode = 'all' | 'any' | 'majority' | 'quorum' | 'weighted';

/** Built-in operators. Use engine.registerConditionOperator() to add custom ones. */
export type ConditionOperator =
  | '>'
  | '<'
  | '>='
  | '<='
  | '=='
  | '!='
  | 'in'
  | 'not_in'
  | (string & {});

export interface Condition {
  field: string;
  operator: ConditionOperator;
  value: unknown;
}

export interface ApprovalLevelConfig {
  level: number;
  name: string;
  approvers: ApproverConfig[];
  mode: ApprovalMode;
  /**
   * Name of a parallel branch group. Levels sharing a group activate at the
   * same time and the instance advances past them only once every one is
   * resolved — modelling "Finance and Legal review concurrently, then it goes
   * to the CEO". Levels in a group must occupy a contiguous run of level
   * numbers.
   *
   * Omit it for the ordinary sequential behaviour: an ungrouped level is its
   * own group of one.
   */
  group?: string;
  escalationAfterDays?: number;
  /**
   * Send a reminder to this level's pending approvers this many days after the
   * level opens. Escalation reassigns work; a reminder only nudges, which is
   * usually what an overdue-but-not-yet-critical approval needs.
   */
  reminderAfterDays?: number;
  /**
   * Repeat the reminder every this many days after the first one. Omit for a
   * single reminder.
   */
  reminderEveryDays?: number;
  /** Maximum reminders to send for this level. Defaults to 3. */
  maxReminders?: number;
  /**
   * Required when mode is 'quorum'. The minimum number of approvals needed to
   * pass this level (an N-of-M threshold). The level is rejected as soon as it
   * becomes impossible to reach this count.
   */
  minApprovals?: number;
  /**
   * Required when mode is 'weighted'. The cumulative approver weight needed to
   * pass this level. The level is rejected once the remaining achievable weight
   * can no longer reach this threshold.
   */
  threshold?: number;
  /**
   * Optional per-approver voting weights for 'weighted' mode, keyed by approver
   * id. Approvers not listed default to a weight of 1.
   */
  weights?: Record<string, number>;
}

/**
 * A boolean combinator over nested condition expressions.
 *
 * Exactly one key is set. `all` and `any` take a non-empty list; `not` inverts
 * a single expression. They nest arbitrarily, so a rule can express
 * "(A and B) or not C" without the caller flattening it by hand.
 */
export type ConditionGroup =
  | { all: ConditionExpression[]; any?: never; not?: never }
  | { any: ConditionExpression[]; all?: never; not?: never }
  | { not: ConditionExpression; all?: never; any?: never };

/**
 * Anything that can appear in a rule's `when`.
 *
 * A bare {@link Condition} is a single test. An array is shorthand for `all`
 * (kept so existing templates keep working). A {@link ConditionGroup} is an
 * explicit combinator.
 */
export type ConditionExpression = Condition | ConditionExpression[] | ConditionGroup;

export interface ConditionRule {
  /**
   * The test that decides whether this rule's mutations apply. An array means
   * every element must hold; use {@link ConditionGroup} for `any` / `not`.
   */
  when: ConditionExpression;
  addLevels?: ApprovalLevelConfig[];
  skipLevels?: number[];
}

export interface EscalationConfig {
  afterDays: number;
  escalateTo: ApproverConfig;
}

export interface ApprovalTemplateConfig {
  name: string;
  documentType: string;
  levels: ApprovalLevelConfig[];
  conditions?: ConditionRule[];
  escalation?: EscalationConfig;
  /** Overall SLA for the entire workflow in days. Emits approval:sla_breached when elapsed. */
  slaDeadlineDays?: number;
  /** Allow emergency override (bypass remaining levels). Must be true to use engine.override(). */
  allowOverride?: boolean;
}

export interface ApprovalTemplate extends ApprovalTemplateConfig {
  id: string;
  tenantId: string;
  createdAt: Date;
  /** Starts at 1; incremented on each call to engine.updateTemplate(). */
  version: number;
  /** ID of the previous version of this template, for audit trail. */
  previousVersionId?: string;
}
