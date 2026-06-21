import type { Clock } from '../utils/Clock.js';
import type { ApprovalInstance } from '../types/index.js';
import type { ApprovalEngineOptions } from '../engine/ApprovalEngine.js';
import { ApprovalEngine } from '../engine/ApprovalEngine.js';
import { MemoryAdapter } from '../adapters/MemoryAdapter.js';

export class ManualClock implements Clock {
  private current: Date;

  constructor(start?: Date) {
    this.current = start ? new Date(start.getTime()) : new Date(0);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }

  advanceDays(days: number): void {
    this.advance(days * 86_400_000);
  }

  set(date: Date): void {
    this.current = new Date(date.getTime());
  }
}

export class ApprovalTestKit {
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
      const approverId = approverMap[instance.currentLevel];
      if (!approverId) {
        throw new Error(
          `No approver provided for level ${instance.currentLevel}. Pass all levels in approverMap.`,
        );
      }
      instance = await engine.approve(instanceId, { approverId });
    }

    return instance;
  }
}
