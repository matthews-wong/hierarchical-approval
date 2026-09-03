import type { ApprovalInstance, AuditEntry } from './instance.js';

export interface ApprovalEvent {
  instanceId: string;
  documentId: string;
  documentType: string;
  timestamp: Date;
}

export interface SubmittedEvent extends ApprovalEvent {
  submittedBy: string;
  currentApprovers: string[];
}

export interface ApprovedEvent extends ApprovalEvent {
  approverId: string;
  level: number;
  comment?: string;
  isFinal: boolean;
}

export interface RejectedEvent extends ApprovalEvent {
  approverId: string;
  level: number;
  reason: string;
  returnTo: 'originator' | 'previous' | null;
}

export interface DelegatedEvent extends ApprovalEvent {
  fromApprover: string;
  toApprover: string;
  level: number;
  reason: string;
}

export interface ReassignedEvent extends ApprovalEvent {
  reassignedBy: string;
  fromApprover: string;
  toApprover: string;
  level: number;
  reason: string;
}

export interface EscalatedEvent extends ApprovalEvent {
  level: number;
  escalatedTo: string;
}

export interface CancelledEvent extends ApprovalEvent {
  cancelledBy: string;
  reason: string;
}

export interface LevelAdvancedEvent extends ApprovalEvent {
  fromLevel: number;
  toLevel: number;
  newApprovers: string[];
}

export interface ResubmittedEvent extends ApprovalEvent {
  resubmittedBy: string;
  originalInstanceId: string;
}

export interface OverriddenEvent extends ApprovalEvent {
  overriddenBy: string;
  justification: string;
}

export interface ExpiredEvent extends ApprovalEvent {
  deadlineAction: 'cancel' | 'reject';
}

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
  updatedBy: string;
  reason?: string;
  /** Field paths whose values differ after the update. */
  changedFields: string[];
  /** Level numbers added to the future chain by re-evaluating conditions. */
  addedLevels: number[];
  /** Level numbers removed from the future chain by re-evaluating conditions. */
  removedLevels: number[];
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
}

export type ApprovalEventName = keyof ApprovalEventMap;

export interface HistoryEntry extends AuditEntry {
  instanceId: string;
}
