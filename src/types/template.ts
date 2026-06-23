import type { ApproverConfig } from './approver.js';

export type ApprovalMode = 'all' | 'any' | 'majority' | 'quorum' | 'weighted';

/** Built-in operators. Use engine.registerConditionOperator() to add custom ones. */
export type ConditionOperator = '>' | '<' | '>=' | '<=' | '==' | '!=' | 'in' | 'not_in' | (string & {});

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
  escalationAfterDays?: number;
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

export interface ConditionRule {
  when: Condition | Condition[];
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
