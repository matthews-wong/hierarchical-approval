import type { ApprovalEventName, ApprovalEventMap } from '../types/events.js';

export interface NotificationEvent {
  type: ApprovalEventName;
  instanceId: string;
  documentId: string;
  documentType: string;
  timestamp: Date;
  /** Current-level approver IDs; empty for non-level events (cancelled, expired, etc.). */
  recipients: string[];
  templateName: string;
  tenantId: string;
  payload: ApprovalEventMap[ApprovalEventName];
}

export interface INotificationAdapter {
  /** Called after every emitted approval event. Must not throw — errors are logged and swallowed. */
  notify(event: NotificationEvent): Promise<void>;
}
