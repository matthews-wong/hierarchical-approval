import type { AuditEntry, ApprovalInstance } from '../types/index.js';

export interface IAuditAdapter {
  /**
   * Called after every state-mutating operation, in addition to the primary storage adapter.
   * Intended for write-once sinks: Kafka, S3, CloudTrail, WORM stores.
   * Must not throw — errors are logged and swallowed.
   */
  append(
    tenantId: string,
    instanceId: string,
    entry: AuditEntry,
    instance: Readonly<ApprovalInstance>,
  ): Promise<void>;
}
