import type { Clock } from '../utils/Clock.js';
import type { ApprovalInstance } from '../types/index.js';
import type { ApprovalEngineOptions } from '../engine/ApprovalEngine.js';
import { ApprovalEngine } from '../engine/ApprovalEngine.js';
import { MemoryAdapter } from '../adapters/MemoryAdapter.js';

/**
 * A `Clock` a test controls directly, so escalation/reminder/SLA deadlines
 * can be crossed deterministically instead of waiting on real time.
 */
export class ManualClock implements Clock {
  private current: Date;

  /** @param start - The initial time. Defaults to the Unix epoch. */
  constructor(start?: Date) {
    this.current = start ? new Date(start.getTime()) : new Date(0);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  /** Move the clock forward by `ms` milliseconds. */
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  /** Move the clock forward by `days` days. */
  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }

  /** Jump the clock to an absolute point in time. */
  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

/**
 * Static helpers for standing up an `ApprovalEngine` and driving it through
 * an approval chain in tests, without repeating the same `MemoryAdapter` +
 * `ManualClock` wiring in every test file.
 */
export class ApprovalTestKit {
  /**
   * Build an `ApprovalEngine` wired to a `MemoryAdapter` and a `ManualClock`
   * fixed at 2025-01-01, with escalation polling disabled so a test controls
   * every tick itself.
   *
   * @param opts - Overrides merged over the defaults; pass your own
   *   `MemoryAdapter` via `opts.adapter` to reuse one across engines.
   */
  static create(opts?: Partial<ApprovalEngineOptions>): {
    engine: ApprovalEngine;
    adapter: MemoryAdapter;
    clock: ManualClock;
  } {
    const adapter = opts?.adapter instanceof MemoryAdapter ? opts.adapter : new MemoryAdapter();
    const clock = new ManualClock(new Date('2025-01-01T00:00:00Z'));
    const engine = new ApprovalEngine({
      adapter,
      tenantId: 'test',
      clock,
      escalationPollIntervalMs: 0,
      ...opts,
      ...(!(opts?.adapter instanceof MemoryAdapter) ? { adapter } : {}),
    });
    return { engine, adapter: adapter as MemoryAdapter, clock };
  }

  /** Fully approve an instance by providing approver IDs keyed by level number. */
  static async fullyApprove(
    engine: ApprovalEngine,
    instanceId: string,
    approverMap: Record<number, string>,
  ): Promise<ApprovalInstance> {
    let instance = await engine.getInstance(instanceId);

    while (instance.status === 'pending') {
      // Every open level, not just instance.currentLevel: a parallel group has
      // several branches open at once, and approving only the lowest would
      // re-offer the same decision forever once that branch closed.
      const open = instance.levels.filter((l) => l.status === 'pending');
      if (open.length === 0) break;

      for (const level of open) {
        const approverId = approverMap[level.level];
        if (!approverId) {
          throw new Error(
            `No approver provided for level ${level.level}. Pass all levels in approverMap.`,
          );
        }
        instance = await engine.approve(instanceId, { approverId, level: level.level });
        if (instance.status !== 'pending') break;
      }
    }

    return instance;
  }
}
