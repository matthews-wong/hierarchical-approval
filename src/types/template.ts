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
  /**
   * Delegate this level to a whole separate approval, rather than to a list of
   * approvers.
   *
   * When the level opens, a child instance is submitted against
   * {@link SubWorkflowConfig.templateName}. The parent level stays open until
   * that child finishes, then takes its outcome: approved advances the parent,
   * rejected rejects it. Models "a capital request over 1M needs its own board
   * approval before this purchase order can proceed" without flattening the
   * board's chain into the purchase order's.
   *
   * A level with `subWorkflow` needs no `approvers` — nobody approves it
   * directly; the child does.
   */
  subWorkflow?: SubWorkflowConfig;
  escalationAfterDays?: number;
  /**
   * Escalate this level after this many **working hours**, for SLAs quoted in
   * hours rather than days. Mutually exclusive with
   * {@link escalationAfterDays}.
   */
  escalationAfterHours?: number;
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

/** How a level hands off to a child approval. See {@link ApprovalLevelConfig.subWorkflow}. */
export interface SubWorkflowConfig {
  /** Template the child instance is submitted against. */
  templateName: string;
  /**
   * Copy the parent's document data into the child (default `true`), so the
   * child's own conditions can be evaluated against the same document.
   */
  carryData?: boolean;
  /** Document type for the child; defaults to the child template's own. */
  documentType?: string;
}

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
  /**
   * Name of a template to inherit from. The base's levels, conditions,
   * escalation, SLA and override flag are copied in, then this config's own
   * fields are applied on top.
   *
   * Resolution happens once, when the template is defined: what gets stored is
   * the flattened result, so editing the base later never silently reshapes a
   * derived template or an instance already running against it.
   */
  extends?: string;
  /**
   * Level numbers to drop from the inherited chain. Only meaningful with
   * {@link extends}.
   */
  removeLevels?: number[];
  documentType: string;
  levels: ApprovalLevelConfig[];
  conditions?: ConditionRule[];
  escalation?: EscalationConfig;
  /** Overall SLA for the entire workflow in days. Emits approval:sla_breached when elapsed. */
  slaDeadlineDays?: number;
  /**
   * Overall SLA in **working hours**. Mutually exclusive with
   * {@link slaDeadlineDays}.
   */
  slaDeadlineHours?: number;
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
