export interface ISchedulerAdapter {
  /**
   * Schedule a one-shot callback to run at the given date.
   * Returns an opaque handle that can be passed to cancel().
   */
  scheduleAt(id: string, runAt: Date, callback: () => Promise<void>): Promise<string>;

  /** Cancel a previously scheduled callback by its handle. */
  cancel(handle: string): Promise<void>;

  /** Gracefully shut down the scheduler and release resources. */
  shutdown(): Promise<void>;
}
