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
  | 'data_updated'
  | 'reminded'
  | 'info_requested'
  | 'info_provided'
  | 'attachment_added'
  | 'attachment_removed'
  | 'subworkflow_started'
  | 'subworkflow_completed'
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
  /** Parallel branch group this level belongs to; absent for sequential levels. */
  group?: string;
  /** Id of the child instance this level is waiting on, when it delegates to a sub-workflow. */
  childInstanceId?: string;
  /** Template the child was submitted against; kept for display and diagnostics. */
  subWorkflowTemplate?: string;
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
  /** When the next reminder for this level is due; cleared when the level closes. */
  reminderDueAt?: Date;
  /** How many reminders have already been sent for this level. */
  remindersSent?: number;
  reminderAfterDays?: number;
  reminderEveryDays?: number;
  maxReminders?: number;
  /** Set when a delegation has a time limit — the original approver is restored when this date passes. */
  delegatedUntil?: Date;
  /** The approver who delegated away from this slot; used to revert when delegatedUntil expires. */
  delegatedFrom?: string;
  /** The delegate who received this slot; used to revert when delegatedUntil expires. */
  delegatedTo?: string;
}

/**
 * A pointer to supporting evidence for an approval — a quote PDF, a signed
 * contract, a screenshot of a system of record.
 *
 * The engine stores a **reference**, never bytes. Approval documents belong in
 * the object store or DMS the organisation already runs, which handles
 * retention, virus scanning and access control far better than an approval
 * table could; duplicating them here would make the audit database the largest
 * and least governed copy of them.
 */
export interface Attachment {
  id: string;
  /** Human-readable file name, shown in approval UIs. */
  name: string;
  /** Where the file actually lives — an S3 URI, DMS id, or https URL. */
  uri: string;
  contentType?: string;
  sizeBytes?: number;
  addedBy: string;
  addedAt: Date;
  /** The level in play when it was attached, for context in the audit trail. */
  level?: number;
}

/**
 * An open request for clarification from an approver back to the submitter.
 *
 * The instance stays `pending` and keeps its approvers — this is a question,
 * not a rejection — but its deadlines are paused while the question is open.
 */
export interface InfoRequest {
  askedBy: string;
  question: string;
  askedAt: Date;
  /** The level whose approver asked. */
  level: number;
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
  /**
   * ID of the parent instance — set both when this was resubmitted from a
   * rejected instance and when it is a sub-workflow child.
   */
  parentInstanceId?: string;
  /** Parent level this instance was spawned for, when it is a sub-workflow child. */
  parentLevel?: number;
  /** How many sub-workflow hops deep this instance sits. 0 for a top-level approval. */
  subWorkflowDepth?: number;
  /** Auto-cancel or auto-reject if not resolved by this time. */
  expiresAt?: Date;
  /** What happens when expiresAt is reached (default: 'cancel'). */
  deadlineAction?: 'cancel' | 'reject';
  /** Set from template.slaDeadlineDays at submit time; breached when passed without resolution. */
  slaDeadlineAt?: Date;
  /** Timestamp when the SLA deadline was first breached; set by the scheduler. */
  slaBreachedAt?: Date;
  /**
   * Open request for clarification. While set, the instance is on hold: its
   * escalation, SLA and expiry deadlines do not advance.
   */
  infoRequest?: InfoRequest;
  /** Supporting evidence attached to this approval. References only, never bytes. */
  attachments?: Attachment[];
}
