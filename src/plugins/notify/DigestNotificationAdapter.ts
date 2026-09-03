import type { Clock } from '../../utils/Clock.js';
import { systemClock } from '../../utils/Clock.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import type {
  INotificationAdapter,
  NotificationEvent,
} from '../../adapters/INotificationAdapter.js';

/** One recipient's accumulated events, handed to {@link DigestSendFn} on flush. */
export interface Digest {
  recipient: string;
  /** Events for this recipient, oldest first. */
  events: NotificationEvent[];
  /** When the earliest event in this digest arrived. */
  since: Date;
  /** When the digest was flushed. */
  flushedAt: Date;
}

/** Delivers one recipient's digest. Must not throw — failures are logged and swallowed. */
export type DigestSendFn = (digest: Digest) => Promise<void> | void;

export interface DigestNotificationAdapterOptions {
  /** Called once per recipient per flush. */
  send: DigestSendFn;
  /**
   * Event types delivered immediately instead of being batched. A rejection or
   * a completed approval is news the recipient acts on now; batching it behind
   * a digest window would make the library's own notifications the reason a
   * decision was late.
   *
   * Defaults to rejections, completions, SLA breaches and expiries.
   */
  passthrough?: NotificationEvent['type'][];
  /**
   * Flush a recipient's digest once it reaches this many events, regardless of
   * the timer. Prevents an unbounded buffer under a burst.
   */
  maxBatchSize?: number;
  /**
   * Flush every recipient this often, in milliseconds. Omit to disable the
   * timer and flush only via {@link DigestNotificationAdapter.flush} — the right
   * choice when a cron job or queue worker owns the schedule.
   */
  intervalMs?: number;
  logger?: Logger;
  clock?: Clock;
}

/** Event types that reach the recipient immediately unless the caller says otherwise. */
const DEFAULT_PASSTHROUGH: NotificationEvent['type'][] = [
  'approval:rejected',
  'approval:completed',
  'approval:sla_breached',
  'approval:expired',
];

const DEFAULT_MAX_BATCH_SIZE = 50;

/**
 * Batches notifications per recipient instead of sending one per event.
 *
 * An approver on twenty documents receives twenty separate messages a day from
 * a naive adapter, which is how approval email ends up filtered into a folder
 * nobody reads — the notifications defeat themselves. This collects events per
 * recipient and delivers one digest.
 *
 * **Urgent events still go straight through.** Batching a rejection or a
 * completed approval behind a digest window would make the library's own
 * notifications the reason a decision was late, so those bypass the buffer by
 * default; see {@link DigestNotificationAdapterOptions.passthrough}.
 *
 * Buffers live in memory. A process restart drops whatever has not been
 * flushed, which is the right trade for a convenience digest but not for
 * delivery guarantees — put {@link OutboxNotificationAdapter} underneath when
 * an event must not be lost.
 *
 * @example
 * ```ts
 * const digest = new DigestNotificationAdapter({
 *   intervalMs: 15 * 60_000,
 *   send: async ({ recipient, events }) => mailer.send(recipient, summarise(events)),
 * });
 * const engine = new ApprovalEngine({ adapter, notificationAdapter: digest });
 * // ...on shutdown
 * await digest.stop();
 * ```
 */
export class DigestNotificationAdapter implements INotificationAdapter {
  private readonly buffers = new Map<string, { events: NotificationEvent[]; since: Date }>();
  private readonly send: DigestSendFn;
  private readonly passthrough: Set<NotificationEvent['type']>;
  private readonly maxBatchSize: number;
  private readonly intervalMs?: number;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: DigestNotificationAdapterOptions) {
    this.send = opts.send;
    this.passthrough = new Set(opts.passthrough ?? DEFAULT_PASSTHROUGH);
    this.maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
    this.intervalMs = opts.intervalMs;
    this.logger = opts.logger ?? noopLogger;
    this.clock = opts.clock ?? systemClock;

    if (this.intervalMs !== undefined) {
      if (this.intervalMs <= 0) {
        throw new Error('DigestNotificationAdapter: intervalMs must be a positive number.');
      }
      this.timer = setInterval(() => {
        void this.flush().catch((err) => {
          this.logger.error('DigestNotificationAdapter: scheduled flush failed', err);
        });
      }, this.intervalMs);
      // Never hold the process open for a convenience digest.
      this.timer.unref?.();
    }
  }

  /** Recipients currently holding buffered events. */
  get pendingRecipients(): number {
    return this.buffers.size;
  }

  async notify(event: NotificationEvent): Promise<void> {
    if (this.passthrough.has(event.type)) {
      await this.deliver({
        recipient: '',
        events: [event],
        since: event.timestamp,
        flushedAt: this.clock.now(),
      });
      return;
    }

    const now = this.clock.now();
    const full: string[] = [];

    for (const recipient of event.recipients) {
      const buffer = this.buffers.get(recipient) ?? { events: [], since: now };
      buffer.events.push(event);
      this.buffers.set(recipient, buffer);
      if (buffer.events.length >= this.maxBatchSize) full.push(recipient);
    }

    // Flush over-full recipients only; a burst aimed at one person must not
    // force everybody else's digest out early.
    for (const recipient of full) {
      await this.flushRecipient(recipient);
    }
  }

  /** Deliver every buffered digest now. Safe to call from a cron job or on shutdown. */
  async flush(): Promise<void> {
    for (const recipient of [...this.buffers.keys()]) {
      await this.flushRecipient(recipient);
    }
  }

  /** Stop the timer and deliver whatever is buffered. */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async flushRecipient(recipient: string): Promise<void> {
    const buffer = this.buffers.get(recipient);
    if (!buffer || buffer.events.length === 0) return;
    // Drop the buffer before sending: a send that throws must not replay the
    // same events into the next digest forever.
    this.buffers.delete(recipient);

    await this.deliver({
      recipient,
      events: buffer.events,
      since: buffer.since,
      flushedAt: this.clock.now(),
    });
  }

  private async deliver(digest: Digest): Promise<void> {
    try {
      await this.send(digest);
    } catch (err) {
      this.logger.error('DigestNotificationAdapter: send failed', err, {
        recipient: digest.recipient,
        events: digest.events.length,
      });
    }
  }
}
