import type { Clock } from '../../utils/Clock.js';
import { systemClock } from '../../utils/Clock.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import type { INotificationAdapter, NotificationEvent } from '../../adapters/INotificationAdapter.js';
import type { IOutboxStore, OutboxRecord } from './IOutboxStore.js';
import { InMemoryOutboxStore } from './InMemoryOutboxStore.js';

/**
 * Transport that performs the actual side-effecting delivery of a single event
 * (send an email, post to a queue, call a webhook, …).
 *
 * It MAY throw synchronously or reject asynchronously — both are treated
 * identically as a failed attempt and trigger a retry. A normal resolution
 * counts as a successful delivery.
 */
export type NotificationTransport = (event: NotificationEvent) => void | Promise<void>;

/** Configuration for {@link OutboxNotificationAdapter}. All fields optional except `transport`. */
export interface OutboxNotificationAdapterOptions {
  /** Side-effecting delivery function. Required. */
  transport: NotificationTransport;
  /** Persistence for queued events. Defaults to an {@link InMemoryOutboxStore}. */
  store?: IOutboxStore;
  /** Time source. Defaults to {@link systemClock}. Inject a manual clock for deterministic tests. */
  clock?: Clock;
  /** Structured logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
  /**
   * Maximum delivery attempts before an event is dead-lettered. Must be >= 1.
   * `1` means no retries (single failure → dead-letter). Defaults to `5`.
   */
  maxAttempts?: number;
  /** Base backoff in milliseconds for the first retry. Defaults to `1000`. */
  baseDelayMs?: number;
  /** Multiplier applied per attempt (exponential). Defaults to `2`. */
  backoffFactor?: number;
  /**
   * Upper bound on a single backoff delay, in milliseconds. Caps the schedule so
   * very high attempt counts never overflow to `Infinity`/negative. Defaults to
   * `5 * 60_000` (5 minutes).
   */
  maxDelayMs?: number;
  /** Monotonic id generator for records. Defaults to a counter + timestamp. */
  idGenerator?: () => string;
}

/**
 * Reliable, store-and-forward {@link INotificationAdapter}.
 *
 * `notify()` only enqueues the event into a pluggable outbox store and returns;
 * it never throws (enqueue failures are caught, logged, and swallowed). Actual
 * delivery happens in {@link drain}, which is driven by ops (a poller/cron) or
 * tests. Delivery retries on failure with deterministic exponential backoff
 * computed from the injected {@link Clock}; on exhausting `maxAttempts` the
 * record is moved to a dead-letter list rather than dropped.
 *
 * Ordering: within a single `(tenantId, instanceId)` partition delivery is FIFO
 * best-effort (oldest-enqueued due record first). There is no ordering guarantee
 * across partitions, and a record awaiting a future retry does not block later
 * records in the same partition from being attempted.
 *
 * Drop-in for `ApprovalEngineOptions.notificationAdapter` with no engine change.
 */
export class OutboxNotificationAdapter implements INotificationAdapter {
  private readonly transport: NotificationTransport;
  private readonly store: IOutboxStore;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly backoffFactor: number;
  private readonly maxDelayMs: number;
  private readonly idGenerator: () => string;
  private seq = 0;

  /** Guards against concurrent {@link drain} runs causing double-delivery. */
  private draining: Promise<number> | null = null;

  constructor(options: OutboxNotificationAdapterOptions) {
    this.transport = options.transport;
    this.store = options.store ?? new InMemoryOutboxStore();
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 5));
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? 1000);
    this.backoffFactor = options.backoffFactor ?? 2;
    this.maxDelayMs = Math.max(0, options.maxDelayMs ?? 5 * 60_000);
    this.idGenerator = options.idGenerator ?? (() => `${this.clock.now().getTime()}-${this.seq++}`);
  }

  /**
   * Enqueue an event for reliable delivery. Never throws: a failure to persist
   * is logged and swallowed so the engine's emit path is never broken.
   */
  async notify(event: NotificationEvent): Promise<void> {
    try {
      const now = this.clock.now().getTime();
      const record: OutboxRecord = {
        id: this.idGenerator(),
        partitionKey: `${event.tenantId}:${event.instanceId}`,
        tenantId: event.tenantId,
        event,
        status: 'pending',
        attempts: 0,
        nextAttemptAt: now,
        enqueuedAt: now,
      };
      await this.store.enqueue(record);
    } catch (err) {
      this.logger.error('OutboxNotificationAdapter: failed to enqueue event', err, {
        type: event.type,
        instanceId: event.instanceId,
        tenantId: event.tenantId,
      });
    }
  }

  /**
   * Attempt delivery of all currently due-and-pending records.
   *
   * Idempotent and safe to call repeatedly and concurrently: if a drain is
   * already in flight, the same promise is returned rather than starting a
   * second pass, so a delivered event is never delivered twice beyond
   * at-least-once semantics. Records whose `nextAttemptAt` is in the future are
   * not attempted prematurely. Never throws — store/transport errors are caught
   * and logged.
   *
   * @returns the number of records successfully delivered in this pass.
   */
  async drain(): Promise<number> {
    if (this.draining) return this.draining;
    this.draining = this.runDrain();
    try {
      return await this.draining;
    } finally {
      this.draining = null;
    }
  }

  private async runDrain(): Promise<number> {
    let delivered = 0;
    let due: OutboxRecord[];
    try {
      due = await this.store.due(this.clock.now().getTime());
    } catch (err) {
      this.logger.error('OutboxNotificationAdapter: failed to read due records', err);
      return 0;
    }

    for (const record of due) {
      // Re-check status defensively in case the store handed back a stale row.
      if (record.status !== 'pending') continue;
      const ok = await this.attemptDelivery(record);
      if (ok) delivered++;
    }
    return delivered;
  }

  /** Run one delivery attempt for a record and persist the resulting state. */
  private async attemptDelivery(record: OutboxRecord): Promise<boolean> {
    record.attempts++;
    try {
      // Await covers both async rejection and a returned promise; the try also
      // catches a synchronous throw from the transport.
      await this.transport(record.event);
      try {
        await this.store.remove(record.id);
      } catch (err) {
        // Delivery succeeded but cleanup failed: log. At-least-once means a
        // future drain may redeliver — acceptable and documented.
        this.logger.error('OutboxNotificationAdapter: delivered but failed to remove record', err, {
          id: record.id,
          tenantId: record.tenantId,
        });
      }
      this.logger.debug('OutboxNotificationAdapter: delivered', {
        id: record.id,
        type: record.event.type,
        attempts: record.attempts,
      });
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      record.lastError = message;
      if (record.attempts >= this.maxAttempts) {
        record.status = 'dead';
        this.logger.error('OutboxNotificationAdapter: dead-lettered after exhausting retries', err, {
          id: record.id,
          tenantId: record.tenantId,
          attempts: record.attempts,
          maxAttempts: this.maxAttempts,
        });
      } else {
        record.nextAttemptAt = this.clock.now().getTime() + this.computeBackoff(record.attempts);
        this.logger.warn('OutboxNotificationAdapter: delivery failed, scheduling retry', {
          id: record.id,
          tenantId: record.tenantId,
          attempts: record.attempts,
          nextAttemptAt: record.nextAttemptAt,
          error: message,
        });
      }
      try {
        await this.store.update(record);
      } catch (updateErr) {
        this.logger.error('OutboxNotificationAdapter: failed to persist record state', updateErr, {
          id: record.id,
        });
      }
      return false;
    }
  }

  /**
   * Deterministic exponential backoff for the Nth attempt (1-based), capped at
   * `maxDelayMs`. Guards against overflow: a non-finite intermediate value
   * collapses to the cap, so very high attempt counts never yield
   * `Infinity`/`NaN`/negative delays.
   */
  private computeBackoff(attempt: number): number {
    const raw = this.baseDelayMs * Math.pow(this.backoffFactor, attempt - 1);
    if (!Number.isFinite(raw) || raw < 0) return this.maxDelayMs;
    return Math.min(raw, this.maxDelayMs);
  }

  /**
   * Records still awaiting first delivery or a retry. Exposed for ops dashboards
   * and tests so a stuck transport (growing pending list) is observable.
   */
  async pending(): Promise<OutboxRecord[]> {
    try {
      return await this.store.pending();
    } catch (err) {
      this.logger.error('OutboxNotificationAdapter: failed to read pending records', err);
      return [];
    }
  }

  /**
   * Records that exhausted all retries. Exposed so ops can detect and replay a
   * stuck transport; the list is never silently dropped/truncated.
   */
  async deadLettered(): Promise<OutboxRecord[]> {
    try {
      return await this.store.deadLettered();
    } catch (err) {
      this.logger.error('OutboxNotificationAdapter: failed to read dead-lettered records', err);
      return [];
    }
  }
}
