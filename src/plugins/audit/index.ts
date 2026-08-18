/**
 * Tamper-evident audit & compliance plug-ins.
 *
 * All three adapters implement {@link IAuditAdapter} exactly and are drop-in for
 * `ApprovalEngineOptions.auditAdapter` with no engine modification:
 *  - {@link HashChainAuditAdapter} — SHA-256 hash-chained, tamper-evident log with `verify()`.
 *  - {@link RedactingAuditAdapter} — PII-redacting decorator over another adapter.
 *  - {@link CompositeAuditAdapter} — concurrent fan-out to N child adapters.
 *
 * @packageDocumentation
 */

export { canonicalize, CircularReferenceError } from './canonicalize.js';

export {
  HashChainAuditAdapter,
  GENESIS_PREV_HASH,
  type ChainRecord,
  type ChainRecordWriter,
  type ChainRecordReader,
  type VerifyResult,
  type HashChainAuditAdapterOptions,
} from './HashChainAuditAdapter.js';

export {
  RedactingAuditAdapter,
  DEFAULT_REDACTION_MASK,
  type RedactingAuditAdapterOptions,
} from './RedactingAuditAdapter.js';

export {
  CompositeAuditAdapter,
  type CompositeChild,
  type CompositeAuditAdapterOptions,
} from './CompositeAuditAdapter.js';
