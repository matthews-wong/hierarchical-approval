import type { NotificationEvent } from '../../adapters/INotificationAdapter.js';

/**
 * Delivery state of a single outbox record as it moves through the retry
 * lifecycle: freshly enqueued / awaiting its next retry (`pending`) or
 * permanently failed after exhausting all attempts (`dead`).
 */
export type OutboxRecordStatus = 'pending' | 'dead';

/**
 * A durable, partition-keyed wrapper around a {@link NotificationEvent}. The
 * store persists these so that delivery (with retry + backoff) can be driven
 * separately from {@link INotificationAdapter.notify}.
 *
 * `tenantId` is lifted to a top-level field (mirroring the event) so stores can
 * partition/shard without inspecting the payload, and so it survives through
 * retries and into the dead-letter list.
 */
export interface OutboxRecord {
  /** Stable, store-assigned unique id for this record. */
  readonly id: string;
  /** Partition key: `${tenantId}:${instanceId}`. FIFO is best-effort within a partition. */
  readonly partitionKey: string;
  /** Tenant that owns the event; preserved through retry and dead-letter. */
  readonly tenantId: string;
  /** The original event to deliver. Treated as immutable. */
  readonly event: NotificationEvent;
  /** Current delivery state. */
  status: OutboxRecordStatus;
  /** Number of delivery attempts made so far (starts at 0). */
  attempts: number;
  /** Epoch millis (from the injected Clock) at which the next attempt is due. */
  nextAttemptAt: number;
  /** Epoch millis at which the record was first enqueued. Used for FIFO ordering. */
  readonly enqueuedAt: number;
  /** Last failure message, if any — useful for ops dashboards. */
  lastError?: string;
}

/**
 * Pluggable persistence for the outbox. The default in-memory implementation is
 * {@link InMemoryOutboxStore}; production deployments can back this with a
 * database/queue while keeping the same delivery semantics.
 *
 * All methods may reject — callers ({@link OutboxNotificationAdapter}) are
 * responsible for catching so that `notify()` never throws and `drain()` logs
 * rather than crashes.
 */
export interface IOutboxStore {
  /** Persist a new pending record. */
  enqueue(record: OutboxRecord): Promise<void>;
  /**
   * Return pending records whose `nextAttemptAt <= now`, oldest first
   * (FIFO best-effort by `enqueuedAt`). `now` is supplied by the caller's Clock
   * so behaviour is deterministic under a manual clock.
   */
  due(now: number): Promise<OutboxRecord[]>;
  /** Persist mutations to an existing record (status/attempts/nextAttemptAt/lastError). */
  update(record: OutboxRecord): Promise<void>;
  /** Remove a record entirely (after successful delivery). */
  remove(id: string): Promise<void>;
  /** All records still in `pending` state (delivered-but-not-yet or awaiting retry). */
  pending(): Promise<OutboxRecord[]>;
  /** All records in `dead` state (exhausted retries). */
  deadLettered(): Promise<OutboxRecord[]>;
}
