import type { ISchedulerAdapter } from '../../adapters/ISchedulerAdapter.js';
import type { Clock } from '../../utils/Clock.js';
import { systemClock } from '../../utils/Clock.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';

/** Configuration for {@link InMemorySchedulerAdapter}. */
export interface InMemorySchedulerAdapterOptions {
  /** Structured logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
  /** Injectable clock — defaults to {@link systemClock}. Enables deterministic tests. */
  clock?: Clock;
}

/**
 * Reference {@link ISchedulerAdapter} implementation backed by `setTimeout`.
 *
 * This is the "no external dependency" default: a real BullMQ, Temporal, or
 * cron-backed adapter is a drop-in replacement for production use (surviving
 * process restarts, running across replicas), but this in-memory adapter is
 * enough to prove out {@link ISchedulerAdapter} wiring in tests or a
 * single-process deployment without pulling in a queue library.
 *
 * `scheduleAt` returns an opaque, per-call handle (not the underlying
 * `setTimeout` id) so callers never need to know the timer's native type.
 * `cancel` clears the matching timer; `shutdown` clears every timer still
 * pending, guaranteeing this adapter never keeps the event loop open past
 * teardown. Once `shutdown()` has run, further `scheduleAt` calls reject —
 * mirroring how a real queue client refuses new work after it disconnects.
 */
export class InMemorySchedulerAdapter implements ISchedulerAdapter {
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private nextHandleSeq = 0;
  private shuttingDown = false;

  constructor(opts: InMemorySchedulerAdapterOptions = {}) {
    this.logger = opts.logger ?? noopLogger;
    this.clock = opts.clock ?? systemClock;
  }

  /** @inheritdoc */
  async scheduleAt(id: string, runAt: Date, callback: () => Promise<void>): Promise<string> {
    if (this.shuttingDown) {
      throw new Error(
        'InMemorySchedulerAdapter: cannot schedule after shutdown() has been called.',
      );
    }

    const handle = `${id}:${++this.nextHandleSeq}`;
    const delayMs = Math.max(0, runAt.getTime() - this.clock.now().getTime());

    const timer = setTimeout(() => {
      this.timers.delete(handle);
      callback().catch((err: unknown) => {
        this.logger.error('InMemorySchedulerAdapter: scheduled callback threw', err, {
          id,
          handle,
        });
      });
    }, delayMs);

    this.timers.set(handle, timer);
    return handle;
  }

  /** @inheritdoc */
  async cancel(handle: string): Promise<void> {
    const timer = this.timers.get(handle);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(handle);
  }

  /** @inheritdoc */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }
}
