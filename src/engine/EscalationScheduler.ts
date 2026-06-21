import type { IStorageAdapter } from '../adapters/IStorageAdapter.js';
import type { Logger } from '../utils/Logger.js';
import { noopLogger } from '../utils/Logger.js';
import type { Clock } from '../utils/Clock.js';
import { systemClock } from '../utils/Clock.js';

export interface EscalationSchedulerOpts {
  adapter: IStorageAdapter;
  tenantId: string;
  onEscalate: (instanceId: string) => Promise<void>;
  onExpire?: (instanceId: string, deadlineAction: 'cancel' | 'reject') => Promise<void>;
  onSlaBreach?: (instanceId: string) => Promise<void>;
  onRevertDelegation?: (instanceId: string, levelNumber: number, fromApprover: string) => Promise<void>;
  pollIntervalMs?: number;
  logger?: Logger;
  clock?: Clock;
}

export class EscalationScheduler {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private tickPromise: Promise<void> | null = null;
  lastTickAt: Date | null = null;

  private readonly adapter: IStorageAdapter;
  private readonly tenantId: string;
  private readonly onEscalate: EscalationSchedulerOpts['onEscalate'];
  private readonly onExpire?: EscalationSchedulerOpts['onExpire'];
  private readonly onSlaBreach?: EscalationSchedulerOpts['onSlaBreach'];
  private readonly onRevertDelegation?: EscalationSchedulerOpts['onRevertDelegation'];
  private readonly pollIntervalMs: number;
  private readonly logger: Logger;
  private readonly clock: Clock;

  constructor(opts: EscalationSchedulerOpts) {
    this.adapter = opts.adapter;
    this.tenantId = opts.tenantId;
    this.onEscalate = opts.onEscalate;
    this.onExpire = opts.onExpire;
    this.onSlaBreach = opts.onSlaBreach;
    this.onRevertDelegation = opts.onRevertDelegation;
    this.pollIntervalMs = opts.pollIntervalMs ?? 60_000;
    this.logger = opts.logger ?? noopLogger;
    this.clock = opts.clock ?? systemClock;
  }

  get isRunning(): boolean {
    return this.intervalId !== null;
  }

  start(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      this.tickPromise = this.tick().catch((err) => {
        this.logger.error('EscalationScheduler: unhandled error in tick', err, { tenantId: this.tenantId });
      }).finally(() => { this.tickPromise = null; });
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Wait for any in-progress tick to finish
    if (this.tickPromise) {
      await this.tickPromise;
    }
  }

  async tick(): Promise<void> {
    this.lastTickAt = this.clock.now();
    const now = this.lastTickAt;

    let instances;
    try {
      instances = await this.adapter.getOverdueInstances(this.tenantId, now);
    } catch (err) {
      this.logger.error('EscalationScheduler: failed to fetch overdue instances', err, {
        tenantId: this.tenantId,
      });
      return;
    }

    for (const instance of instances) {
      try {
        // 1. Check delegation expiry — revert before other checks
        if (this.onRevertDelegation) {
          for (const level of instance.levels) {
            if (
              level.delegatedUntil &&
              new Date(level.delegatedUntil) <= now &&
              level.status === 'pending' &&
              level.delegatedFrom
            ) {
              try {
                await this.onRevertDelegation(instance.id, level.level, level.delegatedFrom);
              } catch (err) {
                this.logger.error('EscalationScheduler: failed to revert delegation', err, {
                  tenantId: this.tenantId,
                  instanceId: instance.id,
                  levelNumber: level.level,
                });
              }
            }
          }
        }

        // 2. Check instance expiry — takes priority over escalation
        if (instance.expiresAt && new Date(instance.expiresAt) <= now) {
          if (this.onExpire) {
            await this.onExpire(instance.id, instance.deadlineAction ?? 'cancel');
            this.logger.debug('EscalationScheduler: expired instance', {
              tenantId: this.tenantId,
              instanceId: instance.id,
              deadlineAction: instance.deadlineAction ?? 'cancel',
            });
          }
          continue;
        }

        // 3. Check SLA breach (non-blocking — escalation still runs)
        if (
          instance.slaDeadlineAt &&
          new Date(instance.slaDeadlineAt) <= now &&
          !instance.slaBreachedAt
        ) {
          if (this.onSlaBreach) {
            try {
              await this.onSlaBreach(instance.id);
              this.logger.warn('EscalationScheduler: SLA breached', {
                tenantId: this.tenantId,
                instanceId: instance.id,
                slaDeadlineAt: instance.slaDeadlineAt,
              });
            } catch (err) {
              this.logger.error('EscalationScheduler: failed to record SLA breach', err, {
                tenantId: this.tenantId,
                instanceId: instance.id,
              });
            }
          }
        }

        // 4. Check escalation
        const currentLevel = instance.levels.find((l) => l.level === instance.currentLevel);
        if (currentLevel?.escalationDueAt && new Date(currentLevel.escalationDueAt) <= now) {
          await this.onEscalate(instance.id);
          this.logger.debug('EscalationScheduler: escalated instance', {
            tenantId: this.tenantId,
            instanceId: instance.id,
          });
        }
      } catch (err) {
        this.logger.error('EscalationScheduler: failed to process instance', err, {
          tenantId: this.tenantId,
          instanceId: instance.id,
        });
      }
    }
  }

  static computeEscalationDue(
    escalationAfterDays: number,
    fromDate: Date,
  ): Date | undefined {
    if (escalationAfterDays <= 0) return undefined;
    const due = new Date(fromDate);
    due.setDate(due.getDate() + escalationAfterDays);
    return due;
  }
}
