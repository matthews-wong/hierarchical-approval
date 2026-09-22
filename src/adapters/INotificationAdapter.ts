import type { ApprovalEventName, ApprovalEventMap } from '../types/events.js';

export interface NotificationEvent {
  /** The event that fired, e.g. `'submitted'`, `'approved'`, `'escalated'`. */
  type: ApprovalEventName;
  /** Id of the approval instance the event fired for. */
  instanceId: string;
  /** Id of the document under approval, as submitted by the caller. */
  documentId: string;
  /** Caller-defined document category (e.g. `'purchase_order'`). */
  documentType: string;
  /** When the underlying transition happened. */
  timestamp: Date;
  /** Current-level approver IDs; empty for non-level events (cancelled, expired, etc.). */
  recipients: string[];
  /** Name of the template governing the instance. */
  templateName: string;
  /** Tenant the instance belongs to, for multi-tenant deployments. */
  tenantId: string;
  /** Event-specific detail, shaped by {@link type}. */
  payload: ApprovalEventMap[ApprovalEventName];
}

export interface INotificationAdapter {
  /** Called after every emitted approval event. Must not throw — errors are logged and swallowed. */
  notify(event: NotificationEvent): Promise<void>;
}
