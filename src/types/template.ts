import type { ApproverConfig } from './approver.js';

export type ApprovalMode = 'all' | 'any' | 'majority';

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
