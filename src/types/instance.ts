import type { ApprovalMode, EscalationConfig } from './template.js';
import type { ApproverConfig } from './approver.js';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired';
export type LevelStatus = 'waiting' | 'pending' | 'approved' | 'rejected' | 'skipped';

export type AuditAction =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'delegated'
  | 'reassigned'
  | 'escalated'
  | 'cancelled'
  | 'level_advanced'
  | 'commented'
  | 'resubmitted'
  | 'overridden'
  | 'expired';

export interface AuditEntry {
  action: AuditAction;
  actorId: string;
  actorRole?: string;
  actorIp?: string;
  actorUserAgent?: string;
  level: number;
  timestamp: Date;
  traceId?: string;
  comment?: string;
  reason?: string;
  delegateTo?: string;
  oldValue?: Record<string, unknown>;
  newValue?: Record<string, unknown>;
}

/** Context injected by the caller on each mutating operation (for SOX/SOC2 compliance). */
export interface AuditContext {
  actorRole?: string;
  actorIp?: string;
  actorUserAgent?: string;
  traceId?: string;
}

export interface ApprovalLevelInstance {
  level: number;
  name: string;
  mode: ApprovalMode;
  approverConfigs: ApproverConfig[];
  approverIds: string[];
  approvedBy: string[];
  rejectedBy: string[];
  status: LevelStatus;
  /** Minimum approvals required to pass this level (set when mode is 'quorum'). */
  minApprovals?: number;
  /** Cumulative approver weight required to pass this level (set when mode is 'weighted'). */
  threshold?: number;
  /** Per-approver voting weights for 'weighted' mode; unlisted approvers default to 1. */
  weights?: Record<string, number>;
  escalationDueAt?: Date;
  escalationAfterDays?: number;
  /** Set when a delegation has a time limit — the original approver is restored when this date passes. */
  delegatedUntil?: Date;
  /** The approver who delegated away from this slot; used to revert when delegatedUntil expires. */
  delegatedFrom?: string;
  /** The delegate who received this slot; used to revert when delegatedUntil expires. */
  delegatedTo?: string;
}

/** Snapshot of template configuration captured at submit time to insulate in-flight instances from template updates. */
export interface TemplateSnapshot {
  escalation?: EscalationConfig;
  slaDeadlineDays?: number;
  allowOverride?: boolean;
}

export interface ApprovalInstance {
  id: string;
  tenantId: string;
  templateId: string;
  templateName: string;
  documentId: string;
  documentType: string;
  submittedBy: string;
  status: ApprovalStatus;
  currentLevel: number;
  version: number;
  idempotencyKey?: string;
  levels: ApprovalLevelInstance[];
  auditLog: AuditEntry[];
  data: Record<string, unknown>;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  /** Snapshot of template config at submit time — prevents template changes from affecting in-flight instances. */
  templateSnapshot?: TemplateSnapshot;
  /** ID of the rejected instance this was resubmitted from. */
  parentInstanceId?: string;
  /** Auto-cancel or auto-reject if not resolved by this time. */
  expiresAt?: Date;
  /** What happens when expiresAt is reached (default: 'cancel'). */
  deadlineAction?: 'cancel' | 'reject';
  /** Set from template.slaDeadlineDays at submit time; breached when passed without resolution. */
  slaDeadlineAt?: Date;
  /** Timestamp when the SLA deadline was first breached; set by the scheduler. */
  slaBreachedAt?: Date;
}
