import type { ApprovalInstance, AuditEntry } from './instance.js';

/** Common fields carried by every lifecycle event emitted for an approval instance. */
export interface ApprovalEvent {
  /** The `ApprovalInstance.id` this event pertains to. */
  instanceId: string;
  /** The id of the business document the instance was raised against. */
  documentId: string;
  /** The document type, matching the template used to raise the instance. */
  documentType: string;
  /** When the event occurred. */
  timestamp: Date;
}

/** Emitted as `approval:submitted` when a new instance is raised. */
export interface SubmittedEvent extends ApprovalEvent {
  submittedBy: string;
  currentApprovers: string[];
}

/** Emitted as `approval:approved` when an approver accepts a level. */
export interface ApprovedEvent extends ApprovalEvent {
  approverId: string;
  level: number;
  comment?: string;
  isFinal: boolean;
}

/** Emitted as `approval:rejected` when an approver rejects a level. */
export interface RejectedEvent extends ApprovalEvent {
  approverId: string;
  level: number;
  reason: string;
  returnTo: 'originator' | 'previous' | null;
}

/** Emitted as `approval:delegated` when an approver hands their decision to someone else. */
export interface DelegatedEvent extends ApprovalEvent {
  fromApprover: string;
  toApprover: string;
  level: number;
  reason: string;
}

/** Emitted as `approval:reassigned` when an admin moves a level to a different approver. */
export interface ReassignedEvent extends ApprovalEvent {
  reassignedBy: string;
  fromApprover: string;
  toApprover: string;
  level: number;
  reason: string;
}

/** Emitted as `approval:escalated` when a level's SLA rung hands off to a new approver. */
export interface EscalatedEvent extends ApprovalEvent {
  level: number;
  escalatedTo: string;
}

/** Emitted as `approval:cancelled` when the instance is withdrawn before completion. */
export interface CancelledEvent extends ApprovalEvent {
  cancelledBy: string;
  reason: string;
}

/** Emitted as `approval:level_advanced` when the chain moves to its next open level. */
export interface LevelAdvancedEvent extends ApprovalEvent {
  fromLevel: number;
  toLevel: number;
  newApprovers: string[];
}

/** Emitted as `approval:resubmitted` when a rejected instance is raised again. */
export interface ResubmittedEvent extends ApprovalEvent {
  resubmittedBy: string;
  originalInstanceId: string;
}

/** Emitted as `approval:overridden` when an admin force-approves past the normal chain. */
export interface OverriddenEvent extends ApprovalEvent {
  overriddenBy: string;
  justification: string;
}

/** Emitted as `approval:expired` when the instance's deadline passes unresolved. */
export interface ExpiredEvent extends ApprovalEvent {
  deadlineAction: 'cancel' | 'reject';
}

/** Emitted as `approval:sla_breached` when a level's deadline passes without expiring the instance. */
export interface SlaBreachedEvent extends ApprovalEvent {
  slaDeadlineAt: Date;
}

/**
 * Emitted when an instance's document data is changed while it is still
 * pending. {@link addedLevels} and {@link removedLevels} describe how the
 * remaining approval chain was recomputed — both empty when the data change
 * did not affect it.
 */
export interface DataUpdatedEvent extends ApprovalEvent {
  /** Who made the change. */
  updatedBy: string;
  /** Caller-supplied explanation for the change, if any. */
  reason?: string;
  /** Field paths whose values differ after the update. */
  changedFields: string[];
  /** Level numbers added to the future chain by re-evaluating conditions. */
  addedLevels: number[];
  /** Level numbers removed from the future chain by re-evaluating conditions. */
  removedLevels: number[];
}

/** Emitted when a pending level's approvers are nudged. */
export interface ReminderEvent extends ApprovalEvent {
  /** The level number being reminded. */
  level: number;
  /** Approvers who still owe a decision on this level. */
  recipients: string[];
  /** 1 for the first reminder on this level, 2 for the next, and so on. */
  reminderNumber: number;
}

/** Emitted when an approver asks the submitter for clarification. */
export interface InfoRequestedEvent extends ApprovalEvent {
  /** The approver who asked. */
  askedBy: string;
  /** What they asked. */
  question: string;
  /** The level `askedBy` was acting on when they asked. */
  level: number;
  /** Who is expected to answer — the submitter. */
  recipients: string[];
}

/** Emitted when the question is answered and the instance comes off hold. */
export interface InfoProvidedEvent extends ApprovalEvent {
  respondedBy: string;
  response: string;
  level: number;
  /** How long the instance spent on hold; deadlines were extended by this much. */
  heldForMs: number;
  /** The approvers waiting again now that the question is answered. */
  recipients: string[];
}

/** Emitted when supporting evidence is attached to or removed from an approval. */
export interface AttachmentEvent extends ApprovalEvent {
  actorId: string;
  attachmentId: string;
  name: string;
  uri: string;
  level?: number;
}

/** Emitted when a level hands off to a child approval, and when that child returns. */
export interface SubWorkflowEvent extends ApprovalEvent {
  level: number;
  childInstanceId: string;
  childTemplateName: string;
  /** Set on completion: the outcome the child returned. */
  outcome?: 'approved' | 'rejected' | 'cancelled' | 'expired';
}

/** Emitted when a comment is posted. Recipients are the users it mentions. */
export interface CommentedEvent extends ApprovalEvent {
  commentId: string;
  authorId: string;
  body: string;
  level?: number;
  parentCommentId?: string;
  /** Users named in the comment. */
  recipients: string[];
}

export interface ApprovalEventMap {
  'approval:submitted': SubmittedEvent;
  'approval:approved': ApprovedEvent;
  'approval:rejected': RejectedEvent;
  'approval:delegated': DelegatedEvent;
  'approval:reassigned': ReassignedEvent;
  'approval:escalated': EscalatedEvent;
  'approval:cancelled': CancelledEvent;
  'approval:completed': ApprovalInstance;
  'approval:level_advanced': LevelAdvancedEvent;
  'approval:resubmitted': ResubmittedEvent;
  'approval:overridden': OverriddenEvent;
  'approval:expired': ExpiredEvent;
  'approval:sla_breached': SlaBreachedEvent;
  'approval:data_updated': DataUpdatedEvent;
  'approval:reminder': ReminderEvent;
  'approval:info_requested': InfoRequestedEvent;
  'approval:info_provided': InfoProvidedEvent;
  'approval:attachment_added': AttachmentEvent;
  'approval:attachment_removed': AttachmentEvent;
  'approval:subworkflow_started': SubWorkflowEvent;
  'approval:subworkflow_completed': SubWorkflowEvent;
  'approval:commented': CommentedEvent;
}

export type ApprovalEventName = keyof ApprovalEventMap;

export interface HistoryEntry extends AuditEntry {
  instanceId: string;
}
