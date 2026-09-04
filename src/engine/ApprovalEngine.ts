import { createHash } from 'node:crypto';
import type {
  IStorageAdapter,
  InstanceFilter,
  PaginationOpts,
  PaginatedResult,
  CursorPaginationOpts,
  CursorPaginatedResult,
} from '../adapters/IStorageAdapter.js';
import type {
  ApprovalTemplate,
  ApprovalTemplateConfig,
  ApprovalLevelConfig,
  ApprovalInstance,
  ApprovalLevelInstance,
  ApprovalStatus,
  LevelStatus,
  Comment,
  EscalationStep,
  Attachment,
  AuditEntry,
  AuditContext,
  ResolverFn,
  ApprovalEventName,
  ApprovalEventMap,
  ApprovalMode,
} from '../types/index.js';
import {
  SubmitOptionsSchema,
  ApproveOptionsSchema,
  RejectOptionsSchema,
  DelegateOptionsSchema,
  ReassignOptionsSchema,
  CancelOptionsSchema,
  EscalateOptionsSchema,
  ResubmitOptionsSchema,
  AddCommentOptionsSchema,
  OverrideOptionsSchema,
  UpdateDataOptionsSchema,
  RequestInfoOptionsSchema,
  AddAttachmentOptionsSchema,
  RemoveAttachmentOptionsSchema,
  TransferApprovalsOptionsSchema,
  ProvideInfoOptionsSchema,
  type SubmitOptions,
  type ApproveOptions,
  type RejectOptions,
  type DelegateOptions,
  type ReassignOptions,
  type CancelOptions,
  type EscalateOptions,
  type ResubmitOptions,
  type AddCommentOptions,
  type OverrideOptions,
  type UpdateDataOptions,
  type RequestInfoOptions,
  type AddAttachmentOptions,
  type RemoveAttachmentOptions,
  type TransferApprovalsOptions,
  type ProvideInfoOptions,
} from '../utils/validate.js';
import { MemoryAdapter } from '../adapters/MemoryAdapter.js';
import { EventBus } from '../utils/EventBus.js';
import type { Logger } from '../utils/Logger.js';
import { noopLogger } from '../utils/Logger.js';
import type { Clock } from '../utils/Clock.js';
import { systemClock } from '../utils/Clock.js';
import type { BusinessCalendar } from '../utils/BusinessCalendar.js';
import type { IdGeneratorPrefix } from '../utils/IdGenerator.js';
import { defaultIdGenerator } from '../utils/IdGenerator.js';
import { TemplateRegistry } from './TemplateRegistry.js';
import {
  LevelResolver,
  type OrgProvider,
  type ApproverResolverFn,
  type OutOfOfficeProvider,
} from './LevelResolver.js';
import { EscalationScheduler } from './EscalationScheduler.js';
import {
  evaluateConditions,
  registerConditionOperator,
  validateConditionExpression,
  type ConditionOperatorFn,
} from './ConditionEvaluator.js';
import {
  assertStatus,
  assertApproverOnLevel,
  hasAlreadyActed,
  isLevelApproved,
  isLevelRejected,
} from './StateMachine.js';
import {
  ApprovalError,
  ApprovalNotFoundError,
  ApprovalConflictError,
  ApprovalForbiddenError,
  ApprovalValidationError,
  ApprovalTemplateNotFoundError,
} from '../errors.js';
import type { INotificationAdapter } from '../adapters/INotificationAdapter.js';
import type { IAuditAdapter } from '../adapters/IAuditAdapter.js';
import type { IMetricsAdapter } from '../adapters/IMetricsAdapter.js';
import type { ISchedulerAdapter } from '../adapters/ISchedulerAdapter.js';
import type { IAuthorizationPolicy, AuthorizationContext } from './IAuthorizationPolicy.js';
import type { IOperationMiddleware, OperationContext } from './IOperationMiddleware.js';
import { computeTimingStats, type TimingStats } from '../plugins/metrics/stats.js';

export { ApprovalError } from '../errors.js';
export {
  ApprovalNotFoundError,
  ApprovalConflictError,
  ApprovalForbiddenError,
  ApprovalValidationError,
  ApprovalTemplateNotFoundError,
} from '../errors.js';

/** Reminders sent for one level before the engine stops nudging, absent an explicit cap. */
/** How deep sub-workflows may nest before the engine refuses, so a template cycle terminates. */
const MAX_SUBWORKFLOW_DEPTH = 5;
/** Instances one purge sweep will remove unless the caller raises it. */
const DEFAULT_PURGE_LIMIT = 1000;
const DEFAULT_MAX_REMINDERS = 3;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 50;
const TERMINAL_STATUSES = new Set<ApprovalInstance['status']>([
  'approved',
  'rejected',
  'cancelled',
  'expired',
]);
/** Statuses counted as "completed" for cycle-time analytics — see {@link ApprovalStatistics.cycleTime}. */
const CYCLE_TIME_STATUSES: ApprovalInstance['status'][] = ['approved', 'rejected', 'cancelled'];
/** Page size used when paging through a full result set via `getInstancesByFilter`. */
const CYCLE_TIME_FETCH_BATCH_SIZE = 500;

// ─── Exported result types ─────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}

export interface CanApproveResult {
  eligible: boolean;
  reason?:
    | 'not_an_approver'
    | 'already_acted'
    | 'self_approval'
    | 'wrong_status'
    | 'delegated_away';
}

export interface PreviewChainLevel {
  level: number;
  name: string;
  resolvedApprovers: string[];
  mode: ApprovalMode;
}

export interface PreviewResult {
  levels: PreviewChainLevel[];
  /** Indices (0-based) of conditions that fired for this data. */
  conditionsApplied: number[];
}

/** Where one level in an explained chain came from. */
export interface ExplainedLevel {
  level: number;
  name: string;
  mode: ApprovalMode;
  /** `'template'` for a statically declared level, `'condition'` for one a rule added. */
  source: 'template' | 'condition';
  /** Index of the condition rule that added it, when `source` is `'condition'`. */
  addedByRule?: number;
  resolvedApprovers: string[];
  /** Why approver resolution failed, when it did. The level is still listed. */
  resolutionError?: string;
  /** Set when this level hands off to a child approval. */
  subWorkflowTemplate?: string;
}

/** A level the template declares that will not run, and the rule that removed it. */
export interface ExplainedSkip {
  level: number;
  name: string;
  /** Index of the condition rule whose `skipLevels` removed it. */
  skippedByRule: number;
}

/** How one condition rule evaluated against the data. */
export interface ExplainedRule {
  index: number;
  matched: boolean;
  /** Levels this rule would add. Present whether or not it matched. */
  addsLevels: number[];
  /** Levels this rule would skip. Present whether or not it matched. */
  skipsLevels: number[];
  /** Why the rule could not be evaluated, e.g. an unregistered operator. */
  error?: string;
}

/**
 * A full account of why a chain looks the way it does.
 *
 * `previewApprovalChain()` answers *what* the chain will be; this answers *why*,
 * which is the question a support engineer actually has when a purchase order
 * arrives with a level nobody expected.
 */
export interface ChainExplanation {
  templateName: string;
  levels: ExplainedLevel[];
  skipped: ExplainedSkip[];
  rules: ExplainedRule[];
}

/** One scripted decision in a {@link ApprovalEngine.simulate} run. */
export type SimulatedDecision =
  | { approve: string; level?: number; comment?: string }
  | { reject: string; level?: number; reason?: string };

/** What one scripted decision did. */
export interface SimulationStep {
  /** 1-based position in the script. */
  step: number;
  action: 'approve' | 'reject';
  actorId: string;
  /** The level the decision landed on, when it was accepted. */
  level?: number;
  /** Instance status after the decision. */
  status: ApprovalStatus;
  /** Why the decision was refused, when it was. The run stops at the first refusal. */
  error?: string;
}

/** Outcome of a {@link ApprovalEngine.simulate} run. */
export interface SimulationResult {
  finalStatus: ApprovalStatus;
  /** The chain the document would get, in order. */
  levels: Array<{ level: number; name: string; status: LevelStatus; approvers: string[] }>;
  transcript: SimulationStep[];
  /** Levels never reached because the run ended first. */
  unreachedLevels: number[];
  /** True when the script ran out before the approval finished. */
  incomplete: boolean;
}

export interface BulkResult {
  succeeded: ApprovalInstance[];
  failed: Array<{ instanceId: string; error: ApprovalError }>;
  total: number;
}

/** Outcome of a {@link ApprovalEngine.transferApprovals} sweep. */
export interface TransferResult {
  /** One entry per level actually moved (an instance can hold the approver on several open branches). */
  transferred: Array<{ instanceId: string; level: number; documentId: string }>;
  /** Instances that could not be moved, with the reason. */
  failed: Array<{ instanceId: string; error: ApprovalError }>;
  /** Instances examined. */
  scanned: number;
  /** True when nothing was written. */
  dryRun: boolean;
}

/**
 * What one approver currently owes a decision on.
 *
 * Durations are milliseconds. An approver appears only while they hold at least
 * one open level.
 */
export interface ApproverWorkload {
  approverId: string;
  /** Open levels assigned to them. One instance can contribute several across parallel branches. */
  pending: number;
  /** Distinct documents involved — usually, but not always, equal to {@link pending}. */
  instances: number;
  /** Open levels already past their escalation deadline. */
  overdue: number;
  /** Open levels currently paused by a clarification request. */
  onHold: number;
  /** When the oldest of their open items was submitted. */
  oldestPendingAt?: Date;
  /** Age of that oldest item. `0` when they hold nothing. */
  oldestAgeMs: number;
}

/** Version stamp on an exported bundle, so an importer can reject a shape it does not understand. */
export const TEMPLATE_BUNDLE_VERSION = 1;

/**
 * A portable set of templates, safe to move between environments.
 *
 * Deliberately carries no `id`, `tenantId`, `createdAt`, `version` or
 * `previousVersionId`: those describe one row in one database, and importing
 * them would either collide with the target's own ids or silently claim a
 * lineage the target never had.
 */
export interface TemplateBundle {
  bundleVersion: number;
  exportedAt: Date;
  templates: ApprovalTemplateConfig[];
}

/** Outcome of {@link ApprovalEngine.importTemplates}. */
export interface ImportResult {
  created: string[];
  updated: string[];
  skipped: string[];
  errors: Array<{ name: string; message: string }>;
  dryRun: boolean;
}

/** Outcome of a {@link ApprovalEngine.purgeInstances} sweep. */
export interface PurgeResult {
  /** Instances actually removed (or that would be, under `dryRun`). */
  purged: Array<{ instanceId: string; documentId: string; status: ApprovalInstance['status'] }>;
  /** Instances examined. */
  scanned: number;
  /** True when nothing was written. */
  dryRun: boolean;
}

export interface ApprovalStatistics {
  /** Total instances matching the filter (across all statuses). */
  total: number;
  /** Count per status. */
  byStatus: Record<ApprovalInstance['status'], number>;
  /** Instances still pending past their escalation/expiry deadline. */
  overdue: number;
  /** approved / (approved + rejected); 0 when nothing has been resolved. */
  approvalRate: number;
  /**
   * Counts broken down per template name. Only populated (non-empty) when the
   * global statistics are scoped with a filter that already lists the tenant's
   * templates — i.e. this engine always returns the per-template breakdown for
   * its own tenant. Absent when no instances match the filter.
   */
  byTemplate: Record<
    string,
    { total: number; approved: number; rejected: number; pending: number }
  >;
  /**
   * Time-to-decision ("cycle time") analytics, in milliseconds, for
   * **completed** instances matching the filter — status `'approved'`,
   * `'rejected'`, or `'cancelled'`. `'expired'` instances are excluded: their
   * terminal timestamp reflects a scheduler deadline firing, not a decision
   * being made, so they would skew the distribution rather than describe it.
   *
   * Elapsed time per instance is `updatedAt - createdAt`: `createdAt` is the
   * submission instant, and `updatedAt` is set at the moment the instance
   * transitions to its terminal status (see {@link ApprovalEngine.approve},
   * {@link ApprovalEngine.reject}, {@link ApprovalEngine.cancel}). See
   * {@link CycleTimeStats} for the zeroed shape returned when there are no
   * completed instances.
   */
  cycleTime: CycleTimeStats;
  /**
   * The same {@link cycleTime} analytics broken down per template name.
   * Mirrors the {@link byTemplate} population rule: a template only appears
   * here when at least one of its instances is completed (`count > 0`).
   */
  cycleTimeByTemplate: Record<string, CycleTimeStats>;
}

/**
 * Time-to-decision ("cycle time") statistics for a set of completed approval
 * instances. All duration fields are in **milliseconds**.
 *
 * When {@link count} is `0` (no completed instances matched), every other
 * field is `0` — never `NaN` — mirroring {@link computeTimingStats}'s
 * empty-input behavior, which this type's values are derived from.
 */
export interface CycleTimeStats {
  /** Number of completed instances included in this computation. */
  count: number;
  /** Arithmetic mean time-to-decision. `0` when {@link count} is `0`. */
  averageMs: number;
  /** 50th percentile (median) time-to-decision, via nearest-rank. `0` when {@link count} is `0`. */
  p50Ms: number;
  /** 95th percentile time-to-decision, via nearest-rank. `0` when {@link count} is `0`. */
  p95Ms: number;
  /** Smallest observed time-to-decision. `0` when {@link count} is `0`. */
  minMs: number;
  /** Largest observed time-to-decision. `0` when {@link count} is `0`. */
  maxMs: number;
}

export interface HealthResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  adapter: 'connected' | 'error';
  pendingCount: number;
  overdueCount: number;
  escalationRunning: boolean;
  lastTickAt?: Date;
}

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  jitter?: boolean;
}

export type IdempotencyKeyFn = (
  tenantId: string,
  documentType: string,
  documentId: string,
  templateName: string,
  data: Record<string, unknown>,
) => string;

// ─── Engine options ────────────────────────────────────────────────────────

export interface ApprovalEngineOptions {
  adapter: IStorageAdapter;
  tenantId?: string;
  orgProvider?: OrgProvider;
  /**
   * Supplies stand-ins for approvers who are away, so leave does not stall a
   * chain. Consulted every time approvers are resolved.
   */
  outOfOfficeProvider?: OutOfOfficeProvider;
  logger?: Logger;
  escalationPollIntervalMs?: number;
  /** Maximum number of instances allowed in a single bulk operation. Default: 200. */
  maxBulkItems?: number;
  /** Injectable clock — defaults to system clock. Enables deterministic tests and custom time sources. */
  clock?: Clock;
  /**
   * Optional business-day calendar. When provided, escalationAfterDays and
   * slaDeadlineDays are interpreted as business days (skipping weekends and
   * holidays) instead of plain calendar days. See weekendCalendar().
   */
  calendar?: BusinessCalendar;
  /** Custom ID generator for instances and templates. Defaults to timestamp+random. */
  generateId?: (prefix: IdGeneratorPrefix) => string;
  /** Custom optimistic locking retry policy. */
  retryPolicy?: RetryPolicy;
  /** Custom idempotency key derivation function. Default: SHA-256 of tenant+documentType+documentId+templateName. */
  idempotencyKeyFn?: IdempotencyKeyFn;
  /** Notification adapter called after every approval event. */
  notificationAdapter?: INotificationAdapter;
  /** Separate append-only audit sink (Kafka, S3, CloudTrail). Called alongside storage adapter. */
  auditAdapter?: IAuditAdapter;
  /** Metrics adapter for Prometheus / Datadog / OpenTelemetry. */
  metricsAdapter?: IMetricsAdapter;
  /**
   * Custom scheduler adapter (BullMQ, Temporal, cron) that drives the recurring
   * escalation/expiry/SLA-breach/delegation-revert scan.
   *
   * When provided, the built-in `setInterval` poll (see
   * {@link EscalationScheduler.start}) is never started. Instead,
   * {@link ISchedulerAdapter.scheduleAt} schedules each scan, and its callback
   * reschedules the next one itself once the scan completes — the adapter
   * changes *how* the periodic scan is triggered, not *what* it scans; every
   * tick still runs the exact same overdue-instance query the built-in poller
   * runs. {@link ISchedulerAdapter.cancel} and {@link ISchedulerAdapter.shutdown}
   * are invoked during {@link ApprovalEngine.shutdown}. Omitting this option
   * preserves the built-in `setInterval` polling behavior unchanged.
   */
  schedulerAdapter?: ISchedulerAdapter;
  /** Authorization policy called before every mutating operation. */
  authorizationPolicy?: IAuthorizationPolicy;
  /** Middleware chain: before/after/onError hooks for every operation. */
  middleware?: IOperationMiddleware[];
}

// ─── Engine ───────────────────────────────────────────────────────────────

export class ApprovalEngine {
  private readonly bus = new EventBus();
  private readonly registry: TemplateRegistry;
  private readonly resolver: LevelResolver;
  private readonly escalation: EscalationScheduler;
  private readonly escalationPollIntervalMs: number;
  private readonly tenantId: string;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly calendar?: BusinessCalendar;
  private readonly generateId: (prefix: IdGeneratorPrefix) => string;
  private readonly maxBulkItems: number;
  private readonly retryPolicy: Required<RetryPolicy>;
  private readonly idempotencyKeyFn: IdempotencyKeyFn;
  /** Handle for the currently-scheduled escalation tick when {@link ApprovalEngineOptions.schedulerAdapter} is set. */
  private schedulerAdapterHandle: string | null = null;
  /** Set by {@link shutdown}; stops the self-rescheduling loop from scheduling another tick. */
  private schedulerStopped = false;

  constructor(private readonly opts: ApprovalEngineOptions) {
    this.tenantId = opts.tenantId ?? 'default';
    this.logger = opts.logger ?? noopLogger;
    // A subscriber's listener must never abort the operation that emitted the
    // event; report and carry on, as the notification/audit paths do.
    this.bus.setListenerErrorHandler((err, event) => {
      this.logger.error('event listener threw', err, { tenantId: this.tenantId, event });
    });
    this.clock = opts.clock ?? systemClock;
    this.calendar = opts.calendar;
    this.generateId = opts.generateId ?? defaultIdGenerator;
    this.maxBulkItems = opts.maxBulkItems ?? 200;
    this.escalationPollIntervalMs = opts.escalationPollIntervalMs ?? 60_000;
    this.retryPolicy = {
      maxAttempts: opts.retryPolicy?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      baseDelayMs: opts.retryPolicy?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: opts.retryPolicy?.maxDelayMs ?? Infinity,
      jitter: opts.retryPolicy?.jitter ?? true,
    };
    this.idempotencyKeyFn = opts.idempotencyKeyFn ?? defaultIdempotencyKeyFn;

    this.registry = new TemplateRegistry(opts.adapter, this.tenantId, {
      clock: this.clock,
      generateId: this.generateId,
    });
    this.resolver = new LevelResolver();
    this.escalation = new EscalationScheduler({
      adapter: opts.adapter,
      tenantId: this.tenantId,
      onEscalate: async (id, levelNumber) => {
        await this.escalateInternal(id, 'system', undefined, levelNumber);
      },
      onExpire: async (id, action) => {
        await this.expireInstance(id, action);
      },
      onSlaBreach: async (id) => {
        await this.markSlaBreached(id);
      },
      onRevertDelegation: async (id, level, from) => {
        await this.revertDelegation(id, level, from);
      },
      onRemind: async (id, levelNumber) => {
        await this.sendReminder(id, levelNumber);
      },
      pollIntervalMs: this.escalationPollIntervalMs,
      logger: this.logger,
      clock: this.clock,
    });
    if (opts.schedulerAdapter) {
      this.scheduleNextEscalationTick(opts.schedulerAdapter);
    } else {
      this.escalation.start();
    }
  }

  on<K extends ApprovalEventName>(event: K, listener: (payload: ApprovalEventMap[K]) => void) {
    this.bus.on(event, listener);
    return this;
  }

  off<K extends ApprovalEventName>(event: K, listener: (payload: ApprovalEventMap[K]) => void) {
    this.bus.off(event, listener);
    return this;
  }

  registerResolver(name: string, fn: ResolverFn): void {
    this.resolver.register(name, fn);
  }

  registerApproverType(typeName: string, fn: ApproverResolverFn): void {
    this.resolver.registerApproverType(typeName, fn);
  }

  registerConditionOperator(name: string, fn: ConditionOperatorFn): void {
    registerConditionOperator(name, fn);
  }

  // ─── Template management ──────────────────────────────────────────────────

  /** Validate a template config without persisting. Synchronous; never throws. */
  validateTemplate(config: ApprovalTemplateConfig): ValidationResult {
    const errors: Array<{ field: string; message: string }> = [];

    // A config that declares `extends` may legitimately carry no levels of its
    // own — the chain comes from the base. defineTemplate validates the
    // flattened result, which is what instances actually run against.
    const hasOwnLevels = Boolean(config.levels && config.levels.length > 0);
    if (!hasOwnLevels && config.extends === undefined) {
      errors.push({ field: 'levels', message: 'Template must have at least one level.' });
    }
    if (hasOwnLevels) {
      const levelNums = new Set<number>();
      config.levels.forEach((l, i) => {
        if (levelNums.has(l.level)) {
          errors.push({
            field: `levels[${i}].level`,
            message: `Duplicate level number: ${l.level}.`,
          });
        }
        levelNums.add(l.level);

        // A sub-workflow level is decided by its child approval, so it needs no
        // approvers of its own — requiring them would force template authors to
        // invent a placeholder nobody ever asks.
        if (!l.subWorkflow && (!l.approvers || l.approvers.length === 0)) {
          errors.push({
            field: `levels[${i}].approvers`,
            message: `Level ${l.level} must have at least one approver.`,
          });
        }
        if (l.subWorkflow) {
          if (!l.subWorkflow.templateName) {
            errors.push({
              field: `levels[${i}].subWorkflow.templateName`,
              message: `Level ${l.level} declares a subWorkflow without a templateName.`,
            });
          }
          if (l.subWorkflow.templateName === config.name) {
            errors.push({
              field: `levels[${i}].subWorkflow.templateName`,
              message: `Level ${l.level} would spawn a sub-workflow of its own template ("${config.name}"), which cannot terminate.`,
            });
          }
          if (l.approvers && l.approvers.length > 0) {
            errors.push({
              field: `levels[${i}].approvers`,
              message: `Level ${l.level} sets both approvers and subWorkflow; a sub-workflow level is decided by its child approval, so its approvers would never be asked.`,
            });
          }
        }
        if (l.reminderAfterDays !== undefined && l.reminderAfterDays <= 0) {
          errors.push({
            field: `levels[${i}].reminderAfterDays`,
            message: `Level ${l.level} reminderAfterDays must be a positive number.`,
          });
        }
        if (l.reminderEveryDays !== undefined && l.reminderEveryDays <= 0) {
          errors.push({
            field: `levels[${i}].reminderEveryDays`,
            message: `Level ${l.level} reminderEveryDays must be a positive number.`,
          });
        }
        if (
          l.maxReminders !== undefined &&
          (!Number.isInteger(l.maxReminders) || l.maxReminders < 1)
        ) {
          errors.push({
            field: `levels[${i}].maxReminders`,
            message: `Level ${l.level} maxReminders must be a positive integer.`,
          });
        }
        if (l.reminderEveryDays !== undefined && l.reminderAfterDays === undefined) {
          errors.push({
            field: `levels[${i}].reminderEveryDays`,
            message: `Level ${l.level} sets reminderEveryDays without reminderAfterDays, so no reminder would ever be sent.`,
          });
        }
        if (l.escalationAfterHours !== undefined && l.escalationAfterHours <= 0) {
          errors.push({
            field: `levels[${i}].escalationAfterHours`,
            message: `Level ${l.level} escalationAfterHours must be a positive number.`,
          });
        }
        if (l.escalationAfterDays !== undefined && l.escalationAfterHours !== undefined) {
          errors.push({
            field: `levels[${i}].escalationAfterHours`,
            message: `Level ${l.level} sets both escalationAfterDays and escalationAfterHours; pick one so the deadline is unambiguous.`,
          });
        }
        if (l.escalationAfterDays !== undefined && l.escalationAfterDays <= 0) {
          errors.push({
            field: `levels[${i}].escalationAfterDays`,
            message: `Level ${l.level} escalationAfterDays must be a positive number.`,
          });
        }

        if (l.mode === 'quorum') {
          if (
            l.minApprovals === undefined ||
            !Number.isInteger(l.minApprovals) ||
            l.minApprovals < 1
          ) {
            errors.push({
              field: `levels[${i}].minApprovals`,
              message: `Level ${l.level} uses 'quorum' mode and requires minApprovals to be a positive integer.`,
            });
          } else if (l.approvers && l.minApprovals > l.approvers.length) {
            // Conservative static check: only meaningful when every approver is a static 'user'.
            const allStaticUsers = l.approvers.every((a) => a.type === 'user');
            if (allStaticUsers) {
              errors.push({
                field: `levels[${i}].minApprovals`,
                message: `Level ${l.level} requires ${l.minApprovals} approvals but only ${l.approvers.length} approver(s) are configured.`,
              });
            }
          }
        }

        if (l.mode === 'weighted') {
          if (l.threshold === undefined || l.threshold <= 0) {
            errors.push({
              field: `levels[${i}].threshold`,
              message: `Level ${l.level} uses 'weighted' mode and requires threshold to be a positive number.`,
            });
          }
          if (l.weights) {
            for (const [id, w] of Object.entries(l.weights)) {
              if (typeof w !== 'number' || w < 0 || Number.isNaN(w)) {
                errors.push({
                  field: `levels[${i}].weights.${id}`,
                  message: `Weight for "${id}" must be a non-negative number.`,
                });
              }
            }
          }
        }
      });
    }

    // A group's levels must form one unbroken run, so that "advance past the
    // group" and "advance past a level" cannot disagree about what comes next.
    // An interleaved group would otherwise activate a level from outside it.
    if (config.levels && config.levels.length > 0) {
      const ordered = [...config.levels].sort((a, b) => a.level - b.level);
      const seenGroups = new Set<string>();
      let previousGroup: string | null = null;
      ordered.forEach((l) => {
        const key = l.group;
        if (key === undefined) {
          previousGroup = null;
          return;
        }
        if (key !== previousGroup) {
          if (seenGroups.has(key)) {
            errors.push({
              field: 'levels',
              message: `Parallel group "${key}" is not contiguous — its levels must occupy consecutive level numbers with no other level in between.`,
            });
          }
          seenGroups.add(key);
          previousGroup = key;
        }
      });
    }

    if (config.slaDeadlineDays !== undefined && config.slaDeadlineHours !== undefined) {
      errors.push({
        field: 'slaDeadlineHours',
        message:
          'Template sets both slaDeadlineDays and slaDeadlineHours; pick one so the SLA is unambiguous.',
      });
    }
    if (config.slaDeadlineHours !== undefined && config.slaDeadlineHours <= 0) {
      errors.push({
        field: 'slaDeadlineHours',
        message: 'slaDeadlineHours must be a positive number.',
      });
    }

    if (config.conditions) {
      config.conditions.forEach((rule, ruleIdx) => {
        errors.push(...validateConditionExpression(rule.when, `conditions[${ruleIdx}].when`));
        if (rule.addLevels) {
          rule.addLevels.forEach((al, alIdx) => {
            const conflictsWithStatic = config.levels.some((l) => l.level === al.level);
            if (conflictsWithStatic) {
              errors.push({
                field: `conditions[${ruleIdx}].addLevels[${alIdx}].level`,
                message: `Level ${al.level} in addLevels conflicts with an existing static level.`,
              });
            }
            if (rule.skipLevels?.includes(al.level)) {
              errors.push({
                field: `conditions[${ruleIdx}].addLevels[${alIdx}].level`,
                message: `Level ${al.level} appears in both addLevels and skipLevels in the same condition.`,
              });
            }
          });
        }
      });
    }

    return { valid: errors.length === 0, errors };
  }

  async defineTemplate(config: ApprovalTemplateConfig): Promise<string> {
    // Validate the RESOLVED template: a derived config is often invalid on its
    // own (it may declare no levels at all, inheriting the whole chain), and it
    // is the flattened result that instances actually run against.
    const resolved = await this.registry.resolveInheritance(config);
    const validation = this.validateTemplate(resolved);
    if (!validation.valid) {
      const first = validation.errors[0];
      throw new ApprovalValidationError(
        `Invalid template configuration: ${first?.message ?? 'unknown error'}`,
      );
    }
    return this.registry.define(resolved);
  }

  /** Update an existing template, incrementing its version. In-flight instances are protected by their templateSnapshot. */
  async updateTemplate(config: ApprovalTemplateConfig): Promise<string> {
    const resolved = await this.registry.resolveInheritance(config);
    const validation = this.validateTemplate(resolved);
    if (!validation.valid) {
      const first = validation.errors[0];
      throw new ApprovalValidationError(
        `Invalid template configuration: ${first?.message ?? 'unknown error'}`,
      );
    }
    return this.registry.update(resolved);
  }

  async getTemplate(name: string): Promise<ApprovalTemplate> {
    return this.registry.get(name);
  }

  async listTemplates(): Promise<ApprovalTemplate[]> {
    return this.registry.list();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async submit(
    raw: SubmitOptions,
    auditCtx?: AuditContext,
    /**
     * @internal Set only when the engine spawns a sub-workflow child. Passed at
     * creation rather than stamped afterwards, because the child spawns its own
     * children before any post-submit update could reach it — which is how a
     * grandchild ended up recorded at depth 1.
     */
    link?: { parentInstanceId: string; parentLevel: number; depth: number },
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => SubmitOptionsSchema.parse(raw));
    const startMs = this.clock.now().getTime();
    const template = await this.registry.get(opts.templateName);

    const idempotencyKey = this.idempotencyKeyFn(
      this.tenantId,
      opts.documentType,
      opts.documentId,
      opts.templateName,
      opts.data,
    );
    const existing = await this.opts.adapter.getIdempotentInstance(this.tenantId, idempotencyKey);
    if (existing && !TERMINAL_STATUSES.has(existing.status)) {
      this.logger.info('submit: returning idempotent existing instance', {
        tenantId: this.tenantId,
        instanceId: existing.id,
        idempotencyKey,
      });
      return existing;
    }

    const mutations = evaluateConditions(template.conditions ?? [], opts.data);
    const allLevelCfgs = [...template.levels, ...mutations.addLevels]
      .filter((l) => !mutations.skipLevels.has(l.level))
      .sort((a, b) => a.level - b.level);

    if (allLevelCfgs.length === 0) {
      throw new ApprovalValidationError(
        'Template has no active levels after condition evaluation. Check that skipLevels conditions are not removing all levels.',
      );
    }

    const levelNumSet = new Set(allLevelCfgs.map((l) => l.level));
    if (levelNumSet.size !== allLevelCfgs.length) {
      const seen = new Set<number>();
      for (const l of allLevelCfgs) {
        if (seen.has(l.level)) {
          throw new ApprovalValidationError(
            `Duplicate level number ${l.level} after condition evaluation. Check addLevels in conditions.`,
          );
        }
        seen.add(l.level);
      }
    }

    const now = this.clock.now();
    const instanceId = this.generateId('inst');

    // The opening step is a whole group, not a single level: every branch of a
    // leading parallel group starts collecting decisions at once.
    const firstCfg = allLevelCfgs[0];
    const firstGroupKey = firstCfg ? ApprovalEngine.groupKeyOf(firstCfg) : null;

    const firstRung = this.firstRungOf(template.escalationSteps);
    const levels: ApprovalLevelInstance[] = allLevelCfgs.map((cfg) =>
      this.buildLevelInstance(cfg, {
        open: ApprovalEngine.groupKeyOf(cfg) === firstGroupKey,
        now,
        firstRung,
      }),
    );

    for (const lvl of levels.filter((l) => l.status === 'pending')) {
      // A sub-workflow level has no approvers of its own — a child approval
      // decides it — so resolving here would fail on an empty approver list.
      if (lvl.subWorkflowTemplate) {
        lvl.approverIds = [];
        continue;
      }
      lvl.approverIds = await this.resolver.resolveApprovers(
        lvl.approverConfigs,
        opts.submittedBy,
        opts.data,
        this.opts.orgProvider,
        this.opts.outOfOfficeProvider,
        now,
      );
    }

    const auditEntry: AuditEntry = {
      action: 'submitted',
      actorId: opts.submittedBy,
      level: allLevelCfgs[0]?.level ?? 1,
      timestamp: now,
      ...auditCtx,
    };

    const slaDeadlineAt = template.slaDeadlineHours
      ? this.deadlineFromHours(now, template.slaDeadlineHours)
      : template.slaDeadlineDays
        ? this.deadlineFrom(now, template.slaDeadlineDays)
        : undefined;

    const instance: ApprovalInstance = {
      id: instanceId,
      tenantId: this.tenantId,
      parentInstanceId: link?.parentInstanceId,
      parentLevel: link?.parentLevel,
      subWorkflowDepth: link?.depth,
      templateId: template.id,
      templateName: template.name,
      documentId: opts.documentId,
      documentType: opts.documentType,
      submittedBy: opts.submittedBy,
      status: 'pending',
      currentLevel: allLevelCfgs[0]?.level ?? 1,
      version: 1,
      idempotencyKey,
      levels,
      auditLog: [auditEntry],
      data: opts.data,
      metadata: opts.metadata,
      createdAt: now,
      updatedAt: now,
      expiresAt: opts.expiresAt,
      deadlineAction: opts.deadlineAction,
      slaDeadlineAt,
      templateSnapshot: {
        escalation: template.escalation,
        escalationSteps: template.escalationSteps,
        slaDeadlineDays: template.slaDeadlineDays,
        slaDeadlineHours: template.slaDeadlineHours,
        allowOverride: template.allowOverride,
      },
    };

    await this.runMiddlewareBefore({
      operation: 'submit',
      actorId: opts.submittedBy,
      tenantId: this.tenantId,
      input: opts,
    });
    await this.opts.adapter.saveInstance(instance);

    this.logger.info('submit: instance created', {
      tenantId: this.tenantId,
      instanceId,
      documentId: opts.documentId,
      templateName: opts.templateName,
    });

    this.opts.metricsAdapter?.increment('approval.submitted', {
      tenantId: this.tenantId,
      templateName: template.name,
    });
    this.opts.metricsAdapter?.timing(
      'approval.operation_duration_ms',
      this.clock.now().getTime() - startMs,
      { operation: 'submit' },
    );

    const eventPayload = {
      instanceId: instance.id,
      documentId: instance.documentId,
      documentType: instance.documentType,
      timestamp: now,
      submittedBy: opts.submittedBy,
      // Union across the opening group — a parallel group has several open branches.
      currentApprovers: [
        ...new Set(levels.filter((l) => l.status === 'pending').flatMap((l) => l.approverIds)),
      ],
    };
    this.bus.emit('approval:submitted', eventPayload);
    await this.notifyAdapters('approval:submitted', instance, eventPayload);
    await this.runExternalAudit(instance, auditEntry);
    await this.runMiddlewareAfter(
      { operation: 'submit', actorId: opts.submittedBy, tenantId: this.tenantId, input: opts },
      instance,
    );

    // Done after the parent is persisted, never inside its optimistic write:
    // the child's own submit reads and writes, and nesting that under the
    // parent's compare-and-set would turn a slow child template into spurious
    // version conflicts on the parent.
    await this.startSubWorkflows(instance);

    return instance;
  }

  async approve(
    instanceId: string,
    raw: ApproveOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => ApproveOptionsSchema.parse(raw));
    const startMs = this.clock.now().getTime();
    const decided = await this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      if (opts.approverId === instance.submittedBy) {
        throw new ApprovalForbiddenError(
          `Self-approval is not permitted. Approver "${opts.approverId}" submitted this request.`,
        );
      }

      const level = this.resolveActorLevel(instance, opts.approverId, opts.level);
      await this.runAuthorizationPolicy({
        operation: 'approve',
        actorId: opts.approverId,
        instance,
        level,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'approve',
        instanceId,
        actorId: opts.approverId,
        tenantId: this.tenantId,
        input: opts,
      });

      assertApproverOnLevel(level, opts.approverId);
      if (hasAlreadyActed(level, opts.approverId)) {
        throw new ApprovalError(
          `Approver "${opts.approverId}" has already acted on level ${level.level}.`,
          'ALREADY_ACTED',
        );
      }

      const now = this.clock.now();
      const oldValue = snapshotLevel(level);
      level.approvedBy.push(opts.approverId);

      const auditEntry: AuditEntry = {
        action: 'approved',
        actorId: opts.approverId,
        level: level.level,
        timestamp: now,
        comment: opts.comment,
        oldValue,
        newValue: snapshotLevel(level),
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);
      instance.updatedAt = now;

      if (isLevelApproved(level)) {
        level.status = 'approved';
        level.reminderDueAt = undefined;

        // Inside a parallel group the instance holds until every branch resolves;
        // a single branch finishing is not progress the rest of the chain can see.
        const siblingsStillOpen = this.groupMembers(instance, level).some(
          (l) => l.status === 'pending' || l.status === 'waiting',
        );
        const nextGroup = siblingsStillOpen ? [] : this.findNextGroup(instance);
        const nextLevel = nextGroup[0] ?? null;

        if (siblingsStillOpen) {
          await this.opts.adapter.updateInstance(instance, instance.version);
          await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
          await this.runExternalAudit(instance, auditEntry);
          this.opts.metricsAdapter?.increment('approval.approved', {
            tenantId: this.tenantId,
            isFinal: 'false',
          });
          this.opts.metricsAdapter?.timing(
            'approval.operation_duration_ms',
            this.clock.now().getTime() - startMs,
            { operation: 'approve' },
          );
          const p = {
            instanceId,
            documentId: instance.documentId,
            documentType: instance.documentType,
            timestamp: now,
            approverId: opts.approverId,
            level: level.level,
            comment: opts.comment,
            isFinal: false,
          };
          this.bus.emit('approval:approved', p);
          await this.notifyAdapters('approval:approved', instance, p);
          await this.runMiddlewareAfter(
            {
              operation: 'approve',
              instanceId,
              actorId: opts.approverId,
              tenantId: this.tenantId,
              input: opts,
            },
            instance,
          );
          return instance;
        }

        if (!nextLevel) {
          instance.status = 'approved';
          await this.opts.adapter.updateInstance(instance, instance.version);
          await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
          await this.runExternalAudit(instance, auditEntry);
          this.logger.info('approve: instance fully approved', {
            tenantId: this.tenantId,
            instanceId,
          });
          this.opts.metricsAdapter?.increment('approval.approved', {
            tenantId: this.tenantId,
            isFinal: 'true',
          });
          this.opts.metricsAdapter?.timing(
            'approval.operation_duration_ms',
            this.clock.now().getTime() - startMs,
            { operation: 'approve' },
          );
          const p = {
            instanceId,
            documentId: instance.documentId,
            documentType: instance.documentType,
            timestamp: now,
            approverId: opts.approverId,
            level: level.level,
            comment: opts.comment,
            isFinal: true,
          };
          this.bus.emit('approval:approved', p);
          this.bus.emit('approval:completed', instance);
          await this.notifyAdapters('approval:approved', instance, p);
          await this.notifyAdapters('approval:completed', instance, instance);
          await this.runMiddlewareAfter(
            {
              operation: 'approve',
              instanceId,
              actorId: opts.approverId,
              tenantId: this.tenantId,
              input: opts,
            },
            instance,
          );
          return instance;
        }

        await this.activateGroup(instance, nextGroup, now);

        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
        this.opts.metricsAdapter?.increment('approval.approved', {
          tenantId: this.tenantId,
          isFinal: 'false',
        });
        this.opts.metricsAdapter?.timing(
          'approval.operation_duration_ms',
          this.clock.now().getTime() - startMs,
          { operation: 'approve' },
        );
        const pAdv = {
          instanceId,
          documentId: instance.documentId,
          documentType: instance.documentType,
          timestamp: now,
          approverId: opts.approverId,
          level: level.level,
          comment: opts.comment,
          isFinal: false,
        };
        this.bus.emit('approval:approved', pAdv);
        const pLvl = {
          instanceId,
          documentId: instance.documentId,
          documentType: instance.documentType,
          timestamp: now,
          fromLevel: level.level,
          toLevel: nextLevel.level,
          newApprovers: nextLevel.approverIds,
        };
        this.bus.emit('approval:level_advanced', pLvl);
        await this.notifyAdapters('approval:level_advanced', instance, pLvl);
        await this.runMiddlewareAfter(
          {
            operation: 'approve',
            instanceId,
            actorId: opts.approverId,
            tenantId: this.tenantId,
            input: opts,
          },
          instance,
        );
      } else {
        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
        this.opts.metricsAdapter?.increment('approval.approved', { tenantId: this.tenantId });
        this.opts.metricsAdapter?.timing(
          'approval.operation_duration_ms',
          this.clock.now().getTime() - startMs,
          { operation: 'approve' },
        );
        const p = {
          instanceId,
          documentId: instance.documentId,
          documentType: instance.documentType,
          timestamp: now,
          approverId: opts.approverId,
          level: level.level,
          comment: opts.comment,
          isFinal: false,
        };
        this.bus.emit('approval:approved', p);
        await this.notifyAdapters('approval:approved', instance, p);
        await this.runMiddlewareAfter(
          {
            operation: 'approve',
            instanceId,
            actorId: opts.approverId,
            tenantId: this.tenantId,
            input: opts,
          },
          instance,
        );
      }

      return instance;
    });

    await this.afterDecision(decided);
    return decided;
  }

  async reject(
    instanceId: string,
    raw: RejectOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => RejectOptionsSchema.parse(raw));
    const decided = await this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      if (opts.approverId === instance.submittedBy) {
        throw new ApprovalForbiddenError(
          `Self-rejection is not permitted. Approver "${opts.approverId}" submitted this request.`,
        );
      }

      const level = this.resolveActorLevel(instance, opts.approverId, opts.level);
      await this.runAuthorizationPolicy({
        operation: 'reject',
        actorId: opts.approverId,
        instance,
        level,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'reject',
        instanceId,
        actorId: opts.approverId,
        tenantId: this.tenantId,
        input: opts,
      });

      assertApproverOnLevel(level, opts.approverId);
      if (hasAlreadyActed(level, opts.approverId)) {
        throw new ApprovalError(
          `Approver "${opts.approverId}" has already acted on level ${level.level}.`,
          'ALREADY_ACTED',
        );
      }

      const now = this.clock.now();
      const oldValue = snapshotLevel(level);
      level.rejectedBy.push(opts.approverId);

      const auditEntry: AuditEntry = {
        action: 'rejected',
        actorId: opts.approverId,
        level: level.level,
        timestamp: now,
        reason: opts.reason,
        oldValue,
        newValue: snapshotLevel(level),
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);
      instance.updatedAt = now;

      if (isLevelRejected(level)) {
        level.status = 'rejected';

        if (opts.returnTo === 'previous') {
          const prevLevel = this.findPreviousLevel(instance);
          if (!prevLevel) {
            throw new ApprovalValidationError(
              `Cannot return to previous level: instance "${instanceId}" is already at the first level (${level.level}). Remove returnTo: 'previous' or use returnTo: 'originator' to fully reject.`,
            );
          }
          prevLevel.status = 'pending';
          prevLevel.approvedBy = [];
          prevLevel.rejectedBy = [];
          instance.currentLevel = prevLevel.level;
          await this.opts.adapter.updateInstance(instance, instance.version);
          await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
          await this.runExternalAudit(instance, auditEntry);
          const p = {
            instanceId,
            documentId: instance.documentId,
            documentType: instance.documentType,
            timestamp: now,
            approverId: opts.approverId,
            level: level.level,
            reason: opts.reason,
            returnTo: 'previous' as const,
          };
          this.bus.emit('approval:rejected', p);
          await this.notifyAdapters('approval:rejected', instance, p);
          await this.runMiddlewareAfter(
            {
              operation: 'reject',
              instanceId,
              actorId: opts.approverId,
              tenantId: this.tenantId,
              input: opts,
            },
            instance,
          );
          return instance;
        }

        instance.status = 'rejected';
        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
        this.opts.metricsAdapter?.increment('approval.rejected', { tenantId: this.tenantId });
        this.logger.info('reject: instance rejected', { tenantId: this.tenantId, instanceId });
        const p = {
          instanceId,
          documentId: instance.documentId,
          documentType: instance.documentType,
          timestamp: now,
          approverId: opts.approverId,
          level: level.level,
          reason: opts.reason,
          returnTo: opts.returnTo === 'originator' ? ('originator' as const) : null,
        };
        this.bus.emit('approval:rejected', p);
        await this.notifyAdapters('approval:rejected', instance, p);
        await this.runMiddlewareAfter(
          {
            operation: 'reject',
            instanceId,
            actorId: opts.approverId,
            tenantId: this.tenantId,
            input: opts,
          },
          instance,
        );
      } else {
        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
      }

      return instance;
    });

    await this.afterDecision(decided);
    return decided;
  }

  async delegate(instanceId: string, raw: DelegateOptions, auditCtx?: AuditContext): Promise<void> {
    const opts = parseOrThrow(() => DelegateOptionsSchema.parse(raw));
    await this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      if (opts.fromApprover === opts.toApprover) {
        throw new ApprovalForbiddenError('Cannot delegate to yourself.');
      }

      const level = this.resolveActorLevel(instance, opts.fromApprover, opts.level);
      await this.runAuthorizationPolicy({
        operation: 'delegate',
        actorId: opts.fromApprover,
        instance,
        level,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'delegate',
        instanceId,
        actorId: opts.fromApprover,
        tenantId: this.tenantId,
        input: opts,
      });

      assertApproverOnLevel(level, opts.fromApprover);
      if (hasAlreadyActed(level, opts.fromApprover)) {
        throw new ApprovalForbiddenError(
          `Cannot delegate after acting: "${opts.fromApprover}" has already approved or rejected level ${level.level}.`,
        );
      }

      const now = this.clock.now();
      const idx = level.approverIds.indexOf(opts.fromApprover);
      level.approverIds[idx] = opts.toApprover;

      if (opts.until) {
        level.delegatedUntil = opts.until;
        level.delegatedFrom = opts.fromApprover;
        level.delegatedTo = opts.toApprover;
      }

      const auditEntry: AuditEntry = {
        action: 'delegated',
        actorId: opts.fromApprover,
        level: level.level,
        timestamp: now,
        reason: opts.reason,
        delegateTo: opts.toApprover,
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);
      instance.updatedAt = now;

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      const p = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        fromApprover: opts.fromApprover,
        toApprover: opts.toApprover,
        level: level.level,
        reason: opts.reason,
      };
      this.bus.emit('approval:delegated', p);
      await this.notifyAdapters('approval:delegated', instance, p);
      await this.runMiddlewareAfter(
        {
          operation: 'delegate',
          instanceId,
          actorId: opts.fromApprover,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );
      return instance;
    });
  }

  /**
   * Administratively replace an approver on the current level. Unlike delegate(),
   * this is performed by a third party (e.g. an admin handling an unavailable
   * approver) and does not require the original approver to initiate it. The
   * target approver must still be pending — an approver who has already acted
   * cannot be reassigned.
   */
  async reassign(
    instanceId: string,
    raw: ReassignOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => ReassignOptionsSchema.parse(raw));
    return this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      if (opts.fromApprover === opts.toApprover) {
        throw new ApprovalForbiddenError('Cannot reassign an approver to themselves.');
      }

      const level = this.resolveActorLevel(instance, opts.fromApprover, opts.level);
      await this.runAuthorizationPolicy({
        operation: 'reassign',
        actorId: opts.reassignedBy,
        instance,
        level,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'reassign',
        instanceId,
        actorId: opts.reassignedBy,
        tenantId: this.tenantId,
        input: opts,
      });

      const idx = level.approverIds.indexOf(opts.fromApprover);
      if (idx < 0) {
        throw new ApprovalForbiddenError(
          `Cannot reassign: "${opts.fromApprover}" is not an approver on level ${level.level}.`,
        );
      }
      if (hasAlreadyActed(level, opts.fromApprover)) {
        throw new ApprovalForbiddenError(
          `Cannot reassign after acting: "${opts.fromApprover}" has already approved or rejected level ${level.level}.`,
        );
      }
      if (level.approverIds.includes(opts.toApprover)) {
        throw new ApprovalForbiddenError(
          `Cannot reassign: "${opts.toApprover}" is already an approver on level ${level.level}.`,
        );
      }

      const now = this.clock.now();
      level.approverIds[idx] = opts.toApprover;

      // If the slot being reassigned carries an active time-limited delegation, clear it.
      if (level.delegatedTo === opts.fromApprover || level.delegatedFrom === opts.fromApprover) {
        level.delegatedUntil = undefined;
        level.delegatedFrom = undefined;
        level.delegatedTo = undefined;
      }

      const auditEntry: AuditEntry = {
        action: 'reassigned',
        actorId: opts.reassignedBy,
        level: level.level,
        timestamp: now,
        reason: opts.reason,
        delegateTo: opts.toApprover,
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);
      instance.updatedAt = now;

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.reassigned', { tenantId: this.tenantId });
      this.logger.info('reassign: approver replaced', {
        tenantId: this.tenantId,
        instanceId,
        from: opts.fromApprover,
        to: opts.toApprover,
      });
      const p = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        reassignedBy: opts.reassignedBy,
        fromApprover: opts.fromApprover,
        toApprover: opts.toApprover,
        level: level.level,
        reason: opts.reason,
      };
      this.bus.emit('approval:reassigned', p);
      await this.notifyAdapters('approval:reassigned', instance, p);
      await this.runMiddlewareAfter(
        {
          operation: 'reassign',
          instanceId,
          actorId: opts.reassignedBy,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );
      return instance;
    });
  }

  async cancel(
    instanceId: string,
    raw: CancelOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => CancelOptionsSchema.parse(raw));
    let cancelled: ApprovalInstance | null = null;
    const result = await this.withOptimisticRetry(instanceId, async (instance) => {
      if (instance.status === 'approved' || instance.status === 'rejected') {
        throw new ApprovalError(`Cannot cancel a "${instance.status}" approval.`, 'CANNOT_CANCEL');
      }

      await this.runAuthorizationPolicy({
        operation: 'cancel',
        actorId: opts.cancelledBy,
        instance,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'cancel',
        instanceId,
        actorId: opts.cancelledBy,
        tenantId: this.tenantId,
        input: opts,
      });

      const now = this.clock.now();
      instance.status = 'cancelled';
      instance.updatedAt = now;

      const auditEntry: AuditEntry = {
        action: 'cancelled',
        actorId: opts.cancelledBy,
        level: instance.currentLevel,
        timestamp: now,
        reason: opts.reason,
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.cancelled', { tenantId: this.tenantId });
      this.logger.info('cancel: instance cancelled', { tenantId: this.tenantId, instanceId });
      const p = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        cancelledBy: opts.cancelledBy,
        reason: opts.reason,
      };
      this.bus.emit('approval:cancelled', p);
      await this.notifyAdapters('approval:cancelled', instance, p);
      await this.runMiddlewareAfter(
        {
          operation: 'cancel',
          instanceId,
          actorId: opts.cancelledBy,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );
      cancelled = instance;
      return instance;
    });

    if (cancelled) {
      // Cancelling a parent must not leave its children running, and a
      // cancelled child still owes its own parent an outcome.
      await this.cancelOrphanedChildren(cancelled);
      await this.propagateToParent(cancelled);
    }
    return result;
  }

  async escalate(
    instanceId: string,
    raw: EscalateOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    parseOrThrow(() => EscalateOptionsSchema.parse(raw));
    return this.escalateInternal(instanceId, raw.escalatedBy, auditCtx);
  }

  /**
   * Change an instance's document data while it is still pending, and
   * re-evaluate the template's conditions against the new values.
   *
   * Documents change after submission — a line item is corrected, a vendor is
   * reclassified, an amount is revised — and the approval chain that was
   * computed at submit time can be wrong the moment that happens. Without this,
   * the only way to reflect a correction was to cancel and resubmit, losing the
   * approvals already collected and the audit trail with them.
   *
   * **Only the part of the chain that has not been reached is recomputed.**
   * Levels before {@link ApprovalInstance.currentLevel}, and the current level
   * itself, are frozen: an approval that has already been given cannot be
   * retracted by editing data, and a level that is actively collecting
   * decisions is not pulled out from under its approvers. Conditions that would
   * skip such a level are therefore ignored — history cannot be rewritten — and
   * a condition that would *insert* a level at or before the current one throws
   * rather than silently dropping an approval step that should have run.
   *
   * @param instanceId - The pending instance to update.
   * @param raw - Who is updating, the new data, and how to apply it.
   * @param auditCtx - Optional compliance context recorded on the audit entry.
   * @returns The updated instance.
   * @throws ApprovalError if the instance is not pending.
   * @throws ApprovalValidationError if re-evaluation would insert a level at or
   *   before the current level, or would leave the chain with no levels.
   */
  async updateData(
    instanceId: string,
    raw: UpdateDataOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => UpdateDataOptionsSchema.parse(raw));

    return this.withOptimisticRetry(instanceId, async (instance) => {
      if (instance.status !== 'pending') {
        throw new ApprovalError(
          `Cannot update data on a "${instance.status}" approval. Only pending instances can be edited.`,
          'CANNOT_UPDATE_DATA',
        );
      }

      await this.runAuthorizationPolicy({
        operation: 'updateData',
        actorId: opts.updatedBy,
        instance,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'updateData',
        instanceId,
        actorId: opts.updatedBy,
        tenantId: this.tenantId,
        input: opts,
      });

      const previousData = instance.data;
      const nextData: Record<string, unknown> =
        opts.mode === 'replace' ? { ...opts.data } : { ...previousData, ...opts.data };

      const changedFields = [...new Set([...Object.keys(previousData), ...Object.keys(nextData)])]
        .filter((k) => !Object.is(previousData[k], nextData[k]))
        .sort();

      const now = this.clock.now();
      let addedLevels: number[] = [];
      let removedLevels: number[] = [];

      if (opts.recomputeChain) {
        const recomputed = await this.recomputeFutureChain(instance, nextData);
        addedLevels = recomputed.addedLevels;
        removedLevels = recomputed.removedLevels;
      }

      instance.data = nextData;
      instance.updatedAt = now;

      const auditEntry: AuditEntry = {
        action: 'data_updated',
        actorId: opts.updatedBy,
        level: instance.currentLevel,
        timestamp: now,
        reason: opts.reason,
        oldValue: { data: previousData },
        newValue: { data: nextData, addedLevels, removedLevels },
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.data_updated', { tenantId: this.tenantId });
      this.logger.info('updateData: instance data updated', {
        tenantId: this.tenantId,
        instanceId,
        changedFields,
        addedLevels,
        removedLevels,
      });

      const payload = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        updatedBy: opts.updatedBy,
        reason: opts.reason,
        changedFields,
        addedLevels,
        removedLevels,
      };
      this.bus.emit('approval:data_updated', payload);
      await this.notifyAdapters('approval:data_updated', instance, payload);
      await this.runMiddlewareAfter(
        {
          operation: 'updateData',
          instanceId,
          actorId: opts.updatedBy,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );
      return instance;
    });
  }

  /**
   * Recompute the not-yet-reached portion of an instance's level chain against
   * new data, mutating `instance.levels` in place.
   *
   * Levels at or before `currentLevel` are treated as immutable history. See
   * {@link updateData} for why.
   */
  private async recomputeFutureChain(
    instance: ApprovalInstance,
    nextData: Record<string, unknown>,
  ): Promise<{ addedLevels: number[]; removedLevels: number[] }> {
    const template = await this.registry.get(instance.templateName);
    const mutations = evaluateConditions(template.conditions ?? [], nextData);

    const desired = [...template.levels, ...mutations.addLevels]
      .filter((l) => !mutations.skipLevels.has(l.level))
      .sort((a, b) => a.level - b.level);

    const frozen = instance.levels.filter((l) => l.level <= instance.currentLevel);
    const frozenNums = new Set(frozen.map((l) => l.level));
    const futureCfgs = desired.filter((l) => l.level > instance.currentLevel);

    // A level the new data introduces behind the cursor cannot be honoured: the
    // instance has already moved past that point. Failing loudly beats silently
    // dropping an approval step the template says is required.
    const behindCursor = desired.find(
      (l) => l.level <= instance.currentLevel && !frozenNums.has(l.level),
    );
    if (behindCursor) {
      throw new ApprovalValidationError(
        `Re-evaluating conditions would insert level ${behindCursor.level} ("${behindCursor.name}"), which is at or before the current level ${instance.currentLevel}. Cancel and resubmit if the chain must change retroactively.`,
      );
    }

    const existingFuture = new Map(
      instance.levels.filter((l) => l.level > instance.currentLevel).map((l) => [l.level, l]),
    );
    const desiredNums = new Set(futureCfgs.map((l) => l.level));

    const addedLevels = futureCfgs.filter((l) => !existingFuture.has(l.level)).map((l) => l.level);
    const removedLevels = [...existingFuture.keys()]
      .filter((n) => !desiredNums.has(n))
      .sort((a, b) => a - b);

    if (frozen.length === 0 && futureCfgs.length === 0) {
      throw new ApprovalValidationError(
        'Re-evaluating conditions would leave the instance with no levels. Check that skipLevels conditions are not removing all levels.',
      );
    }

    const rebuiltFuture: ApprovalLevelInstance[] = futureCfgs.map((cfg) => {
      const kept = existingFuture.get(cfg.level);
      // Preserve an untouched waiting level as-is so any delegation already
      // arranged on it survives a data edit elsewhere in the document.
      if (kept) return kept;
      // Same construction submit() uses, so a condition-added level cannot come
      // out missing fields the template configured on it.
      return this.buildLevelInstance(cfg, { open: false, now: this.clock.now() });
    });

    instance.levels = [...frozen, ...rebuiltFuture];
    return { addedLevels: addedLevels.sort((a, b) => a - b), removedLevels };
  }

  /**
   * Ask the submitter for clarification without rejecting.
   *
   * Approvers routinely need one fact before they can decide. The only ways to
   * express that were to reject — which throws away every approval already
   * collected and forces a resubmit — or to leave the request sitting while the
   * question is chased by email, which quietly burns the SLA the approver is
   * measured on.
   *
   * The instance stays `pending` and keeps its approvers: this is a question,
   * not a decision. What changes is the clock — escalation, SLA and expiry
   * deadlines stop advancing while the question is open, because time spent
   * waiting on the submitter is not time the approver is sitting on their hands.
   *
   * @throws ApprovalError if the instance is not pending, or a question is already open.
   */
  async requestInfo(
    instanceId: string,
    raw: RequestInfoOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => RequestInfoOptionsSchema.parse(raw));

    return this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');
      if (instance.infoRequest) {
        throw new ApprovalError(
          `A clarification request is already open on this approval (asked by "${instance.infoRequest.askedBy}"). Answer it with provideInfo() first.`,
          'INFO_ALREADY_REQUESTED',
        );
      }

      const level = this.resolveActorLevel(instance, opts.approverId, opts.level);
      assertApproverOnLevel(level, opts.approverId);

      await this.runAuthorizationPolicy({
        operation: 'requestInfo',
        actorId: opts.approverId,
        instance,
        level,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'requestInfo',
        instanceId,
        actorId: opts.approverId,
        tenantId: this.tenantId,
        input: opts,
      });

      const now = this.clock.now();
      instance.infoRequest = {
        askedBy: opts.approverId,
        question: opts.question,
        askedAt: now,
        level: level.level,
      };
      instance.updatedAt = now;

      const auditEntry: AuditEntry = {
        action: 'info_requested',
        actorId: opts.approverId,
        level: level.level,
        timestamp: now,
        comment: opts.question,
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.info_requested', { tenantId: this.tenantId });
      this.logger.info('requestInfo: clarification requested', {
        tenantId: this.tenantId,
        instanceId,
        level: level.level,
      });

      const payload = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        askedBy: opts.approverId,
        question: opts.question,
        level: level.level,
        recipients: [instance.submittedBy],
      };
      this.bus.emit('approval:info_requested', payload);
      await this.notifyAdapters('approval:info_requested', instance, payload);
      await this.runMiddlewareAfter(
        {
          operation: 'requestInfo',
          instanceId,
          actorId: opts.approverId,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );
      return instance;
    });
  }

  /**
   * Answer an open clarification request and take the instance off hold.
   *
   * Every deadline that was paused is pushed out by exactly how long the
   * question was open, so an approver gets back the full remaining time they
   * had before asking rather than being penalised for asking at all.
   *
   * @throws ApprovalError if no question is open.
   */
  async provideInfo(
    instanceId: string,
    raw: ProvideInfoOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => ProvideInfoOptionsSchema.parse(raw));

    return this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');
      const open = instance.infoRequest;
      if (!open) {
        throw new ApprovalError(
          'No clarification request is open on this approval.',
          'NO_INFO_REQUESTED',
        );
      }

      await this.runAuthorizationPolicy({
        operation: 'provideInfo',
        actorId: opts.respondedBy,
        instance,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'provideInfo',
        instanceId,
        actorId: opts.respondedBy,
        tenantId: this.tenantId,
        input: opts,
      });

      const now = this.clock.now();
      const heldForMs = Math.max(0, now.getTime() - new Date(open.askedAt).getTime());
      this.extendDeadlinesBy(instance, heldForMs);

      instance.infoRequest = undefined;
      instance.updatedAt = now;

      const auditEntry: AuditEntry = {
        action: 'info_provided',
        actorId: opts.respondedBy,
        level: open.level,
        timestamp: now,
        comment: opts.response,
        oldValue: { question: open.question, askedBy: open.askedBy },
        newValue: { heldForMs },
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.info_provided', { tenantId: this.tenantId });
      this.logger.info('provideInfo: clarification answered', {
        tenantId: this.tenantId,
        instanceId,
        heldForMs,
      });

      const payload = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        respondedBy: opts.respondedBy,
        response: opts.response,
        level: open.level,
        heldForMs,
        recipients: [...new Set(this.pendingLevels(instance).flatMap((l) => l.approverIds))],
      };
      this.bus.emit('approval:info_provided', payload);
      await this.notifyAdapters('approval:info_provided', instance, payload);
      await this.runMiddlewareAfter(
        {
          operation: 'provideInfo',
          instanceId,
          actorId: opts.respondedBy,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );
      return instance;
    });
  }

  /**
   * Push every pending deadline out by `ms`.
   *
   * Used to give back time an instance spent on hold. Deadlines that are not
   * set stay unset — a level with no escalation configured does not acquire one
   * by being held.
   */
  private extendDeadlinesBy(instance: ApprovalInstance, ms: number): void {
    if (ms <= 0) return;
    const shift = (d: Date | undefined): Date | undefined =>
      d === undefined ? undefined : new Date(new Date(d).getTime() + ms);

    instance.expiresAt = shift(instance.expiresAt);
    instance.slaDeadlineAt = shift(instance.slaDeadlineAt);
    for (const level of instance.levels) {
      if (level.status !== 'pending') continue;
      level.escalationDueAt = shift(level.escalationDueAt);
      level.reminderDueAt = shift(level.reminderDueAt);
      level.delegatedUntil = shift(level.delegatedUntil);
    }
  }

  /**
   * Attach supporting evidence to an approval — a quote PDF, a signed contract,
   * a screenshot of a system of record.
   *
   * Stores a **reference**, never bytes. Approval documents belong in the object
   * store or DMS the organisation already runs, which handles retention, virus
   * scanning and access control far better than an approval table could;
   * copying them here would make the audit database the largest and least
   * governed copy of them.
   *
   * Allowed on any non-terminal instance, by anyone the authorization policy
   * permits: the submitter adding a missing quote and an approver adding the
   * note that justifies their decision are both ordinary.
   */
  async addAttachment(
    instanceId: string,
    raw: AddAttachmentOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => AddAttachmentOptionsSchema.parse(raw));

    return this.withOptimisticRetry(instanceId, async (instance) => {
      if (TERMINAL_STATUSES.has(instance.status)) {
        throw new ApprovalError(
          `Cannot attach to a "${instance.status}" approval.`,
          'CANNOT_ATTACH',
        );
      }

      await this.runAuthorizationPolicy({
        operation: 'addAttachment',
        actorId: opts.actorId,
        instance,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'addAttachment',
        instanceId,
        actorId: opts.actorId,
        tenantId: this.tenantId,
        input: opts,
      });

      const now = this.clock.now();
      const attachment: Attachment = {
        id: this.generateId('att'),
        name: opts.name,
        uri: opts.uri,
        contentType: opts.contentType,
        sizeBytes: opts.sizeBytes,
        addedBy: opts.actorId,
        addedAt: now,
        level: instance.currentLevel,
      };
      instance.attachments = [...(instance.attachments ?? []), attachment];
      instance.updatedAt = now;

      const auditEntry: AuditEntry = {
        action: 'attachment_added',
        actorId: opts.actorId,
        level: instance.currentLevel,
        timestamp: now,
        newValue: { id: attachment.id, name: attachment.name, uri: attachment.uri },
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.attachment_added', {
        tenantId: this.tenantId,
      });

      const payload = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        actorId: opts.actorId,
        attachmentId: attachment.id,
        name: attachment.name,
        uri: attachment.uri,
        level: attachment.level,
      };
      this.bus.emit('approval:attachment_added', payload);
      await this.notifyAdapters('approval:attachment_added', instance, payload);
      await this.runMiddlewareAfter(
        {
          operation: 'addAttachment',
          instanceId,
          actorId: opts.actorId,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );
      return instance;
    });
  }

  /**
   * Detach a reference from an approval.
   *
   * The audit entry keeps the name and URI of what was removed, so the record
   * still shows an approver saw evidence that is no longer listed — dropping
   * that would let the trail imply a decision was made on less than it was.
   * Nothing is deleted from the underlying store; that is the DMS's call.
   */
  async removeAttachment(
    instanceId: string,
    raw: RemoveAttachmentOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => RemoveAttachmentOptionsSchema.parse(raw));

    return this.withOptimisticRetry(instanceId, async (instance) => {
      if (TERMINAL_STATUSES.has(instance.status)) {
        throw new ApprovalError(
          `Cannot modify attachments on a "${instance.status}" approval.`,
          'CANNOT_ATTACH',
        );
      }

      const existing = (instance.attachments ?? []).find((a) => a.id === opts.attachmentId);
      if (!existing) {
        throw new ApprovalError(
          `Attachment "${opts.attachmentId}" is not on this approval.`,
          'ATTACHMENT_NOT_FOUND',
        );
      }

      await this.runAuthorizationPolicy({
        operation: 'removeAttachment',
        actorId: opts.actorId,
        instance,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'removeAttachment',
        instanceId,
        actorId: opts.actorId,
        tenantId: this.tenantId,
        input: opts,
      });

      const now = this.clock.now();
      instance.attachments = (instance.attachments ?? []).filter((a) => a.id !== opts.attachmentId);
      instance.updatedAt = now;

      const auditEntry: AuditEntry = {
        action: 'attachment_removed',
        actorId: opts.actorId,
        level: instance.currentLevel,
        timestamp: now,
        reason: opts.reason,
        oldValue: { id: existing.id, name: existing.name, uri: existing.uri },
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.attachment_removed', {
        tenantId: this.tenantId,
      });

      const payload = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        actorId: opts.actorId,
        attachmentId: existing.id,
        name: existing.name,
        uri: existing.uri,
        level: existing.level,
      };
      this.bus.emit('approval:attachment_removed', payload);
      await this.notifyAdapters('approval:attachment_removed', instance, payload);
      await this.runMiddlewareAfter(
        {
          operation: 'removeAttachment',
          instanceId,
          actorId: opts.actorId,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );
      return instance;
    });
  }

  /** Add a comment to an instance without approving or rejecting. */
  async addComment(
    instanceId: string,
    raw: AddCommentOptions,
    auditCtx?: AuditContext,
  ): Promise<void> {
    const opts = parseOrThrow(() => AddCommentOptionsSchema.parse(raw));
    const instance = await this.requireInstance(instanceId);

    await this.runAuthorizationPolicy({
      operation: 'addComment',
      actorId: opts.actorId,
      instance,
      opts: opts as Record<string, unknown>,
    });
    await this.runMiddlewareBefore({
      operation: 'addComment',
      instanceId,
      actorId: opts.actorId,
      tenantId: this.tenantId,
      input: opts,
    });

    if (opts.parentCommentId) {
      const parent = (instance.comments ?? []).find((c) => c.id === opts.parentCommentId);
      if (!parent) {
        throw new ApprovalError(
          `Comment "${opts.parentCommentId}" is not on this approval, so there is nothing to reply to.`,
          'COMMENT_NOT_FOUND',
        );
      }
    }

    const now = this.clock.now();
    const comment: Comment = {
      id: this.generateId('cmt'),
      authorId: opts.actorId,
      body: opts.comment,
      createdAt: now,
      level: instance.currentLevel,
      parentCommentId: opts.parentCommentId,
      mentions: opts.mentions,
    };
    instance.comments = [...(instance.comments ?? []), comment];

    const auditEntry: AuditEntry = {
      action: 'commented',
      actorId: opts.actorId,
      level: instance.currentLevel,
      timestamp: now,
      comment: opts.comment,
      newValue: { commentId: comment.id, parentCommentId: opts.parentCommentId },
      ...auditCtx,
    };

    instance.auditLog.push(auditEntry);
    instance.updatedAt = now;

    await this.opts.adapter.updateInstance(instance, instance.version);
    await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
    await this.runExternalAudit(instance, auditEntry);

    // Recipients are the people named, not the current approvers: a remark
    // aimed at somebody should reach them, and one aimed at nobody should not
    // page the whole level.
    const payload = {
      instanceId,
      documentId: instance.documentId,
      documentType: instance.documentType,
      timestamp: now,
      commentId: comment.id,
      authorId: opts.actorId,
      body: opts.comment,
      level: comment.level,
      parentCommentId: opts.parentCommentId,
      recipients: opts.mentions ?? [],
    };
    this.bus.emit('approval:commented', payload);
    await this.notifyAdapters('approval:commented', instance, payload);

    await this.runMiddlewareAfter({
      operation: 'addComment',
      instanceId,
      actorId: opts.actorId,
      tenantId: this.tenantId,
      input: opts,
    });
  }

  /**
   * Comments on an approval, oldest first.
   *
   * Returns a flat list carrying `parentCommentId`, rather than a nested tree:
   * a UI that wants threads can build them, and one that wants a chronological
   * feed — which is what most approval screens actually show — does not have to
   * flatten a structure it never wanted.
   */
  async getComments(instanceId: string): Promise<Comment[]> {
    const instance = await this.requireInstance(instanceId);
    return [...(instance.comments ?? [])].sort(
      (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
    );
  }

  /** Resubmit a rejected instance, creating a new linked instance from level 1. */
  async resubmit(
    instanceId: string,
    raw: ResubmitOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => ResubmitOptionsSchema.parse(raw));
    const original = await this.requireInstance(instanceId);

    if (original.status !== 'rejected') {
      throw new ApprovalForbiddenError(
        `Cannot resubmit an instance with status "${original.status}". Only rejected instances can be resubmitted.`,
      );
    }

    await this.runAuthorizationPolicy({
      operation: 'resubmit',
      actorId: opts.resubmittedBy,
      instance: original,
      opts: opts as Record<string, unknown>,
    });
    await this.runMiddlewareBefore({
      operation: 'resubmit',
      instanceId,
      actorId: opts.resubmittedBy,
      tenantId: this.tenantId,
      input: opts,
    });

    const template = await this.registry.get(original.templateName);
    const mergedData = { ...original.data, ...(opts.updatedData ?? {}) };

    const mutations = evaluateConditions(template.conditions ?? [], mergedData);
    const allLevelCfgs = [...template.levels, ...mutations.addLevels]
      .filter((l) => !mutations.skipLevels.has(l.level))
      .sort((a, b) => a.level - b.level);

    if (allLevelCfgs.length === 0) {
      throw new ApprovalValidationError(
        'Template has no active levels after condition evaluation.',
      );
    }

    const levelNums = new Set(allLevelCfgs.map((l) => l.level));
    if (levelNums.size !== allLevelCfgs.length) {
      throw new ApprovalValidationError('Duplicate level numbers after condition evaluation.');
    }

    const now = this.clock.now();
    const newInstanceId = this.generateId('inst');

    const levels: ApprovalLevelInstance[] = allLevelCfgs.map((cfg, idx) => ({
      level: cfg.level,
      name: cfg.name,
      mode: cfg.mode,
      approverConfigs: cfg.approvers,
      approverIds: [],
      approvedBy: [],
      rejectedBy: [],
      status: idx === 0 ? 'pending' : 'waiting',
      minApprovals: cfg.minApprovals,
      threshold: cfg.threshold,
      weights: cfg.weights,
      escalationAfterDays: cfg.escalationAfterDays,
      escalationDueAt:
        idx === 0 && cfg.escalationAfterDays
          ? this.deadlineFrom(now, cfg.escalationAfterDays)
          : undefined,
    }));

    const firstCfg = allLevelCfgs[0];
    const firstLevel = levels[0];
    if (firstCfg && firstLevel) {
      firstLevel.approverIds = await this.resolver.resolveApprovers(
        firstCfg.approvers,
        opts.resubmittedBy,
        mergedData,
        this.opts.orgProvider,
      );
    }

    const auditEntry: AuditEntry = {
      action: 'resubmitted',
      actorId: opts.resubmittedBy,
      level: allLevelCfgs[0]?.level ?? 1,
      timestamp: now,
      reason: opts.reason,
      ...auditCtx,
    };

    const slaDeadlineAt = template.slaDeadlineHours
      ? this.deadlineFromHours(now, template.slaDeadlineHours)
      : template.slaDeadlineDays
        ? this.deadlineFrom(now, template.slaDeadlineDays)
        : undefined;

    const newInstance: ApprovalInstance = {
      id: newInstanceId,
      tenantId: this.tenantId,
      templateId: template.id,
      templateName: template.name,
      documentId: original.documentId,
      documentType: original.documentType,
      submittedBy: opts.resubmittedBy,
      status: 'pending',
      currentLevel: allLevelCfgs[0]?.level ?? 1,
      version: 1,
      parentInstanceId: instanceId,
      levels,
      auditLog: [auditEntry],
      data: mergedData,
      metadata: original.metadata,
      createdAt: now,
      updatedAt: now,
      slaDeadlineAt,
      templateSnapshot: {
        escalation: template.escalation,
        escalationSteps: template.escalationSteps,
        slaDeadlineDays: template.slaDeadlineDays,
        slaDeadlineHours: template.slaDeadlineHours,
        allowOverride: template.allowOverride,
      },
    };

    await this.opts.adapter.saveInstance(newInstance);
    await this.runExternalAudit(newInstance, auditEntry);

    this.logger.info('resubmit: new instance created from rejected original', {
      tenantId: this.tenantId,
      originalInstanceId: instanceId,
      newInstanceId,
    });

    const p = {
      instanceId: newInstanceId,
      documentId: newInstance.documentId,
      documentType: newInstance.documentType,
      timestamp: now,
      resubmittedBy: opts.resubmittedBy,
      originalInstanceId: instanceId,
    };
    this.bus.emit('approval:resubmitted', p);
    await this.notifyAdapters('approval:resubmitted', newInstance, p);
    await this.runMiddlewareAfter(
      {
        operation: 'resubmit',
        instanceId,
        actorId: opts.resubmittedBy,
        tenantId: this.tenantId,
        input: opts,
      },
      newInstance,
    );

    return newInstance;
  }

  /** Preview the resolved approval chain for a template and document data, without creating an instance. */
  async previewApprovalChain(
    templateName: string,
    data: Record<string, unknown>,
    submittedBy: string,
  ): Promise<PreviewResult> {
    const template = await this.registry.get(templateName);
    const mutations = evaluateConditions(template.conditions ?? [], data);

    const conditionsApplied: number[] = [];
    (template.conditions ?? []).forEach((rule, idx) => {
      const m = evaluateConditions([rule], data);
      if (m.addLevels.length > 0 || m.skipLevels.size > 0) {
        conditionsApplied.push(idx);
      }
    });

    const allLevelCfgs = [...template.levels, ...mutations.addLevels]
      .filter((l) => !mutations.skipLevels.has(l.level))
      .sort((a, b) => a.level - b.level);

    const levels: PreviewChainLevel[] = [];
    for (const cfg of allLevelCfgs) {
      try {
        // Preview must show who would actually be assigned, cover included —
        // otherwise it disagrees with what submit() goes on to do.
        const resolvedApprovers = await this.resolver.resolveApprovers(
          cfg.approvers,
          submittedBy,
          data,
          this.opts.orgProvider,
          this.opts.outOfOfficeProvider,
          this.clock.now(),
        );
        levels.push({ level: cfg.level, name: cfg.name, resolvedApprovers, mode: cfg.mode });
      } catch {
        levels.push({ level: cfg.level, name: cfg.name, resolvedApprovers: [], mode: cfg.mode });
      }
    }

    return { levels, conditionsApplied };
  }

  /** Check whether a user is eligible to approve a specific instance. Never throws. */
  /**
   * Explain why a chain resolves the way it does for a given document.
   *
   * `previewApprovalChain()` answers *what* the chain will be. This answers
   * *why*: which rule added a level, which rule removed one, which rules were
   * evaluated and did not match, and where each level's approvers came from —
   * the question behind "why does this purchase order have a CFO level?", which
   * previously meant reading the template and re-evaluating the conditions by
   * hand.
   *
   * A rule that throws — an operator nobody registered, a malformed group — is
   * reported against that rule rather than failing the whole explanation. The
   * explanation is a diagnostic tool, and it is least useful at exactly the
   * moment a broken rule makes it throw.
   *
   * Reads nothing and writes nothing; safe to expose to a support UI.
   *
   * @param templateName - Template to explain.
   * @param data - Document data the conditions are evaluated against.
   * @param submittedBy - Submitter, used for approver resolution.
   */
  async explainChain(
    templateName: string,
    data: Record<string, unknown>,
    submittedBy: string,
  ): Promise<ChainExplanation> {
    const template = await this.registry.get(templateName);
    const conditions = template.conditions ?? [];

    const rules: ExplainedRule[] = [];
    const addedBy = new Map<number, number>();
    const skippedBy = new Map<number, number>();

    conditions.forEach((rule, index) => {
      const addsLevels = (rule.addLevels ?? []).map((l) => l.level);
      const skipsLevels = rule.skipLevels ?? [];
      try {
        const outcome = evaluateConditions([rule], data);
        const matched = outcome.addLevels.length > 0 || outcome.skipLevels.size > 0;
        rules.push({ index, matched, addsLevels, skipsLevels });
        if (matched) {
          for (const l of outcome.addLevels) if (!addedBy.has(l.level)) addedBy.set(l.level, index);
          for (const l of outcome.skipLevels) if (!skippedBy.has(l)) skippedBy.set(l, index);
        }
      } catch (err) {
        rules.push({
          index,
          matched: false,
          addsLevels,
          skipsLevels,
          error: (err as Error).message,
        });
      }
    });

    // Re-evaluate as a whole so the level set matches what submit() would build.
    let mutations: { addLevels: ApprovalLevelConfig[]; skipLevels: Set<number> };
    try {
      mutations = evaluateConditions(conditions, data);
    } catch {
      mutations = { addLevels: [], skipLevels: new Set<number>() };
    }

    const active = [...template.levels, ...mutations.addLevels]
      .filter((l) => !mutations.skipLevels.has(l.level))
      .sort((a, b) => a.level - b.level);

    const levels: ExplainedLevel[] = [];
    for (const cfg of active) {
      const fromCondition = addedBy.has(cfg.level);
      const base: ExplainedLevel = {
        level: cfg.level,
        name: cfg.name,
        mode: cfg.mode,
        source: fromCondition ? 'condition' : 'template',
        ...(fromCondition ? { addedByRule: addedBy.get(cfg.level) } : {}),
        resolvedApprovers: [],
        ...(cfg.subWorkflow ? { subWorkflowTemplate: cfg.subWorkflow.templateName } : {}),
      };

      if (cfg.subWorkflow) {
        levels.push(base);
        continue;
      }

      try {
        base.resolvedApprovers = await this.resolver.resolveApprovers(
          cfg.approvers,
          submittedBy,
          data,
          this.opts.orgProvider,
          this.opts.outOfOfficeProvider,
          this.clock.now(),
        );
      } catch (err) {
        // Naming the level with an unresolvable approver is the whole point.
        base.resolutionError = (err as Error).message;
      }
      levels.push(base);
    }

    const skipped: ExplainedSkip[] = template.levels
      .filter((l) => mutations.skipLevels.has(l.level))
      .map((l) => ({
        level: l.level,
        name: l.name,
        skippedByRule: skippedBy.get(l.level) ?? -1,
      }))
      .sort((a, b) => a.level - b.level);

    return { templateName: template.name, levels, skipped, rules };
  }

  /**
   * Run a document through a template against scripted decisions, without
   * persisting anything.
   *
   * `explainChain()` says what the chain will be; this says what happens to it —
   * "if the CFO rejects at level 3, does it go back to the submitter or die?" —
   * which previously meant submitting a real approval into a real store and
   * cleaning it up afterwards, or reasoning about the state machine by hand.
   *
   * The run executes against a private in-memory store seeded with a copy of
   * the template, so the caller's storage is untouched and no events reach the
   * caller's notification adapters. Custom resolvers and approver types are
   * copied across, because a simulation that could not resolve the caller's own
   * `dynamic` approvers would answer a different question from the one asked.
   *
   * A refused decision — wrong approver, wrong level, already acted — stops the
   * run and is reported in the transcript rather than thrown: the refusal is
   * usually the answer the caller was looking for.
   *
   * @param opts - Template, document data, submitter and the decisions to play.
   */
  async simulate(opts: {
    templateName: string;
    data: Record<string, unknown>;
    submittedBy: string;
    decisions?: SimulatedDecision[];
  }): Promise<SimulationResult> {
    const template = await this.registry.get(opts.templateName);

    const scratch = new ApprovalEngine({
      ...this.opts,
      adapter: new MemoryAdapter(),
      // A simulation must not page anybody, write anybody's audit log, or move
      // anybody's metrics.
      notificationAdapter: undefined,
      auditAdapter: undefined,
      metricsAdapter: undefined,
      authorizationPolicy: undefined,
      middleware: undefined,
      escalationPollIntervalMs: undefined,
    });
    this.resolver.copyRegistrationsTo(scratch.resolver);

    try {
      const {
        id: _id,
        tenantId: _t,
        createdAt: _c,
        version: _v,
        previousVersionId: _p,
        ...config
      } = template;
      await scratch.registry.define(config);

      const instance = await scratch.submit({
        templateName: opts.templateName,
        documentId: `simulation-${opts.templateName}`,
        documentType: template.documentType,
        submittedBy: opts.submittedBy,
        data: opts.data,
        metadata: {},
      });

      const transcript: SimulationStep[] = [];
      let current = instance;

      for (const [i, decision] of (opts.decisions ?? []).entries()) {
        const isApprove = 'approve' in decision;
        const actorId = isApprove ? decision.approve : decision.reject;
        try {
          current = isApprove
            ? await scratch.approve(current.id, {
                approverId: actorId,
                level: decision.level,
                comment: decision.comment,
              })
            : await scratch.reject(current.id, {
                approverId: actorId,
                level: decision.level,
                reason: decision.reason ?? 'simulated rejection',
              });
          transcript.push({
            step: i + 1,
            action: isApprove ? 'approve' : 'reject',
            actorId,
            level: decision.level,
            status: current.status,
          });
        } catch (err) {
          transcript.push({
            step: i + 1,
            action: isApprove ? 'approve' : 'reject',
            actorId,
            level: decision.level,
            status: current.status,
            error: (err as Error).message,
          });
          break;
        }
        if (TERMINAL_STATUSES.has(current.status)) break;
      }

      const finalInstance = await scratch.getInstance(current.id);
      return {
        finalStatus: finalInstance.status,
        levels: finalInstance.levels.map((l) => ({
          level: l.level,
          name: l.name,
          status: l.status,
          approvers: l.approverIds,
        })),
        transcript,
        unreachedLevels: finalInstance.levels
          .filter((l) => l.status === 'waiting')
          .map((l) => l.level),
        incomplete: finalInstance.status === 'pending',
      };
    } finally {
      await scratch.shutdown();
    }
  }

  async canApprove(instanceId: string, userId: string): Promise<CanApproveResult> {
    let instance: ApprovalInstance;
    try {
      instance = await this.requireInstance(instanceId);
    } catch {
      return { eligible: false, reason: 'wrong_status' };
    }

    if (instance.status !== 'pending') {
      return { eligible: false, reason: 'wrong_status' };
    }

    if (userId === instance.submittedBy) {
      return { eligible: false, reason: 'self_approval' };
    }

    const openForUser = this.pendingLevels(instance).find((l) => l.approverIds.includes(userId));
    const level = openForUser ?? this.currentLevelInstance(instance);

    if (!level.approverIds.includes(userId)) {
      const hasDelegated = instance.auditLog.some(
        (e) => e.action === 'delegated' && e.actorId === userId && e.level === level.level,
      );
      return { eligible: false, reason: hasDelegated ? 'delegated_away' : 'not_an_approver' };
    }

    if (hasAlreadyActed(level, userId)) {
      return { eligible: false, reason: 'already_acted' };
    }

    return { eligible: true };
  }

  /** Emergency bypass — completes the instance as 'approved', skipping remaining levels. Requires template.allowOverride = true. */
  async override(
    instanceId: string,
    raw: OverrideOptions,
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => OverrideOptionsSchema.parse(raw));
    return this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      const allowOverride =
        instance.templateSnapshot?.allowOverride ??
        (await this.registry.get(instance.templateName)).allowOverride;
      if (!allowOverride) {
        throw new ApprovalForbiddenError(
          `Override is not enabled for template "${instance.templateName}". Set allowOverride: true in the template config.`,
        );
      }

      if (opts.overriddenBy === instance.submittedBy) {
        throw new ApprovalForbiddenError('Override cannot be performed by the original submitter.');
      }

      await this.runAuthorizationPolicy({
        operation: 'override',
        actorId: opts.overriddenBy,
        instance,
        opts: opts as Record<string, unknown>,
      });
      await this.runMiddlewareBefore({
        operation: 'override',
        instanceId,
        actorId: opts.overriddenBy,
        tenantId: this.tenantId,
        input: opts,
      });

      const now = this.clock.now();
      instance.status = 'approved';
      instance.updatedAt = now;

      const auditEntry: AuditEntry = {
        action: 'overridden',
        actorId: opts.overriddenBy,
        level: instance.currentLevel,
        timestamp: now,
        reason: opts.justification,
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.overridden', { tenantId: this.tenantId });

      this.logger.info('override: instance force-approved', {
        tenantId: this.tenantId,
        instanceId,
        overriddenBy: opts.overriddenBy,
      });

      const p = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        overriddenBy: opts.overriddenBy,
        justification: opts.justification,
      };
      this.bus.emit('approval:overridden', p);
      this.bus.emit('approval:completed', instance);
      await this.notifyAdapters('approval:overridden', instance, p);
      await this.notifyAdapters('approval:completed', instance, instance);
      await this.runMiddlewareAfter(
        {
          operation: 'override',
          instanceId,
          actorId: opts.overriddenBy,
          tenantId: this.tenantId,
          input: opts,
        },
        instance,
      );

      return instance;
    });
  }

  /** Approve multiple instances in one call. Never throws — failures collected in result.failed. */
  /**
   * Move every pending approval assigned to one person over to another.
   *
   * Someone leaves, changes team, or goes on long-term leave, and their queue
   * has to go somewhere. Doing it by hand means finding every open instance
   * first — across parallel branches, where one person can hold several open
   * levels on the same document — and missing one leaves an approval that can
   * never complete.
   *
   * Each move goes through {@link reassign}, so every guard, audit entry, event
   * and authorization check that applies to a single reassignment applies here
   * too. There is no bulk short-cut around them.
   *
   * The sweep is **not atomic**: it reassigns one level at a time and reports
   * per-instance failures rather than rolling back. A partial transfer is the
   * useful outcome — the approvals that could move should move, and the ones
   * that could not are named so a human can look at them.
   *
   * @param raw - Who is moving to whom, and why.
   * @returns What moved, what did not, and why. With `dryRun` nothing is written.
   */
  async transferApprovals(
    raw: TransferApprovalsOptions,
    auditCtx?: AuditContext,
  ): Promise<TransferResult> {
    const opts = parseOrThrow(() => TransferApprovalsOptionsSchema.parse(raw));

    if (opts.fromApprover === opts.toApprover) {
      throw new ApprovalValidationError(
        'transferApprovals requires different fromApprover and toApprover.',
      );
    }

    const queue = await this.opts.adapter.getInstancesByApprover(this.tenantId, opts.fromApprover, {
      limit: opts.limit,
      offset: 0,
    });

    const result: TransferResult = {
      transferred: [],
      failed: [],
      scanned: 0,
      dryRun: opts.dryRun,
    };

    for (const instance of queue.items) {
      if (opts.documentType && instance.documentType !== opts.documentType) continue;
      result.scanned++;

      // One person can hold several open branches of a parallel group on the
      // same document; each is a separate level and must be moved separately.
      const levels = instance.levels.filter(
        (l) => l.status === 'pending' && l.approverIds.includes(opts.fromApprover),
      );

      for (const level of levels) {
        if (opts.dryRun) {
          result.transferred.push({
            instanceId: instance.id,
            level: level.level,
            documentId: instance.documentId,
          });
          continue;
        }
        try {
          await this.reassign(
            instance.id,
            {
              reassignedBy: opts.transferredBy,
              fromApprover: opts.fromApprover,
              toApprover: opts.toApprover,
              reason: opts.reason,
              level: level.level,
            },
            auditCtx,
          );
          result.transferred.push({
            instanceId: instance.id,
            level: level.level,
            documentId: instance.documentId,
          });
        } catch (err) {
          result.failed.push({
            instanceId: instance.id,
            error: err instanceof ApprovalError ? err : new ApprovalError(String(err), 'UNKNOWN'),
          });
        }
      }
    }

    this.logger.info('transferApprovals: sweep complete', {
      tenantId: this.tenantId,
      fromApprover: opts.fromApprover,
      toApprover: opts.toApprover,
      scanned: result.scanned,
      transferred: result.transferred.length,
      failed: result.failed.length,
      dryRun: opts.dryRun,
    });

    return result;
  }

  async bulkApprove(
    instanceIds: string[],
    raw: ApproveOptions,
    auditCtx?: AuditContext,
  ): Promise<BulkResult> {
    const opts = parseOrThrow(() => ApproveOptionsSchema.parse(raw));
    this.guardBulkSize(instanceIds);

    const result: BulkResult = { succeeded: [], failed: [], total: instanceIds.length };
    for (const id of instanceIds) {
      try {
        result.succeeded.push(await this.approve(id, opts, auditCtx));
      } catch (err) {
        result.failed.push({
          instanceId: id,
          error: err instanceof ApprovalError ? err : new ApprovalError(String(err), 'UNKNOWN'),
        });
      }
    }
    return result;
  }

  /** Reject multiple instances in one call. Never throws — failures collected in result.failed. */
  async bulkReject(
    instanceIds: string[],
    raw: RejectOptions,
    auditCtx?: AuditContext,
  ): Promise<BulkResult> {
    const opts = parseOrThrow(() => RejectOptionsSchema.parse(raw));
    this.guardBulkSize(instanceIds);

    const result: BulkResult = { succeeded: [], failed: [], total: instanceIds.length };
    for (const id of instanceIds) {
      try {
        result.succeeded.push(await this.reject(id, opts, auditCtx));
      } catch (err) {
        result.failed.push({
          instanceId: id,
          error: err instanceof ApprovalError ? err : new ApprovalError(String(err), 'UNKNOWN'),
        });
      }
    }
    return result;
  }

  // ─── Queries ──────────────────────────────────────────────────────────────

  async getInstance(instanceId: string): Promise<ApprovalInstance> {
    return this.requireInstance(instanceId);
  }

  async getPendingFor(
    approverId: string,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>> {
    return this.opts.adapter.getInstancesByApprover(this.tenantId, approverId, opts);
  }

  async queryInstances(
    filter: InstanceFilter,
    opts?: PaginationOpts,
  ): Promise<PaginatedResult<ApprovalInstance>> {
    return this.opts.adapter.getInstancesByFilter(this.tenantId, filter, opts);
  }

  async queryInstancesByCursor(
    filter: InstanceFilter,
    opts: CursorPaginationOpts,
  ): Promise<CursorPaginatedResult<ApprovalInstance>> {
    if (!this.opts.adapter.getInstancesByCursor) {
      throw new ApprovalError(
        'The configured storage adapter does not support cursor pagination. Implement getInstancesByCursor() or use queryInstances() instead.',
        'NOT_SUPPORTED',
      );
    }
    return this.opts.adapter.getInstancesByCursor(this.tenantId, filter, opts);
  }

  async getHistory(instanceId: string): Promise<AuditEntry[]> {
    const instance = await this.requireInstance(instanceId);
    return instance.auditLog;
  }

  async getCurrentApprovers(instanceId: string): Promise<string[]> {
    const instance = await this.requireInstance(instanceId);
    if (instance.status !== 'pending') return [];
    // Union across every open branch: inside a parallel group more than one
    // level is collecting decisions at the same time.
    return [...new Set(this.pendingLevels(instance).flatMap((l) => l.approverIds))];
  }

  /** Check adapter connectivity and escalation scheduler health. */
  async healthCheck(): Promise<HealthResult> {
    let adapterStatus: 'connected' | 'error' = 'connected';
    let pendingCount = 0;
    let overdueCount = 0;

    try {
      pendingCount = await this.opts.adapter.countInstances(this.tenantId, { status: 'pending' });
    } catch {
      adapterStatus = 'error';
    }

    if (adapterStatus === 'connected') {
      try {
        const overdue = await this.opts.adapter.getOverdueInstances(
          this.tenantId,
          this.clock.now(),
        );
        overdueCount = overdue.length;
      } catch {
        adapterStatus = 'error';
      }
    }

    const status =
      adapterStatus === 'error' ? 'unhealthy' : overdueCount > 0 ? 'degraded' : 'healthy';

    return {
      status,
      adapter: adapterStatus,
      pendingCount,
      overdueCount,
      escalationRunning: this.escalation.isRunning,
      lastTickAt: this.escalation.lastTickAt ?? undefined,
    };
  }

  /**
   * Aggregate counts for dashboards. Accepts an optional filter (documentType,
   * submittedBy, date range) — `status` is ignored since every status is counted.
   * Adapter-agnostic: issues one cheap count query per status plus an overdue scan.
   */
  /**
   * Who currently owes a decision, and how overdue they are.
   *
   * `getStatistics()` answers how the tenant is doing; this answers who is
   * holding it up — the question behind rebalancing a queue, spotting the
   * approver who has been on leave for a week, or deciding whom to
   * {@link transferApprovals} a departing colleague's work to.
   *
   * Computed from pending instances rather than a dedicated index, so it works
   * on any storage adapter with no new adapter methods. That means it reads
   * every pending instance in the tenant: fine for the operational volumes an
   * approval queue reaches, but it is a reporting call, not something to put on
   * a hot path.
   *
   * Rows are sorted by {@link ApproverWorkload.pending} descending, so the
   * busiest queue is first.
   *
   * @param filter - Optional scoping; `status` is ignored, since only pending work counts.
   * @returns One row per approver holding at least one open level.
   */
  async getWorkload(filter: Omit<InstanceFilter, 'status'> = {}): Promise<ApproverWorkload[]> {
    const pending = await this.fetchAllByFilter({ ...filter, status: 'pending' });
    const now = this.clock.now();

    const byApprover = new Map<
      string,
      { pending: number; instances: Set<string>; overdue: number; onHold: number; oldest: number }
    >();

    for (const instance of pending) {
      const submittedAt = new Date(instance.createdAt).getTime();
      const held = Boolean(instance.infoRequest);

      for (const level of instance.levels) {
        if (level.status !== 'pending') continue;

        const isOverdue =
          level.escalationDueAt !== undefined && new Date(level.escalationDueAt) <= now;

        for (const approverId of level.approverIds) {
          // An approver who has already voted on this level owes nothing more,
          // even though the level itself is still open waiting on others.
          if (level.approvedBy.includes(approverId) || level.rejectedBy.includes(approverId)) {
            continue;
          }

          const row = byApprover.get(approverId) ?? {
            pending: 0,
            instances: new Set<string>(),
            overdue: 0,
            onHold: 0,
            oldest: Number.POSITIVE_INFINITY,
          };
          row.pending++;
          row.instances.add(instance.id);
          if (isOverdue) row.overdue++;
          if (held) row.onHold++;
          row.oldest = Math.min(row.oldest, submittedAt);
          byApprover.set(approverId, row);
        }
      }
    }

    return [...byApprover.entries()]
      .map(([approverId, row]) => ({
        approverId,
        pending: row.pending,
        instances: row.instances.size,
        overdue: row.overdue,
        onHold: row.onHold,
        oldestPendingAt: Number.isFinite(row.oldest) ? new Date(row.oldest) : undefined,
        oldestAgeMs: Number.isFinite(row.oldest) ? now.getTime() - row.oldest : 0,
      }))
      .sort((a, b) => b.pending - a.pending || a.approverId.localeCompare(b.approverId));
  }

  /**
   * Export templates as a portable bundle.
   *
   * Approval configuration is written once and then has to travel — authored in
   * a sandbox, reviewed, promoted to production. Reading `listTemplates()` and
   * re-posting the rows carried each environment's own `id`, `tenantId` and
   * version lineage with it, which either collided on arrival or silently
   * claimed a history the target never had. This strips all of it.
   *
   * @param names - Templates to include; omit for all of them.
   */
  async exportTemplates(names?: string[]): Promise<TemplateBundle> {
    const all = await this.registry.list();
    const wanted = names ? all.filter((t) => names.includes(t.name)) : all;

    if (names) {
      const missing = names.filter((n) => !all.some((t) => t.name === n));
      if (missing.length > 0) {
        throw new ApprovalTemplateNotFoundError(missing.join(', '));
      }
    }

    return {
      bundleVersion: TEMPLATE_BUNDLE_VERSION,
      exportedAt: this.clock.now(),
      templates: wanted.map((t) => {
        // Everything environment-specific is dropped, not blanked, so a
        // round-trip cannot reintroduce a stale id.
        const {
          id: _id,
          tenantId: _tenantId,
          createdAt: _createdAt,
          version: _version,
          previousVersionId: _previousVersionId,
          ...config
        } = t;
        return config;
      }),
    };
  }

  /**
   * Import a bundle produced by {@link exportTemplates}.
   *
   * **Every template is validated before any is written.** A bundle that is
   * half-applied is worse than one rejected outright: the tenant is left in a
   * state matching neither environment, and the operator has no way to tell
   * which half landed. Per-template failures during the write phase are still
   * reported individually, since a storage error can occur after validation
   * passes.
   *
   * @param bundle - The bundle to apply.
   * @param opts - `mode: 'create'` (default) refuses to touch existing
   *   templates; `'upsert'` updates them. `dryRun` reports without writing.
   */
  async importTemplates(
    bundle: TemplateBundle,
    opts: { mode?: 'create' | 'upsert'; dryRun?: boolean } = {},
  ): Promise<ImportResult> {
    const mode = opts.mode ?? 'create';
    const dryRun = opts.dryRun ?? false;

    if (bundle.bundleVersion !== TEMPLATE_BUNDLE_VERSION) {
      throw new ApprovalValidationError(
        `Unsupported template bundle version ${bundle.bundleVersion}; this engine reads version ${TEMPLATE_BUNDLE_VERSION}.`,
      );
    }
    if (!Array.isArray(bundle.templates) || bundle.templates.length === 0) {
      throw new ApprovalValidationError('Template bundle contains no templates.');
    }

    const duplicates = bundle.templates
      .map((t) => t.name)
      .filter((name, i, all) => all.indexOf(name) !== i);
    if (duplicates.length > 0) {
      throw new ApprovalValidationError(
        `Template bundle contains duplicate names: ${[...new Set(duplicates)].join(', ')}.`,
      );
    }

    // Validate everything first — see the note above on half-applied bundles.
    const invalid: Array<{ name: string; message: string }> = [];
    for (const config of bundle.templates) {
      const result = this.validateTemplate(config);
      if (!result.valid) {
        invalid.push({
          name: config.name,
          message: result.errors[0]?.message ?? 'unknown validation error',
        });
      }
    }
    if (invalid.length > 0) {
      throw new ApprovalValidationError(
        `Template bundle failed validation and was not applied: ${invalid
          .map((e) => `${e.name}: ${e.message}`)
          .join('; ')}`,
      );
    }

    const result: ImportResult = { created: [], updated: [], skipped: [], errors: [], dryRun };

    for (const config of bundle.templates) {
      const existing = await this.opts.adapter.getTemplate(this.tenantId, config.name);
      try {
        if (existing && mode === 'create') {
          result.skipped.push(config.name);
          continue;
        }
        if (existing) {
          if (!dryRun) await this.registry.update(config);
          result.updated.push(config.name);
        } else {
          if (!dryRun) await this.registry.define(config);
          result.created.push(config.name);
        }
      } catch (err) {
        result.errors.push({ name: config.name, message: (err as Error).message });
      }
    }

    this.logger.info('importTemplates: bundle applied', {
      tenantId: this.tenantId,
      mode,
      dryRun,
      created: result.created.length,
      updated: result.updated.length,
      skipped: result.skipped.length,
      errors: result.errors.length,
    });

    return result;
  }

  /**
   * Permanently remove finished approvals older than a cut-off.
   *
   * Approval tables only grow, and data-minimisation rules eventually require
   * old records to go. There was no way to remove one, so operators reached
   * around the library and deleted rows directly — which is exactly where
   * orphaned audit rows and half-deleted instances come from.
   *
   * **Only terminal instances are eligible.** A pending approval is live work;
   * deleting one would strand a document with no way to finish and no record of
   * why. Passing a non-terminal status is rejected rather than quietly ignored,
   * because a caller who asked to purge pending work has misunderstood
   * something and should hear about it.
   *
   * This is irreversible and removes the audit trail with the instance. In many
   * deployments that trail *is* the compliance record, which is why the
   * underlying `deleteInstance` is an optional adapter method: an adapter that
   * does not implement it makes the whole operation unavailable, and this
   * throws rather than reporting a successful purge of nothing.
   *
   * @param opts - Cut-off, optional status/type scoping, safety limit, dry run.
   * @returns What was removed, or would be under `dryRun`.
   */
  async purgeInstances(opts: {
    olderThan: Date;
    statuses?: ApprovalInstance['status'][];
    documentType?: string;
    limit?: number;
    dryRun?: boolean;
  }): Promise<PurgeResult> {
    const dryRun = opts.dryRun ?? false;
    const limit = opts.limit ?? DEFAULT_PURGE_LIMIT;

    if (!(opts.olderThan instanceof Date) || Number.isNaN(opts.olderThan.getTime())) {
      throw new ApprovalValidationError('purgeInstances requires a valid olderThan date.');
    }

    const requested = opts.statuses ?? [...TERMINAL_STATUSES];
    const nonTerminal = requested.filter((st) => !TERMINAL_STATUSES.has(st));
    if (nonTerminal.length > 0) {
      throw new ApprovalValidationError(
        `purgeInstances refuses non-terminal statuses (${nonTerminal.join(', ')}): a pending approval is live work, and removing it would strand the document it belongs to.`,
      );
    }

    const deleteInstance = this.opts.adapter.deleteInstance?.bind(this.opts.adapter);
    if (!deleteInstance && !dryRun) {
      throw new ApprovalValidationError(
        'The configured storage adapter does not implement deleteInstance(), so instances cannot be purged.',
      );
    }

    const result: PurgeResult = { purged: [], scanned: 0, dryRun };
    // Parent and child usually share a terminal status, so both turn up in the
    // scan; without this the family sweep would report each of them twice.
    const handled = new Set<string>();

    for (const status of requested) {
      if (result.purged.length >= limit) break;

      const page = await this.opts.adapter.getInstancesByFilter(
        this.tenantId,
        {
          status,
          toDate: opts.olderThan,
          ...(opts.documentType ? { documentType: opts.documentType } : {}),
        },
        { limit, offset: 0 },
      );

      for (const instance of page.items) {
        if (result.purged.length >= limit) break;
        if (handled.has(instance.id)) continue;
        result.scanned++;

        // Defence in depth: the filter should already exclude these, but a
        // custom adapter with a loose filter must not be able to delete live work.
        if (!TERMINAL_STATUSES.has(instance.status)) continue;
        if (new Date(instance.createdAt) > opts.olderThan) continue;

        // Sub-workflow children go with the parent. Leaving them behind would
        // orphan rows whose parentInstanceId points at something that no longer
        // exists — unreachable, and invisible to a purge scoped by document type.
        const family = await this.collectSubWorkflowFamily(instance);
        for (const member of family) {
          if (handled.has(member.id)) continue;
          handled.add(member.id);
          if (!dryRun) await deleteInstance!(this.tenantId, member.id);
          result.purged.push({
            instanceId: member.id,
            documentId: member.documentId,
            status: member.status,
          });
        }
      }
    }

    this.logger.info('purgeInstances: sweep complete', {
      tenantId: this.tenantId,
      olderThan: opts.olderThan.toISOString(),
      scanned: result.scanned,
      purged: result.purged.length,
      dryRun,
    });

    return result;
  }

  async getStatistics(filter: Omit<InstanceFilter, 'status'> = {}): Promise<ApprovalStatistics> {
    const statuses: ApprovalInstance['status'][] = [
      'pending',
      'approved',
      'rejected',
      'cancelled',
      'expired',
    ];

    const counts = await Promise.all(
      statuses.map((status) =>
        this.opts.adapter.countInstances(this.tenantId, { ...filter, status }),
      ),
    );

    const byStatus = statuses.reduce(
      (acc, status, i) => {
        acc[status] = counts[i] ?? 0;
        return acc;
      },
      {} as Record<ApprovalInstance['status'], number>,
    );

    const total = counts.reduce((a, b) => a + b, 0);
    const overdueList = await this.opts.adapter.getOverdueInstances(
      this.tenantId,
      this.clock.now(),
      filter,
    );
    const resolved = byStatus.approved + byStatus.rejected;
    const approvalRate = resolved === 0 ? 0 : byStatus.approved / resolved;
    const cycleTime = await this.computeCycleTimeStats(filter);

    // Per-template breakdown. Issue one aggregate query per template so the
    // result is accurate even when combined with the other filters (documentType,
    // submittedBy, date range). Adapter-agnostic: built only from
    // getInstancesByFilter counts plus a per-template approved/rejected count.
    const templates = await this.registry.list();
    const byTemplate: ApprovalStatistics['byTemplate'] = {};
    const cycleTimeByTemplate: ApprovalStatistics['cycleTimeByTemplate'] = {};
    if (templates.length > 0) {
      await Promise.all(
        templates.map(async (template) => {
          const base = { ...filter, templateName: template.name };
          const [tTotal, tApproved, tRejected, tPending, tCycleTime] = await Promise.all([
            this.opts.adapter.countInstances(this.tenantId, base),
            this.opts.adapter.countInstances(this.tenantId, { ...base, status: 'approved' }),
            this.opts.adapter.countInstances(this.tenantId, { ...base, status: 'rejected' }),
            this.opts.adapter.countInstances(this.tenantId, { ...base, status: 'pending' }),
            this.computeCycleTimeStats(base),
          ]);
          if (tTotal > 0) {
            byTemplate[template.name] = {
              total: tTotal,
              approved: tApproved,
              rejected: tRejected,
              pending: tPending,
            };
          }
          if (tCycleTime.count > 0) {
            cycleTimeByTemplate[template.name] = tCycleTime;
          }
        }),
      );
    }

    return {
      total,
      byStatus,
      overdue: overdueList.length,
      approvalRate,
      byTemplate,
      cycleTime,
      cycleTimeByTemplate,
    };
  }

  async shutdown(): Promise<void> {
    this.schedulerStopped = true;
    await this.escalation.stop();
    if (this.opts.schedulerAdapter && this.schedulerAdapterHandle !== null) {
      await this.opts.schedulerAdapter.cancel(this.schedulerAdapterHandle);
      this.schedulerAdapterHandle = null;
    }
    await this.opts.schedulerAdapter?.shutdown();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /**
   * Schedules the next escalation scan via {@link ApprovalEngineOptions.schedulerAdapter}.
   *
   * Called once from the constructor to start the loop, then re-invoked by the
   * scheduled callback itself after each scan completes — a self-rescheduling
   * chain of one-shot {@link ISchedulerAdapter.scheduleAt} calls standing in for
   * the `setInterval` that {@link EscalationScheduler.start} would otherwise
   * use. Each invocation runs the exact same {@link EscalationScheduler.tick}
   * scan the built-in poller runs; only the timer mechanism differs.
   *
   * A no-op once {@link shutdown} has set {@link schedulerStopped} — this is
   * what stops the chain from rescheduling itself forever after teardown.
   */
  private scheduleNextEscalationTick(schedulerAdapter: ISchedulerAdapter): void {
    if (this.schedulerStopped) return;
    const runAt = new Date(this.clock.now().getTime() + this.escalationPollIntervalMs);
    schedulerAdapter
      .scheduleAt(this.tenantId, runAt, async () => {
        if (this.schedulerStopped) return;
        try {
          await this.escalation.tick();
        } finally {
          this.scheduleNextEscalationTick(schedulerAdapter);
        }
      })
      .then((handle) => {
        this.schedulerAdapterHandle = handle;
      })
      .catch((err: unknown) => {
        this.logger.error(
          'ApprovalEngine: failed to schedule the next escalation tick via schedulerAdapter',
          err,
          { tenantId: this.tenantId },
        );
      });
  }

  /**
   * Compute {@link CycleTimeStats} for every "completed" instance (see
   * {@link CYCLE_TIME_STATUSES}) matching `filter`. Adapter-agnostic: fetches
   * full instances (not just counts) via {@link fetchAllByFilter} so the
   * actual `createdAt`/`updatedAt` timestamps are available, then reuses the
   * shared {@link computeTimingStats} quantile routine from the metrics
   * plugin rather than a second implementation.
   */
  private async computeCycleTimeStats(
    filter: Omit<InstanceFilter, 'status'>,
  ): Promise<CycleTimeStats> {
    const perStatusLists = await Promise.all(
      CYCLE_TIME_STATUSES.map((status) => this.fetchAllByFilter({ ...filter, status })),
    );
    const durationsMs = perStatusLists
      .flat()
      .map((instance) => instance.updatedAt.getTime() - instance.createdAt.getTime());
    return toCycleTimeStats(computeTimingStats(durationsMs));
  }

  /**
   * Page through every instance matching `filter` via the adapter's
   * `getInstancesByFilter`, accumulating pages until the adapter reports no
   * more results. Needed because adapters may impose a default page size
   * (e.g. `PostgresAdapter` defaults to 50) when no explicit `limit` is given,
   * so a single unbounded call cannot be relied on to return everything.
   */
  private async fetchAllByFilter(filter: InstanceFilter): Promise<ApprovalInstance[]> {
    const items: ApprovalInstance[] = [];
    let offset = 0;
    for (;;) {
      const page = await this.opts.adapter.getInstancesByFilter(this.tenantId, filter, {
        limit: CYCLE_TIME_FETCH_BATCH_SIZE,
        offset,
      });
      items.push(...page.items);
      offset += page.items.length;
      if (page.items.length === 0 || items.length >= page.total) break;
    }
    return items;
  }

  private async escalateInternal(
    instanceId: string,
    escalatedBy = 'system',
    auditCtx?: AuditContext,
    levelNumber?: number,
  ): Promise<ApprovalInstance> {
    return this.withOptimisticRetry(instanceId, async (instance) => {
      if (instance.status !== 'pending') return instance;

      const ladder = await this.escalationLadder(instance);
      const targetLevel =
        levelNumber === undefined
          ? this.currentLevelInstance(instance)
          : (instance.levels.find((l) => l.level === levelNumber) ??
            this.currentLevelInstance(instance));
      const rungIndex = targetLevel.escalationStep ?? 0;
      const rung = ladder[rungIndex];

      const escalateTo =
        rung?.escalateTo ??
        (
          instance.templateSnapshot?.escalation ??
          (await this.registry.get(instance.templateName)).escalation
        )?.escalateTo;
      if (!escalateTo) return instance;

      const newApprovers = await this.resolver.resolveApprovers(
        [escalateTo],
        instance.submittedBy,
        instance.data,
        this.opts.orgProvider,
        this.opts.outOfOfficeProvider,
        this.clock.now(),
      );

      const filteredApprovers = newApprovers.filter((id) => id !== instance.submittedBy);
      if (filteredApprovers.length === 0) {
        this.logger.warn(
          'escalateInternal: escalation resolved to submitter only — no approvers added',
          {
            tenantId: this.tenantId,
            instanceId,
          },
        );
        return instance;
      }

      // A parallel group has several open branches, each with its own deadline;
      // escalating "the current level" would leave the others stuck forever.
      const level = targetLevel;
      level.approverIds = [...new Set([...level.approverIds, ...filteredApprovers])];

      const now = this.clock.now();

      // Arm the next rung, if the ladder has one. Rung delays are measured from
      // when the level opened, not from the previous escalation, so a ladder
      // reads the way it is written: "2 days, then 4 days, then 7".
      level.escalationStep = rungIndex + 1;
      const nextRung = ladder[rungIndex + 1];
      const levelOpenedAt = this.levelOpenedAt(instance, level, now);
      level.escalationDueAt = nextRung ? this.stepDueAt(levelOpenedAt, nextRung) : undefined;
      const escalatedTo = filteredApprovers[0] ?? 'unknown';
      const auditEntry: AuditEntry = {
        action: 'escalated',
        actorId: escalatedBy,
        level: level.level,
        timestamp: now,
        delegateTo: escalatedTo,
        ...auditCtx,
      };
      instance.auditLog.push(auditEntry);
      instance.updatedAt = now;

      await this.opts.adapter.updateInstance(instance, instance.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
      await this.runExternalAudit(instance, auditEntry);
      this.opts.metricsAdapter?.increment('approval.escalated', { tenantId: this.tenantId });
      this.logger.info('escalate: instance escalated', {
        tenantId: this.tenantId,
        instanceId,
        escalatedTo,
      });
      const p = {
        instanceId,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: now,
        level: level.level,
        escalatedTo,
      };
      this.bus.emit('approval:escalated', p);
      await this.notifyAdapters('approval:escalated', instance, p);
      return instance;
    });
  }

  private async expireInstance(
    instanceId: string,
    deadlineAction: 'cancel' | 'reject',
  ): Promise<void> {
    try {
      await this.withOptimisticRetry(instanceId, async (instance) => {
        if (instance.status !== 'pending') return instance;

        const now = this.clock.now();
        instance.status = deadlineAction === 'reject' ? 'rejected' : 'cancelled';
        instance.updatedAt = now;

        const auditEntry: AuditEntry = {
          action: 'expired',
          actorId: 'system',
          level: instance.currentLevel,
          timestamp: now,
          reason: `Approval deadline reached. Action: ${deadlineAction}.`,
        };
        instance.auditLog.push(auditEntry);

        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
        this.opts.metricsAdapter?.increment('approval.expired', { tenantId: this.tenantId });

        this.logger.warn('expireInstance: instance expired by deadline', {
          tenantId: this.tenantId,
          instanceId,
          deadlineAction,
        });

        const p = {
          instanceId,
          documentId: instance.documentId,
          documentType: instance.documentType,
          timestamp: now,
          deadlineAction,
        };
        this.bus.emit('approval:expired', p);
        await this.notifyAdapters('approval:expired', instance, p);

        return instance;
      });
    } catch (err) {
      this.logger.error('expireInstance: failed', err, { tenantId: this.tenantId, instanceId });
    }
  }

  private async markSlaBreached(instanceId: string): Promise<void> {
    try {
      await this.withOptimisticRetry(instanceId, async (instance) => {
        if (instance.status !== 'pending' || instance.slaBreachedAt) return instance;

        const now = this.clock.now();
        instance.slaBreachedAt = now;
        instance.updatedAt = now;

        await this.opts.adapter.updateInstance(instance, instance.version);
        this.opts.metricsAdapter?.increment('approval.sla_breached', { tenantId: this.tenantId });

        this.logger.warn('markSlaBreached: SLA breached', { tenantId: this.tenantId, instanceId });

        const p = {
          instanceId,
          documentId: instance.documentId,
          documentType: instance.documentType,
          timestamp: now,
          slaDeadlineAt: instance.slaDeadlineAt ?? now,
        };
        this.bus.emit('approval:sla_breached', p);
        await this.notifyAdapters('approval:sla_breached', instance, p);

        return instance;
      });
    } catch (err) {
      this.logger.error('markSlaBreached: failed', err, { tenantId: this.tenantId, instanceId });
    }
  }

  private async revertDelegation(
    instanceId: string,
    levelNumber: number,
    fromApprover: string,
  ): Promise<void> {
    try {
      await this.withOptimisticRetry(instanceId, async (instance) => {
        if (instance.status !== 'pending') return instance;

        const level = instance.levels.find((l) => l.level === levelNumber);
        if (!level || level.status !== 'pending') return instance;

        const delegateTo = level.delegatedTo;
        if (delegateTo) {
          const delegateIdx = level.approverIds.indexOf(delegateTo);
          if (delegateIdx >= 0) {
            level.approverIds[delegateIdx] = fromApprover;
          } else {
            level.approverIds.push(fromApprover);
          }
        }

        level.delegatedUntil = undefined;
        level.delegatedFrom = undefined;
        level.delegatedTo = undefined;

        const now = this.clock.now();
        instance.updatedAt = now;

        await this.opts.adapter.updateInstance(instance, instance.version);

        this.logger.info('revertDelegation: delegation expired and reverted', {
          tenantId: this.tenantId,
          instanceId,
          levelNumber,
          fromApprover,
        });

        return instance;
      });
    } catch (err) {
      this.logger.error('revertDelegation: failed', err, { tenantId: this.tenantId, instanceId });
    }
  }

  /** Read-modify-write with optimistic locking retry. */
  private async withOptimisticRetry(
    instanceId: string,
    fn: (instance: ApprovalInstance) => Promise<ApprovalInstance>,
  ): Promise<ApprovalInstance> {
    const { maxAttempts, baseDelayMs, maxDelayMs = Infinity, jitter = true } = this.retryPolicy;
    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        let delay = Math.min(baseDelayMs * attempt, maxDelayMs);
        if (jitter) delay += Math.random() * baseDelayMs;
        await sleep(delay);
        this.opts.metricsAdapter?.increment('approval.conflict_retry', {
          tenantId: this.tenantId,
          attempt: String(attempt),
        });
        this.logger.warn('withOptimisticRetry: retrying after conflict', {
          tenantId: this.tenantId,
          instanceId,
          attempt,
        });
      }
      const instance = await this.requireInstance(instanceId);
      if (attempt > 0 && TERMINAL_STATUSES.has(instance.status)) {
        throw new ApprovalForbiddenError(
          `Instance "${instanceId}" is already in terminal status "${instance.status}" and cannot be modified.`,
        );
      }
      try {
        return await fn(instance);
      } catch (err) {
        if (err instanceof ApprovalConflictError) {
          lastError = err;
          continue;
        }
        throw err;
      }
    }
    throw lastError ?? new ApprovalConflictError(instanceId);
  }

  /** Compute a deadline `days` from `from`, honouring the business calendar if one is configured. */
  private deadlineFrom(from: Date, days: number): Date {
    return this.calendar
      ? this.calendar.addBusinessDays(from, days)
      : new Date(from.getTime() + days * 86_400_000);
  }

  /**
   * Resolve an hour-based deadline.
   *
   * A calendar that only knows whole days — `weekendCalendar`, say — has no
   * `addBusinessHours`, and this falls back to elapsed clock time rather than
   * quietly pretending the calendar was applied. Configure
   * `businessHoursCalendar` to have hours skip evenings and weekends.
   */
  private deadlineFromHours(from: Date, hours: number): Date {
    const addHours = this.calendar?.addBusinessHours?.bind(this.calendar);
    return addHours ? addHours(from, hours) : new Date(from.getTime() + hours * 3_600_000);
  }

  /**
   * Build a level instance from its template config.
   *
   * The single place a level is constructed. It previously happened twice — in
   * `submit()` and again in `recomputeFutureChain()` — and the second copy was
   * missing `group`, `subWorkflowTemplate`, `escalationAfterHours` and the
   * reminder fields, so a level added by a condition during `updateData()` came
   * out silently different from the same level created at submit.
   *
   * @param cfg - The template's configuration for this level.
   * @param opts - `open` activates the level now, computing deadlines from `now`.
   */
  private buildLevelInstance(
    cfg: ApprovalLevelConfig,
    opts: { open: boolean; now: Date; firstRung?: EscalationStep },
  ): ApprovalLevelInstance {
    const level: ApprovalLevelInstance = {
      level: cfg.level,
      name: cfg.name,
      group: cfg.group,
      mode: cfg.mode,
      approverConfigs: cfg.approvers,
      approverIds: [],
      approvedBy: [],
      rejectedBy: [],
      status: opts.open ? 'pending' : 'waiting',
      minApprovals: cfg.minApprovals,
      threshold: cfg.threshold,
      weights: cfg.weights,
      subWorkflowTemplate: cfg.subWorkflow?.templateName,
      escalationAfterDays: cfg.escalationAfterDays,
      escalationAfterHours: cfg.escalationAfterHours,
      escalationStep: 0,
      reminderAfterDays: cfg.reminderAfterDays,
      reminderEveryDays: cfg.reminderEveryDays,
      maxReminders: cfg.maxReminders,
      remindersSent: 0,
    };

    if (opts.open) {
      level.openedAt = opts.now;
      level.escalationDueAt = this.levelEscalationDue(opts.now, cfg, opts.firstRung);
      this.scheduleReminder(level, opts.now);
    }
    return level;
  }

  /** Level deadline from whichever of days/hours the template configured. */
  private levelEscalationDue(
    from: Date,
    level: { escalationAfterDays?: number; escalationAfterHours?: number },
    firstRung?: EscalationStep,
  ): Date | undefined {
    // An explicit per-level delay wins: it is the more specific statement of
    // when this particular level is late.
    if (level.escalationAfterHours) return this.deadlineFromHours(from, level.escalationAfterHours);
    if (level.escalationAfterDays) return this.deadlineFrom(from, level.escalationAfterDays);
    return firstRung ? this.stepDueAt(from, firstRung) : undefined;
  }

  /** First rung of a ladder, sorted by delay, or undefined when there is none. */
  private firstRungOf(steps: EscalationStep[] | undefined): EscalationStep | undefined {
    if (!steps || steps.length === 0) return undefined;
    return [...steps].sort(
      (a, b) =>
        (a.afterHours ?? (a.afterDays ?? 0) * 24) - (b.afterHours ?? (b.afterDays ?? 0) * 24),
    )[0];
  }

  /**
   * The escalation ladder for an instance, sorted by delay.
   *
   * Read from the instance's template snapshot so an in-flight approval keeps
   * the ladder it was submitted under, exactly as the single-step
   * {@link EscalationConfig} already did.
   */
  private async escalationLadder(instance: ApprovalInstance): Promise<EscalationStep[]> {
    const snapshot = instance.templateSnapshot;
    const steps =
      snapshot?.escalationSteps ??
      (await this.registry.get(instance.templateName)).escalationSteps ??
      [];
    return [...steps].sort(
      (a, b) =>
        (a.afterHours ?? (a.afterDays ?? 0) * 24) - (b.afterHours ?? (b.afterDays ?? 0) * 24),
    );
  }

  /**
   * When a level started collecting decisions.
   *
   * Escalation rungs are measured from this, not from the previous rung, so a
   * ladder reads the way it is written. Recovered from the audit trail — the
   * `submitted` entry for the opening level, the `level_advanced` entry
   * otherwise — and falls back to `now` when no entry exists, which only leaves
   * the ladder no worse off than the single-step behaviour it replaces.
   */
  private levelOpenedAt(
    instance: ApprovalInstance,
    level: ApprovalLevelInstance,
    fallback: Date,
  ): Date {
    // Recorded on the level since 3.1.0. The audit scan below remains for
    // instances submitted before that and still in flight.
    if (level.openedAt) return new Date(level.openedAt);

    for (let i = instance.auditLog.length - 1; i >= 0; i--) {
      const entry = instance.auditLog[i];
      if (!entry) continue;
      const opensThisLevel =
        (entry.action === 'level_advanced' || entry.action === 'submitted') &&
        entry.level === level.level;
      if (opensThisLevel) return new Date(entry.timestamp);
    }
    return fallback;
  }

  /** Deadline for one rung, measured from when the level opened. */
  private stepDueAt(from: Date, step: EscalationStep): Date | undefined {
    if (step.afterHours) return this.deadlineFromHours(from, step.afterHours);
    if (step.afterDays) return this.deadlineFrom(from, step.afterDays);
    return undefined;
  }

  private async requireInstance(id: string): Promise<ApprovalInstance> {
    const instance = await this.opts.adapter.getInstance(this.tenantId, id);
    if (!instance) throw new ApprovalNotFoundError('Instance', id);
    return instance;
  }

  /**
   * Identity of the parallel branch group a level belongs to.
   *
   * An ungrouped level is its own group of one, keyed by its level number, so
   * sequential and parallel levels can be handled by the same code paths. The
   * `#` prefix keeps a synthetic key from ever colliding with a real group
   * name a template author chose.
   */
  private static groupKeyOf(level: { level: number; group?: string }): string {
    return level.group ?? `#${level.level}`;
  }

  /** Every level currently collecting decisions — more than one inside a parallel group. */
  private pendingLevels(instance: ApprovalInstance): ApprovalLevelInstance[] {
    return instance.levels.filter((l) => l.status === 'pending');
  }

  /** All levels sharing a group with the given level, including it. */
  private groupMembers(
    instance: ApprovalInstance,
    level: ApprovalLevelInstance,
  ): ApprovalLevelInstance[] {
    const key = ApprovalEngine.groupKeyOf(level);
    return instance.levels.filter((l) => ApprovalEngine.groupKeyOf(l) === key);
  }

  /**
   * Pick which pending level an actor is operating on.
   *
   * With sequential levels there is only ever one candidate. Inside a parallel
   * group an approver may sit on several branches at once, and guessing which
   * one they meant would silently record the decision against the wrong branch —
   * so that case demands an explicit `level`.
   */
  private resolveActorLevel(
    instance: ApprovalInstance,
    actorId: string,
    explicitLevel?: number,
  ): ApprovalLevelInstance {
    const pending = this.pendingLevels(instance);
    if (pending.length === 0) {
      throw new ApprovalError(
        `Instance has no level awaiting a decision (status: ${instance.status}).`,
        'INVALID_LEVEL',
      );
    }

    if (explicitLevel !== undefined) {
      const chosen = pending.find((l) => l.level === explicitLevel);
      if (!chosen) {
        const open = pending.map((l) => l.level).join(', ');
        throw new ApprovalError(
          `Level ${explicitLevel} is not awaiting a decision (open levels: ${open}).`,
          'INVALID_LEVEL',
        );
      }
      return chosen;
    }

    if (pending.length === 1) return pending[0] as ApprovalLevelInstance;

    const candidates = pending.filter((l) => l.approverIds.includes(actorId));
    if (candidates.length === 1) return candidates[0] as ApprovalLevelInstance;
    if (candidates.length > 1) {
      const open = candidates.map((l) => `${l.level} ("${l.name}")`).join(', ');
      throw new ApprovalValidationError(
        `Approver "${actorId}" is assigned to more than one open parallel level (${open}). Pass an explicit "level" to say which one this decision is for.`,
      );
    }
    // Not an approver anywhere; hand back the lowest open level so the caller's
    // own membership check produces the usual "not an approver" error.
    return pending[0] as ApprovalLevelInstance;
  }

  private currentLevelInstance(instance: ApprovalInstance): ApprovalLevelInstance {
    const pending = this.pendingLevels(instance);
    const lowestPending = pending.reduce<ApprovalLevelInstance | null>(
      (acc, l) => (acc === null || l.level < acc.level ? l : acc),
      null,
    );
    const level =
      instance.levels.find((l) => l.level === instance.currentLevel) ?? lowestPending ?? null;
    if (!level) {
      const available = instance.levels.map((l) => l.level).join(', ');
      throw new ApprovalError(
        `Level ${instance.currentLevel} not found on instance (available: ${available}).`,
        'INVALID_LEVEL',
      );
    }
    return level;
  }

  /**
   * The next group of levels to activate: every level sharing the group of the
   * lowest-numbered waiting level.
   */
  private findNextGroup(instance: ApprovalInstance): ApprovalLevelInstance[] {
    const waiting = instance.levels
      .filter((l) => l.status === 'waiting')
      .sort((a, b) => a.level - b.level);
    const head = waiting[0];
    if (!head) return [];
    const key = ApprovalEngine.groupKeyOf(head);
    return waiting.filter((l) => ApprovalEngine.groupKeyOf(l) === key);
  }

  /** Resolve approvers for a group, set its deadlines, and mark it pending. */
  private async activateGroup(
    instance: ApprovalInstance,
    group: ApprovalLevelInstance[],
    now: Date,
  ): Promise<void> {
    const firstRung = this.firstRungOf(instance.templateSnapshot?.escalationSteps);
    for (const lvl of group) {
      if (lvl.subWorkflowTemplate) {
        // Nobody approves this level directly — a child approval decides it.
        lvl.approverIds = [];
      } else {
        lvl.approverIds = await this.resolver.resolveApprovers(
          lvl.approverConfigs,
          instance.submittedBy,
          instance.data,
          this.opts.orgProvider,
          this.opts.outOfOfficeProvider,
          now,
        );
      }
      lvl.openedAt = now;
      lvl.escalationDueAt = this.levelEscalationDue(now, lvl, firstRung);
      lvl.escalationStep = 0;
      this.scheduleReminder(lvl, now);
      lvl.status = 'pending';
    }
    instance.currentLevel = group.reduce((min, l) => Math.min(min, l.level), Infinity);
  }

  /**
   * Set (or clear) the next reminder deadline for a level that has just opened.
   *
   * Called wherever a level becomes pending, so a level activated by submit,
   * by advancing, or by a group activation all schedule alike.
   */
  private scheduleReminder(level: ApprovalLevelInstance, from: Date): void {
    if (!level.reminderAfterDays || level.reminderAfterDays <= 0) {
      level.reminderDueAt = undefined;
      return;
    }
    level.remindersSent = level.remindersSent ?? 0;
    level.reminderDueAt = this.deadlineFrom(from, level.reminderAfterDays);
  }

  /**
   * Nudge the approvers who still owe a decision on a pending level.
   *
   * Reminders never change who can approve or when the level escalates — they
   * only notify. Recipients exclude anyone who has already voted, so a
   * half-decided quorum level stops pestering the approvers who did their part.
   */
  private async sendReminder(instanceId: string, levelNumber: number): Promise<void> {
    try {
      await this.withOptimisticRetry(instanceId, async (instance) => {
        if (instance.status !== 'pending') return instance;
        const level = instance.levels.find((l) => l.level === levelNumber);
        if (!level || level.status !== 'pending' || !level.reminderDueAt) return instance;

        const sentSoFar = level.remindersSent ?? 0;
        const cap = level.maxReminders ?? DEFAULT_MAX_REMINDERS;
        if (sentSoFar >= cap) {
          level.reminderDueAt = undefined;
          await this.opts.adapter.updateInstance(instance, instance.version);
          return instance;
        }

        const now = this.clock.now();
        const reminderNumber = sentSoFar + 1;
        level.remindersSent = reminderNumber;

        // Schedule the next one, or stop if this was the last permitted.
        level.reminderDueAt =
          level.reminderEveryDays && reminderNumber < cap
            ? this.deadlineFrom(now, level.reminderEveryDays)
            : undefined;

        const recipients = level.approverIds.filter(
          (id) => !level.approvedBy.includes(id) && !level.rejectedBy.includes(id),
        );

        const auditEntry: AuditEntry = {
          action: 'reminded',
          actorId: 'system',
          level: level.level,
          timestamp: now,
          newValue: { reminderNumber, recipients },
        };
        instance.auditLog.push(auditEntry);
        instance.updatedAt = now;

        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
        this.opts.metricsAdapter?.increment('approval.reminded', { tenantId: this.tenantId });
        this.logger.info('reminder: nudged pending approvers', {
          tenantId: this.tenantId,
          instanceId,
          levelNumber,
          reminderNumber,
          recipients,
        });

        const payload = {
          instanceId,
          documentId: instance.documentId,
          documentType: instance.documentType,
          timestamp: now,
          level: level.level,
          recipients,
          reminderNumber,
        };
        this.bus.emit('approval:reminder', payload);
        await this.notifyAdapters('approval:reminder', instance, payload);
        return instance;
      });
    } catch (err) {
      this.logger.error('reminder: failed to send', err, { tenantId: this.tenantId, instanceId });
    }
  }

  /**
   * Start child approvals for any open level that delegates to a sub-workflow.
   *
   * Run after the parent has been persisted, never inside the same optimistic
   * write: the child's own `submit()` performs its own reads and writes, and
   * nesting them under the parent's compare-and-set would make a slow child
   * template a source of spurious version conflicts on the parent.
   */
  private async startSubWorkflows(instance: ApprovalInstance): Promise<void> {
    const pendingSubs = instance.levels.filter(
      (l) => l.status === 'pending' && l.subWorkflowTemplate && !l.childInstanceId,
    );
    if (pendingSubs.length === 0) return;

    const depth = (instance.subWorkflowDepth ?? 0) + 1;
    if (depth > MAX_SUBWORKFLOW_DEPTH) {
      throw new ApprovalValidationError(
        `Sub-workflow nesting exceeded ${MAX_SUBWORKFLOW_DEPTH} levels at template "${instance.templateName}". Check for a template that reaches itself.`,
      );
    }

    for (const level of pendingSubs) {
      const templateName = level.subWorkflowTemplate as string;
      const childTemplate = await this.registry.get(templateName);

      const child = await this.submit(
        {
          templateName,
          // Unique per parent level, so a resubmitted parent does not collide
          // with the child it spawned last time.
          documentId: `${instance.documentId}#L${level.level}`,
          documentType: childTemplate.documentType,
          submittedBy: instance.submittedBy,
          data: instance.data,
          metadata: { ...instance.metadata, parentInstanceId: instance.id },
        },
        undefined,
        { parentInstanceId: instance.id, parentLevel: level.level, depth },
      );

      await this.withOptimisticRetry(instance.id, async (parent) => {
        const lvl = parent.levels.find((l) => l.level === level.level);
        if (!lvl || lvl.childInstanceId) return parent;
        lvl.childInstanceId = child.id;
        parent.updatedAt = this.clock.now();
        await this.opts.adapter.updateInstance(parent, parent.version);
        return parent;
      });

      const payload = {
        instanceId: instance.id,
        documentId: instance.documentId,
        documentType: instance.documentType,
        timestamp: this.clock.now(),
        level: level.level,
        childInstanceId: child.id,
        childTemplateName: templateName,
      };
      this.bus.emit('approval:subworkflow_started', payload);
      await this.notifyAdapters('approval:subworkflow_started', instance, payload);
      this.logger.info('subWorkflow: child approval started', {
        tenantId: this.tenantId,
        instanceId: instance.id,
        level: level.level,
        childInstanceId: child.id,
      });
    }
  }

  /**
   * Return a finished child's outcome to the parent level that is waiting on it.
   *
   * An approved child approves its parent level and lets the chain advance; any
   * other terminal outcome — rejected, cancelled, expired — rejects the parent,
   * because the approval the parent was waiting for did not happen. Collapsing
   * those into one rejection is deliberate: a parent that treated a cancelled
   * child as "carry on" would advance past a gate nobody cleared.
   */
  private async propagateToParent(child: ApprovalInstance): Promise<void> {
    if (!child.parentInstanceId || child.parentLevel === undefined) return;

    const outcome = child.status;
    const parentId = child.parentInstanceId;
    const parentLevelNumber = child.parentLevel;

    try {
      const parent = await this.opts.adapter.getInstance(this.tenantId, parentId);
      if (!parent || parent.status !== 'pending') return;

      const payload = {
        instanceId: parentId,
        documentId: parent.documentId,
        documentType: parent.documentType,
        timestamp: this.clock.now(),
        level: parentLevelNumber,
        childInstanceId: child.id,
        childTemplateName: child.templateName,
        outcome: outcome as 'approved' | 'rejected' | 'cancelled' | 'expired',
      };

      if (outcome === 'approved') {
        await this.completeSubWorkflowLevel(parentId, parentLevelNumber, child);
      } else {
        await this.rejectFromSubWorkflow(parentId, parentLevelNumber, child);
      }

      const refreshed = await this.opts.adapter.getInstance(this.tenantId, parentId);
      this.bus.emit('approval:subworkflow_completed', payload);
      if (refreshed) {
        await this.notifyAdapters('approval:subworkflow_completed', refreshed, payload);
      }
    } catch (err) {
      // A parent that cannot be advanced must not fail the child's own decision,
      // which is already recorded. Surface it loudly instead.
      this.logger.error('subWorkflow: failed to propagate outcome to parent', err, {
        tenantId: this.tenantId,
        childInstanceId: child.id,
        parentInstanceId: parentId,
      });
    }
  }

  /** Mark a sub-workflow level approved and advance the parent chain. */
  private async completeSubWorkflowLevel(
    parentId: string,
    levelNumber: number,
    child: ApprovalInstance,
  ): Promise<void> {
    let advanced: ApprovalInstance | null = null;

    await this.withOptimisticRetry(parentId, async (parent) => {
      const level = parent.levels.find((l) => l.level === levelNumber);
      if (!level || level.status !== 'pending') return parent;

      const now = this.clock.now();
      level.status = 'approved';
      level.reminderDueAt = undefined;
      level.escalationDueAt = undefined;

      const auditEntry: AuditEntry = {
        action: 'subworkflow_completed',
        actorId: 'system',
        level: levelNumber,
        timestamp: now,
        newValue: { childInstanceId: child.id, outcome: 'approved' },
      };
      parent.auditLog.push(auditEntry);
      parent.updatedAt = now;

      // The whole group must be done before the chain moves on, exactly as for
      // an ordinary level inside a parallel group.
      const siblingsOpen = this.groupMembers(parent, level).some(
        (l) => l.status === 'pending' || l.status === 'waiting',
      );
      if (!siblingsOpen) {
        const nextGroup = this.findNextGroup(parent);
        if (nextGroup.length === 0) {
          parent.status = 'approved';
        } else {
          await this.activateGroup(parent, nextGroup, now);
        }
      }

      await this.opts.adapter.updateInstance(parent, parent.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, parentId, auditEntry);
      await this.runExternalAudit(parent, auditEntry);
      advanced = parent;
      return parent;
    });

    if (advanced) {
      const parent = advanced as ApprovalInstance;
      if (parent.status === 'approved') {
        this.bus.emit('approval:completed', parent);
        await this.notifyAdapters('approval:completed', parent, parent);
        await this.propagateToParent(parent);
      } else {
        // A newly opened group may itself contain sub-workflow levels.
        await this.startSubWorkflows(parent);
      }
    }
  }

  /** Reject a parent because the child approval it was waiting on did not succeed. */
  private async rejectFromSubWorkflow(
    parentId: string,
    levelNumber: number,
    child: ApprovalInstance,
  ): Promise<void> {
    let rejected: ApprovalInstance | null = null;

    await this.withOptimisticRetry(parentId, async (parent) => {
      const level = parent.levels.find((l) => l.level === levelNumber);
      if (!level || level.status !== 'pending') return parent;

      const now = this.clock.now();
      level.status = 'rejected';
      level.reminderDueAt = undefined;
      level.escalationDueAt = undefined;
      parent.status = 'rejected';
      parent.updatedAt = now;

      const auditEntry: AuditEntry = {
        action: 'subworkflow_completed',
        actorId: 'system',
        level: levelNumber,
        timestamp: now,
        reason: `Child approval ${child.id} ended as "${child.status}".`,
        newValue: { childInstanceId: child.id, outcome: child.status },
      };
      parent.auditLog.push(auditEntry);

      await this.opts.adapter.updateInstance(parent, parent.version);
      await this.opts.adapter.appendAuditEntry(this.tenantId, parentId, auditEntry);
      await this.runExternalAudit(parent, auditEntry);
      rejected = parent;
      return parent;
    });

    if (rejected) {
      const parent = rejected as ApprovalInstance;
      const payload = {
        instanceId: parent.id,
        documentId: parent.documentId,
        documentType: parent.documentType,
        timestamp: this.clock.now(),
        approverId: 'system',
        level: levelNumber,
        reason: `Child approval ${child.id} ended as "${child.status}".`,
        returnTo: null,
      };
      this.bus.emit('approval:rejected', payload);
      await this.notifyAdapters('approval:rejected', parent, payload);
      await this.propagateToParent(parent);
    }
  }

  /**
   * Work that must happen after a decision is durably recorded, not inside it.
   *
   * Both branches touch other instances — a newly opened level may spawn a
   * child approval, and a finished instance may be a child that owes its
   * outcome to a parent. Doing either inside the deciding instance's
   * compare-and-set would nest writes under a version guard that knows nothing
   * about them, so a slow child template would surface as a spurious conflict
   * on the decision the user just made.
   */
  /**
   * An instance and every sub-workflow descendant beneath it, parents first.
   *
   * A child is only reachable through its parent's `childInstanceId`, so a
   * purge that removed the parent alone would strand the rest of the tree.
   * Depth is bounded by the same cap that limits spawning, and an already-seen
   * id is skipped so a corrupted link cannot loop.
   */
  private async collectSubWorkflowFamily(root: ApprovalInstance): Promise<ApprovalInstance[]> {
    const family: ApprovalInstance[] = [root];
    const seen = new Set<string>([root.id]);
    const queue: ApprovalInstance[] = [root];

    for (let depth = 0; queue.length > 0 && depth <= MAX_SUBWORKFLOW_DEPTH; depth++) {
      const generation = queue.splice(0, queue.length);
      for (const parent of generation) {
        for (const level of parent.levels) {
          const childId = level.childInstanceId;
          if (!childId || seen.has(childId)) continue;
          seen.add(childId);
          const child = await this.opts.adapter.getInstance(this.tenantId, childId);
          if (!child) continue;
          family.push(child);
          queue.push(child);
        }
      }
    }
    return family;
  }

  /**
   * Cancel sub-workflow children whose parent has finished.
   *
   * A child outlives its parent otherwise: it stays pending, keeps notifying
   * and escalating, and keeps appearing in {@link getWorkload} — asking people
   * to decide something whose outcome nobody will ever read, because
   * {@link propagateToParent} ignores a parent that is no longer pending.
   *
   * Cancelling rather than deleting keeps the child's own audit trail intact:
   * the people who were asked, and why the request stopped, stay on the record.
   */
  private async cancelOrphanedChildren(parent: ApprovalInstance): Promise<void> {
    const childIds = parent.levels
      .map((l) => l.childInstanceId)
      .filter((id): id is string => typeof id === 'string');
    if (childIds.length === 0) return;

    for (const childId of childIds) {
      try {
        const child = await this.opts.adapter.getInstance(this.tenantId, childId);
        if (!child || TERMINAL_STATUSES.has(child.status)) continue;
        await this.cancel(childId, {
          cancelledBy: 'system',
          reason: `Parent approval ${parent.id} ended as "${parent.status}".`,
        });
      } catch (err) {
        // A child that cannot be cancelled must not undo the parent's own
        // decision, which is already recorded.
        this.logger.error('subWorkflow: failed to cancel orphaned child', err, {
          tenantId: this.tenantId,
          parentInstanceId: parent.id,
          childInstanceId: childId,
        });
      }
    }
  }

  private async afterDecision(instance: ApprovalInstance): Promise<void> {
    if (TERMINAL_STATUSES.has(instance.status)) {
      await this.cancelOrphanedChildren(instance);
      await this.propagateToParent(instance);
      return;
    }
    await this.startSubWorkflows(instance);
  }

  private findNextLevel(instance: ApprovalInstance): ApprovalLevelInstance | null {
    return (
      instance.levels.find((l) => l.level > instance.currentLevel && l.status === 'waiting') ?? null
    );
  }

  private findPreviousLevel(instance: ApprovalInstance): ApprovalLevelInstance | null {
    return (
      [...instance.levels]
        .filter((l) => l.level < instance.currentLevel)
        .sort((a, b) => b.level - a.level)[0] ?? null
    );
  }

  private guardBulkSize(instanceIds: string[]): void {
    if (instanceIds.length > this.maxBulkItems) {
      throw new ApprovalValidationError(
        `Bulk operation exceeds maximum allowed items (${this.maxBulkItems}). Got ${instanceIds.length}.`,
      );
    }
  }

  // ─── Extension point helpers ──────────────────────────────────────────────

  private async runAuthorizationPolicy(ctx: AuthorizationContext): Promise<void> {
    if (!this.opts.authorizationPolicy) return;
    try {
      const denial = await this.opts.authorizationPolicy.authorize(ctx);
      if (denial) throw new ApprovalForbiddenError(denial);
    } catch (err) {
      if (err instanceof ApprovalForbiddenError) throw err;
      this.logger.error('authorizationPolicy.authorize threw unexpectedly', err, {
        tenantId: this.tenantId,
      });
      throw err;
    }
  }

  private async runMiddlewareBefore(ctx: OperationContext): Promise<void> {
    if (!this.opts.middleware?.length) return;
    for (const mw of this.opts.middleware) {
      try {
        await mw.before?.(ctx);
      } catch (err) {
        this.logger.error('middleware.before threw', err, { operation: ctx.operation });
      }
    }
  }

  private async runMiddlewareAfter(
    ctx: OperationContext,
    result?: ApprovalInstance | void,
  ): Promise<void> {
    if (!this.opts.middleware?.length) return;
    for (const mw of this.opts.middleware) {
      try {
        await mw.after?.(ctx, result);
      } catch (err) {
        this.logger.error('middleware.after threw', err, { operation: ctx.operation });
      }
    }
  }

  private async notifyAdapters(
    eventType: ApprovalEventName,
    instance: ApprovalInstance,
    payload: ApprovalEventMap[ApprovalEventName],
  ): Promise<void> {
    if (!this.opts.notificationAdapter) return;

    // An event that names its own audience keeps it: a comment mentioning one
    // person, a reminder aimed at those who have not voted, a question put to
    // the submitter. Overwriting those with "the current level" sent each of
    // them to the wrong people.
    const named = (payload as { recipients?: unknown }).recipients;
    const recipients = Array.isArray(named)
      ? (named as string[])
      : // Otherwise everyone who currently owes a decision. Reading one level by
        // instance.currentLevel notified only the lowest branch of a parallel
        // group, so an approver on any other branch never heard that work had
        // arrived. Matches getCurrentApprovers().
        [...new Set(this.pendingLevels(instance).flatMap((l) => l.approverIds))];

    const notifEvent = {
      type: eventType,
      instanceId: instance.id,
      documentId: instance.documentId,
      documentType: instance.documentType,
      timestamp: this.clock.now(),
      recipients,
      templateName: instance.templateName,
      tenantId: instance.tenantId,
      payload,
    };
    try {
      await this.opts.notificationAdapter.notify(notifEvent);
    } catch (err) {
      this.logger.error('notificationAdapter.notify threw', err, {
        tenantId: this.tenantId,
        instanceId: instance.id,
      });
    }
  }

  private async runExternalAudit(instance: ApprovalInstance, entry: AuditEntry): Promise<void> {
    if (!this.opts.auditAdapter) return;
    try {
      await this.opts.auditAdapter.append(this.tenantId, instance.id, entry, instance);
    } catch (err) {
      this.logger.error('auditAdapter.append threw', err, {
        tenantId: this.tenantId,
        instanceId: instance.id,
      });
    }
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────────

function defaultIdempotencyKeyFn(
  tenantId: string,
  documentType: string,
  documentId: string,
  templateName: string,
  _data: Record<string, unknown>,
): string {
  return createHash('sha256')
    .update(`${tenantId}:${documentType}:${documentId}:${templateName}`)
    .digest('hex');
}

/** Map the shared {@link TimingStats} shape onto the ms-suffixed {@link CycleTimeStats} field names. */
function toCycleTimeStats(timing: TimingStats): CycleTimeStats {
  return {
    count: timing.count,
    averageMs: timing.avg,
    p50Ms: timing.p50,
    p95Ms: timing.p95,
    minMs: timing.min,
    maxMs: timing.max,
  };
}

function snapshotLevel(level: ApprovalLevelInstance): Record<string, unknown> {
  return {
    approverIds: [...level.approverIds],
    approvedBy: [...level.approvedBy],
    rejectedBy: [...level.rejectedBy],
    status: level.status,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseOrThrow<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw new ApprovalValidationError(err instanceof Error ? err.message : 'Invalid input', err);
  }
}
