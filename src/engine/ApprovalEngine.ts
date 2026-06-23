import { createHash } from 'node:crypto';
import type { IStorageAdapter, InstanceFilter, PaginationOpts, PaginatedResult, CursorPaginationOpts, CursorPaginatedResult } from '../adapters/IStorageAdapter.js';
import type {
  ApprovalTemplate,
  ApprovalTemplateConfig,
  ApprovalInstance,
  ApprovalLevelInstance,
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
} from '../utils/validate.js';
import { EventBus } from '../utils/EventBus.js';
import type { Logger } from '../utils/Logger.js';
import { noopLogger } from '../utils/Logger.js';
import type { Clock } from '../utils/Clock.js';
import { systemClock } from '../utils/Clock.js';
import type { BusinessCalendar } from '../utils/BusinessCalendar.js';
import type { IdGeneratorFn } from '../utils/IdGenerator.js';
import { defaultIdGenerator } from '../utils/IdGenerator.js';
import { TemplateRegistry } from './TemplateRegistry.js';
import { LevelResolver, type OrgProvider, type ApproverResolverFn } from './LevelResolver.js';
import { EscalationScheduler } from './EscalationScheduler.js';
import { evaluateConditions, registerConditionOperator, type ConditionOperatorFn } from './ConditionEvaluator.js';
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
} from '../errors.js';
import type { INotificationAdapter } from '../adapters/INotificationAdapter.js';
import type { IAuditAdapter } from '../adapters/IAuditAdapter.js';
import type { IMetricsAdapter } from '../adapters/IMetricsAdapter.js';
import type { ISchedulerAdapter } from '../adapters/ISchedulerAdapter.js';
import type { IAuthorizationPolicy, AuthorizationContext } from './IAuthorizationPolicy.js';
import type { IOperationMiddleware, OperationContext } from './IOperationMiddleware.js';

export { ApprovalError } from '../errors.js';
export {
  ApprovalNotFoundError,
  ApprovalConflictError,
  ApprovalForbiddenError,
  ApprovalValidationError,
  ApprovalTemplateNotFoundError,
} from '../errors.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 50;
const TERMINAL_STATUSES = new Set<ApprovalInstance['status']>(['approved', 'rejected', 'cancelled', 'expired']);

// ─── Exported result types ─────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: Array<{ field: string; message: string }>;
}

export interface CanApproveResult {
  eligible: boolean;
  reason?: 'not_an_approver' | 'already_acted' | 'self_approval' | 'wrong_status' | 'delegated_away';
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

export interface BulkResult {
  succeeded: ApprovalInstance[];
  failed: Array<{ instanceId: string; error: ApprovalError }>;
  total: number;
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
  generateId?: IdGeneratorFn;
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
  /** Custom scheduler adapter (BullMQ, Temporal, cron). Replaces built-in setInterval polling. */
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
  private readonly tenantId: string;
  private readonly logger: Logger;
  private readonly clock: Clock;
  private readonly calendar?: BusinessCalendar;
  private readonly generateId: IdGeneratorFn;
  private readonly maxBulkItems: number;
  private readonly retryPolicy: Required<RetryPolicy>;
  private readonly idempotencyKeyFn: IdempotencyKeyFn;

  constructor(private readonly opts: ApprovalEngineOptions) {
    this.tenantId = opts.tenantId ?? 'default';
    this.logger = opts.logger ?? noopLogger;
    this.clock = opts.clock ?? systemClock;
    this.calendar = opts.calendar;
    this.generateId = opts.generateId ?? defaultIdGenerator;
    this.maxBulkItems = opts.maxBulkItems ?? 200;
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
      onEscalate: async (id) => { await this.escalateInternal(id); },
      onExpire: async (id, action) => { await this.expireInstance(id, action); },
      onSlaBreach: async (id) => { await this.markSlaBreached(id); },
      onRevertDelegation: async (id, level, from) => { await this.revertDelegation(id, level, from); },
      pollIntervalMs: opts.escalationPollIntervalMs ?? 60_000,
      logger: this.logger,
      clock: this.clock,
    });
    this.escalation.start();
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

    if (!config.levels || config.levels.length === 0) {
      errors.push({ field: 'levels', message: 'Template must have at least one level.' });
    } else {
      const levelNums = new Set<number>();
      config.levels.forEach((l, i) => {
        if (levelNums.has(l.level)) {
          errors.push({ field: `levels[${i}].level`, message: `Duplicate level number: ${l.level}.` });
        }
        levelNums.add(l.level);

        if (!l.approvers || l.approvers.length === 0) {
          errors.push({ field: `levels[${i}].approvers`, message: `Level ${l.level} must have at least one approver.` });
        }
        if (l.escalationAfterDays !== undefined && l.escalationAfterDays <= 0) {
          errors.push({ field: `levels[${i}].escalationAfterDays`, message: `Level ${l.level} escalationAfterDays must be a positive number.` });
        }

        if (l.mode === 'quorum') {
          if (l.minApprovals === undefined || !Number.isInteger(l.minApprovals) || l.minApprovals < 1) {
            errors.push({ field: `levels[${i}].minApprovals`, message: `Level ${l.level} uses 'quorum' mode and requires minApprovals to be a positive integer.` });
          } else if (l.approvers && l.minApprovals > l.approvers.length) {
            // Conservative static check: only meaningful when every approver is a static 'user'.
            const allStaticUsers = l.approvers.every((a) => a.type === 'user');
            if (allStaticUsers) {
              errors.push({ field: `levels[${i}].minApprovals`, message: `Level ${l.level} requires ${l.minApprovals} approvals but only ${l.approvers.length} approver(s) are configured.` });
            }
          }
        }

        if (l.mode === 'weighted') {
          if (l.threshold === undefined || l.threshold <= 0) {
            errors.push({ field: `levels[${i}].threshold`, message: `Level ${l.level} uses 'weighted' mode and requires threshold to be a positive number.` });
          }
          if (l.weights) {
            for (const [id, w] of Object.entries(l.weights)) {
              if (typeof w !== 'number' || w < 0 || Number.isNaN(w)) {
                errors.push({ field: `levels[${i}].weights.${id}`, message: `Weight for "${id}" must be a non-negative number.` });
              }
            }
          }
        }
      });
    }

    if (config.conditions) {
      config.conditions.forEach((rule, ruleIdx) => {
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
    const validation = this.validateTemplate(config);
    if (!validation.valid) {
      const first = validation.errors[0];
      throw new ApprovalValidationError(
        `Invalid template configuration: ${first?.message ?? 'unknown error'}`,
      );
    }
    return this.registry.define(config);
  }

  /** Update an existing template, incrementing its version. In-flight instances are protected by their templateSnapshot. */
  async updateTemplate(config: ApprovalTemplateConfig): Promise<string> {
    const validation = this.validateTemplate(config);
    if (!validation.valid) {
      const first = validation.errors[0];
      throw new ApprovalValidationError(
        `Invalid template configuration: ${first?.message ?? 'unknown error'}`,
      );
    }
    return this.registry.update(config);
  }

  async getTemplate(name: string): Promise<ApprovalTemplate> {
    return this.registry.get(name);
  }

  async listTemplates(): Promise<ApprovalTemplate[]> {
    return this.registry.list();
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  async submit(raw: SubmitOptions, auditCtx?: AuditContext): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => SubmitOptionsSchema.parse(raw));
    const startMs = this.clock.now().getTime();
    const template = await this.registry.get(opts.templateName);

    const idempotencyKey = this.idempotencyKeyFn(this.tenantId, opts.documentType, opts.documentId, opts.templateName, opts.data);
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
        opts.submittedBy,
        opts.data,
        this.opts.orgProvider,
      );
    }

    const auditEntry: AuditEntry = {
      action: 'submitted',
      actorId: opts.submittedBy,
      level: allLevelCfgs[0]?.level ?? 1,
      timestamp: now,
      ...auditCtx,
    };

    const slaDeadlineAt = template.slaDeadlineDays
      ? this.deadlineFrom(now, template.slaDeadlineDays)
      : undefined;

    const instance: ApprovalInstance = {
      id: instanceId,
      tenantId: this.tenantId,
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
        slaDeadlineDays: template.slaDeadlineDays,
        allowOverride: template.allowOverride,
      },
    };

    await this.runMiddlewareBefore({ operation: 'submit', actorId: opts.submittedBy, tenantId: this.tenantId, input: opts });
    await this.opts.adapter.saveInstance(instance);

    this.logger.info('submit: instance created', {
      tenantId: this.tenantId,
      instanceId,
      documentId: opts.documentId,
      templateName: opts.templateName,
    });

    this.opts.metricsAdapter?.increment('approval.submitted', { tenantId: this.tenantId, templateName: template.name });
    this.opts.metricsAdapter?.timing('approval.operation_duration_ms', this.clock.now().getTime() - startMs, { operation: 'submit' });

    const eventPayload = {
      instanceId: instance.id,
      documentId: instance.documentId,
      documentType: instance.documentType,
      timestamp: now,
      submittedBy: opts.submittedBy,
      currentApprovers: firstLevel?.approverIds ?? [],
    };
    this.bus.emit('approval:submitted', eventPayload);
    await this.notifyAdapters('approval:submitted', instance, eventPayload);
    await this.runExternalAudit(instance, auditEntry);
    await this.runMiddlewareAfter({ operation: 'submit', actorId: opts.submittedBy, tenantId: this.tenantId, input: opts }, instance);

    return instance;
  }

  async approve(instanceId: string, raw: ApproveOptions, auditCtx?: AuditContext): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => ApproveOptionsSchema.parse(raw));
    const startMs = this.clock.now().getTime();
    return this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      if (opts.approverId === instance.submittedBy) {
        throw new ApprovalForbiddenError(
          `Self-approval is not permitted. Approver "${opts.approverId}" submitted this request.`,
        );
      }

      const level = this.currentLevelInstance(instance);
      await this.runAuthorizationPolicy({ operation: 'approve', actorId: opts.approverId, instance, level, opts: opts as Record<string, unknown> });
      await this.runMiddlewareBefore({ operation: 'approve', instanceId, actorId: opts.approverId, tenantId: this.tenantId, input: opts });

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
        const nextLevel = this.findNextLevel(instance);

        if (!nextLevel) {
          instance.status = 'approved';
          await this.opts.adapter.updateInstance(instance, instance.version);
          await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
          await this.runExternalAudit(instance, auditEntry);
          this.logger.info('approve: instance fully approved', { tenantId: this.tenantId, instanceId });
          this.opts.metricsAdapter?.increment('approval.approved', { tenantId: this.tenantId, isFinal: 'true' });
          this.opts.metricsAdapter?.timing('approval.operation_duration_ms', this.clock.now().getTime() - startMs, { operation: 'approve' });
          const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, approverId: opts.approverId, level: level.level, comment: opts.comment, isFinal: true };
          this.bus.emit('approval:approved', p);
          this.bus.emit('approval:completed', instance);
          await this.notifyAdapters('approval:approved', instance, p);
          await this.runMiddlewareAfter({ operation: 'approve', instanceId, actorId: opts.approverId, tenantId: this.tenantId, input: opts }, instance);
          return instance;
        }

        nextLevel.approverIds = await this.resolver.resolveApprovers(
          nextLevel.approverConfigs,
          instance.submittedBy,
          instance.data,
          this.opts.orgProvider,
        );
        if (nextLevel.escalationAfterDays) {
          nextLevel.escalationDueAt = this.deadlineFrom(now, nextLevel.escalationAfterDays);
        }
        nextLevel.status = 'pending';
        instance.currentLevel = nextLevel.level;

        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
        this.opts.metricsAdapter?.increment('approval.approved', { tenantId: this.tenantId, isFinal: 'false' });
        this.opts.metricsAdapter?.timing('approval.operation_duration_ms', this.clock.now().getTime() - startMs, { operation: 'approve' });
        const pAdv = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, approverId: opts.approverId, level: level.level, comment: opts.comment, isFinal: false };
        this.bus.emit('approval:approved', pAdv);
        const pLvl = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, fromLevel: level.level, toLevel: nextLevel.level, newApprovers: nextLevel.approverIds };
        this.bus.emit('approval:level_advanced', pLvl);
        await this.notifyAdapters('approval:level_advanced', instance, pLvl);
        await this.runMiddlewareAfter({ operation: 'approve', instanceId, actorId: opts.approverId, tenantId: this.tenantId, input: opts }, instance);
      } else {
        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
        this.opts.metricsAdapter?.increment('approval.approved', { tenantId: this.tenantId });
        this.opts.metricsAdapter?.timing('approval.operation_duration_ms', this.clock.now().getTime() - startMs, { operation: 'approve' });
        const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, approverId: opts.approverId, level: level.level, comment: opts.comment, isFinal: false };
        this.bus.emit('approval:approved', p);
        await this.notifyAdapters('approval:approved', instance, p);
        await this.runMiddlewareAfter({ operation: 'approve', instanceId, actorId: opts.approverId, tenantId: this.tenantId, input: opts }, instance);
      }

      return instance;
    });
  }

  async reject(instanceId: string, raw: RejectOptions, auditCtx?: AuditContext): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => RejectOptionsSchema.parse(raw));
    return this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      if (opts.approverId === instance.submittedBy) {
        throw new ApprovalForbiddenError(
          `Self-rejection is not permitted. Approver "${opts.approverId}" submitted this request.`,
        );
      }

      const level = this.currentLevelInstance(instance);
      await this.runAuthorizationPolicy({ operation: 'reject', actorId: opts.approverId, instance, level, opts: opts as Record<string, unknown> });
      await this.runMiddlewareBefore({ operation: 'reject', instanceId, actorId: opts.approverId, tenantId: this.tenantId, input: opts });

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
          const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, approverId: opts.approverId, level: level.level, reason: opts.reason, returnTo: 'previous' as const };
          this.bus.emit('approval:rejected', p);
          await this.notifyAdapters('approval:rejected', instance, p);
          await this.runMiddlewareAfter({ operation: 'reject', instanceId, actorId: opts.approverId, tenantId: this.tenantId, input: opts }, instance);
          return instance;
        }

        instance.status = 'rejected';
        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
        this.opts.metricsAdapter?.increment('approval.rejected', { tenantId: this.tenantId });
        this.logger.info('reject: instance rejected', { tenantId: this.tenantId, instanceId });
        const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, approverId: opts.approverId, level: level.level, reason: opts.reason, returnTo: opts.returnTo === 'originator' ? 'originator' as const : null };
        this.bus.emit('approval:rejected', p);
        await this.notifyAdapters('approval:rejected', instance, p);
        await this.runMiddlewareAfter({ operation: 'reject', instanceId, actorId: opts.approverId, tenantId: this.tenantId, input: opts }, instance);
      } else {
        await this.opts.adapter.updateInstance(instance, instance.version);
        await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
        await this.runExternalAudit(instance, auditEntry);
      }

      return instance;
    });
  }

  async delegate(instanceId: string, raw: DelegateOptions, auditCtx?: AuditContext): Promise<void> {
    const opts = parseOrThrow(() => DelegateOptionsSchema.parse(raw));
    await this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      if (opts.fromApprover === opts.toApprover) {
        throw new ApprovalForbiddenError('Cannot delegate to yourself.');
      }

      const level = this.currentLevelInstance(instance);
      await this.runAuthorizationPolicy({ operation: 'delegate', actorId: opts.fromApprover, instance, level, opts: opts as Record<string, unknown> });
      await this.runMiddlewareBefore({ operation: 'delegate', instanceId, actorId: opts.fromApprover, tenantId: this.tenantId, input: opts });

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
      const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, fromApprover: opts.fromApprover, toApprover: opts.toApprover, level: level.level, reason: opts.reason };
      this.bus.emit('approval:delegated', p);
      await this.notifyAdapters('approval:delegated', instance, p);
      await this.runMiddlewareAfter({ operation: 'delegate', instanceId, actorId: opts.fromApprover, tenantId: this.tenantId, input: opts }, instance);
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
  async reassign(instanceId: string, raw: ReassignOptions, auditCtx?: AuditContext): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => ReassignOptionsSchema.parse(raw));
    return this.withOptimisticRetry(instanceId, async (instance) => {
      assertStatus(instance, 'pending');

      if (opts.fromApprover === opts.toApprover) {
        throw new ApprovalForbiddenError('Cannot reassign an approver to themselves.');
      }

      const level = this.currentLevelInstance(instance);
      await this.runAuthorizationPolicy({ operation: 'reassign', actorId: opts.reassignedBy, instance, level, opts: opts as Record<string, unknown> });
      await this.runMiddlewareBefore({ operation: 'reassign', instanceId, actorId: opts.reassignedBy, tenantId: this.tenantId, input: opts });

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
      this.logger.info('reassign: approver replaced', { tenantId: this.tenantId, instanceId, from: opts.fromApprover, to: opts.toApprover });
      const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, reassignedBy: opts.reassignedBy, fromApprover: opts.fromApprover, toApprover: opts.toApprover, level: level.level, reason: opts.reason };
      this.bus.emit('approval:reassigned', p);
      await this.notifyAdapters('approval:reassigned', instance, p);
      await this.runMiddlewareAfter({ operation: 'reassign', instanceId, actorId: opts.reassignedBy, tenantId: this.tenantId, input: opts }, instance);
      return instance;
    });
  }

  async cancel(instanceId: string, raw: CancelOptions, auditCtx?: AuditContext): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => CancelOptionsSchema.parse(raw));
    return this.withOptimisticRetry(instanceId, async (instance) => {
      if (instance.status === 'approved' || instance.status === 'rejected') {
        throw new ApprovalError(`Cannot cancel a "${instance.status}" approval.`, 'CANNOT_CANCEL');
      }

      await this.runAuthorizationPolicy({ operation: 'cancel', actorId: opts.cancelledBy, instance, opts: opts as Record<string, unknown> });
      await this.runMiddlewareBefore({ operation: 'cancel', instanceId, actorId: opts.cancelledBy, tenantId: this.tenantId, input: opts });

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
      const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, cancelledBy: opts.cancelledBy, reason: opts.reason };
      this.bus.emit('approval:cancelled', p);
      await this.notifyAdapters('approval:cancelled', instance, p);
      await this.runMiddlewareAfter({ operation: 'cancel', instanceId, actorId: opts.cancelledBy, tenantId: this.tenantId, input: opts }, instance);
      return instance;
    });
  }

  async escalate(instanceId: string, raw: EscalateOptions, auditCtx?: AuditContext): Promise<ApprovalInstance> {
    parseOrThrow(() => EscalateOptionsSchema.parse(raw));
    return this.escalateInternal(instanceId, raw.escalatedBy, auditCtx);
  }

  /** Add a comment to an instance without approving or rejecting. */
  async addComment(instanceId: string, raw: AddCommentOptions, auditCtx?: AuditContext): Promise<void> {
    const opts = parseOrThrow(() => AddCommentOptionsSchema.parse(raw));
    const instance = await this.requireInstance(instanceId);

    await this.runAuthorizationPolicy({ operation: 'addComment', actorId: opts.actorId, instance, opts: opts as Record<string, unknown> });
    await this.runMiddlewareBefore({ operation: 'addComment', instanceId, actorId: opts.actorId, tenantId: this.tenantId, input: opts });

    const now = this.clock.now();
    const auditEntry: AuditEntry = {
      action: 'commented',
      actorId: opts.actorId,
      level: instance.currentLevel,
      timestamp: now,
      comment: opts.comment,
      ...auditCtx,
    };

    instance.auditLog.push(auditEntry);
    instance.updatedAt = now;

    await this.opts.adapter.updateInstance(instance, instance.version);
    await this.opts.adapter.appendAuditEntry(this.tenantId, instanceId, auditEntry);
    await this.runExternalAudit(instance, auditEntry);
    await this.runMiddlewareAfter({ operation: 'addComment', instanceId, actorId: opts.actorId, tenantId: this.tenantId, input: opts });
  }

  /** Resubmit a rejected instance, creating a new linked instance from level 1. */
  async resubmit(instanceId: string, raw: ResubmitOptions, auditCtx?: AuditContext): Promise<ApprovalInstance> {
    const opts = parseOrThrow(() => ResubmitOptionsSchema.parse(raw));
    const original = await this.requireInstance(instanceId);

    if (original.status !== 'rejected') {
      throw new ApprovalForbiddenError(
        `Cannot resubmit an instance with status "${original.status}". Only rejected instances can be resubmitted.`,
      );
    }

    await this.runAuthorizationPolicy({ operation: 'resubmit', actorId: opts.resubmittedBy, instance: original, opts: opts as Record<string, unknown> });
    await this.runMiddlewareBefore({ operation: 'resubmit', instanceId, actorId: opts.resubmittedBy, tenantId: this.tenantId, input: opts });

    const template = await this.registry.get(original.templateName);
    const mergedData = { ...original.data, ...(opts.updatedData ?? {}) };

    const mutations = evaluateConditions(template.conditions ?? [], mergedData);
    const allLevelCfgs = [...template.levels, ...mutations.addLevels]
      .filter((l) => !mutations.skipLevels.has(l.level))
      .sort((a, b) => a.level - b.level);

    if (allLevelCfgs.length === 0) {
      throw new ApprovalValidationError('Template has no active levels after condition evaluation.');
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

    const slaDeadlineAt = template.slaDeadlineDays
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
        slaDeadlineDays: template.slaDeadlineDays,
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
    await this.runMiddlewareAfter({ operation: 'resubmit', instanceId, actorId: opts.resubmittedBy, tenantId: this.tenantId, input: opts }, newInstance);

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
        const resolvedApprovers = await this.resolver.resolveApprovers(
          cfg.approvers,
          submittedBy,
          data,
          this.opts.orgProvider,
        );
        levels.push({ level: cfg.level, name: cfg.name, resolvedApprovers, mode: cfg.mode });
      } catch {
        levels.push({ level: cfg.level, name: cfg.name, resolvedApprovers: [], mode: cfg.mode });
      }
    }

    return { levels, conditionsApplied };
  }

  /** Check whether a user is eligible to approve a specific instance. Never throws. */
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

    const level = this.currentLevelInstance(instance);

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
  async override(instanceId: string, raw: OverrideOptions, auditCtx?: AuditContext): Promise<ApprovalInstance> {
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
        throw new ApprovalForbiddenError(
          'Override cannot be performed by the original submitter.',
        );
      }

      await this.runAuthorizationPolicy({ operation: 'override', actorId: opts.overriddenBy, instance, opts: opts as Record<string, unknown> });
      await this.runMiddlewareBefore({ operation: 'override', instanceId, actorId: opts.overriddenBy, tenantId: this.tenantId, input: opts });

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
      await this.runMiddlewareAfter({ operation: 'override', instanceId, actorId: opts.overriddenBy, tenantId: this.tenantId, input: opts }, instance);

      return instance;
    });
  }

  /** Approve multiple instances in one call. Never throws — failures collected in result.failed. */
  async bulkApprove(instanceIds: string[], raw: ApproveOptions, auditCtx?: AuditContext): Promise<BulkResult> {
    const opts = parseOrThrow(() => ApproveOptionsSchema.parse(raw));
    this.guardBulkSize(instanceIds);

    const result: BulkResult = { succeeded: [], failed: [], total: instanceIds.length };
    for (const id of instanceIds) {
      try {
        result.succeeded.push(await this.approve(id, opts, auditCtx));
      } catch (err) {
        result.failed.push({ instanceId: id, error: err instanceof ApprovalError ? err : new ApprovalError(String(err), 'UNKNOWN') });
      }
    }
    return result;
  }

  /** Reject multiple instances in one call. Never throws — failures collected in result.failed. */
  async bulkReject(instanceIds: string[], raw: RejectOptions, auditCtx?: AuditContext): Promise<BulkResult> {
    const opts = parseOrThrow(() => RejectOptionsSchema.parse(raw));
    this.guardBulkSize(instanceIds);

    const result: BulkResult = { succeeded: [], failed: [], total: instanceIds.length };
    for (const id of instanceIds) {
      try {
        result.succeeded.push(await this.reject(id, opts, auditCtx));
      } catch (err) {
        result.failed.push({ instanceId: id, error: err instanceof ApprovalError ? err : new ApprovalError(String(err), 'UNKNOWN') });
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
    return this.currentLevelInstance(instance).approverIds;
  }

  /** Check adapter connectivity and escalation scheduler health. */
  async healthCheck(): Promise<HealthResult> {
    let adapterStatus: 'connected' | 'error' = 'connected';
    let pendingCount = 0;
    let overdueCount = 0;

    try {
      const result = await this.opts.adapter.getInstancesByFilter(
        this.tenantId,
        { status: 'pending' },
        { limit: 1, offset: 0 },
      );
      pendingCount = result.total;
    } catch {
      adapterStatus = 'error';
    }

    if (adapterStatus === 'connected') {
      try {
        const overdue = await this.opts.adapter.getOverdueInstances(this.tenantId, this.clock.now());
        overdueCount = overdue.length;
      } catch {
        adapterStatus = 'error';
      }
    }

    const status =
      adapterStatus === 'error'
        ? 'unhealthy'
        : overdueCount > 0
          ? 'degraded'
          : 'healthy';

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
  async getStatistics(filter: Omit<InstanceFilter, 'status'> = {}): Promise<ApprovalStatistics> {
    const statuses: ApprovalInstance['status'][] = ['pending', 'approved', 'rejected', 'cancelled', 'expired'];

    const counts = await Promise.all(
      statuses.map((status) =>
        this.opts.adapter
          .getInstancesByFilter(this.tenantId, { ...filter, status }, { limit: 1, offset: 0 })
          .then((r) => r.total),
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
    const overdueList = await this.opts.adapter.getOverdueInstances(this.tenantId, this.clock.now());
    const resolved = byStatus.approved + byStatus.rejected;
    const approvalRate = resolved === 0 ? 0 : byStatus.approved / resolved;

    return { total, byStatus, overdue: overdueList.length, approvalRate };
  }

  async shutdown(): Promise<void> {
    await this.escalation.stop();
    await this.opts.schedulerAdapter?.shutdown();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private async escalateInternal(
    instanceId: string,
    escalatedBy = 'system',
    auditCtx?: AuditContext,
  ): Promise<ApprovalInstance> {
    return this.withOptimisticRetry(instanceId, async (instance) => {
      if (instance.status !== 'pending') return instance;

      const escalationConfig = instance.templateSnapshot?.escalation
        ?? (await this.registry.get(instance.templateName)).escalation;
      if (!escalationConfig) return instance;

      const newApprovers = await this.resolver.resolveApprovers(
        [escalationConfig.escalateTo],
        instance.submittedBy,
        instance.data,
        this.opts.orgProvider,
      );

      const filteredApprovers = newApprovers.filter((id) => id !== instance.submittedBy);
      if (filteredApprovers.length === 0) {
        this.logger.warn('escalateInternal: escalation resolved to submitter only — no approvers added', {
          tenantId: this.tenantId,
          instanceId,
        });
        return instance;
      }

      const level = this.currentLevelInstance(instance);
      level.approverIds = [...new Set([...level.approverIds, ...filteredApprovers])];
      level.escalationDueAt = undefined;

      const now = this.clock.now();
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
      this.logger.info('escalate: instance escalated', { tenantId: this.tenantId, instanceId, escalatedTo });
      const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, level: level.level, escalatedTo };
      this.bus.emit('approval:escalated', p);
      await this.notifyAdapters('approval:escalated', instance, p);
      return instance;
    });
  }

  private async expireInstance(instanceId: string, deadlineAction: 'cancel' | 'reject'): Promise<void> {
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

        const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, deadlineAction };
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

        const p = { instanceId, documentId: instance.documentId, documentType: instance.documentType, timestamp: now, slaDeadlineAt: instance.slaDeadlineAt ?? now };
        this.bus.emit('approval:sla_breached', p);
        await this.notifyAdapters('approval:sla_breached', instance, p);

        return instance;
      });
    } catch (err) {
      this.logger.error('markSlaBreached: failed', err, { tenantId: this.tenantId, instanceId });
    }
  }

  private async revertDelegation(instanceId: string, levelNumber: number, fromApprover: string): Promise<void> {
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
        this.opts.metricsAdapter?.increment('approval.conflict_retry', { tenantId: this.tenantId, attempt: String(attempt) });
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

  private async requireInstance(id: string): Promise<ApprovalInstance> {
    const instance = await this.opts.adapter.getInstance(this.tenantId, id);
    if (!instance) throw new ApprovalNotFoundError('Instance', id);
    return instance;
  }

  private currentLevelInstance(instance: ApprovalInstance): ApprovalLevelInstance {
    const level = instance.levels.find((l) => l.level === instance.currentLevel);
    if (!level) {
      const available = instance.levels.map((l) => l.level).join(', ');
      throw new ApprovalError(
        `Level ${instance.currentLevel} not found on instance (available: ${available}).`,
        'INVALID_LEVEL',
      );
    }
    return level;
  }

  private findNextLevel(instance: ApprovalInstance): ApprovalLevelInstance | null {
    return instance.levels.find((l) => l.level > instance.currentLevel && l.status === 'waiting') ?? null;
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
      this.logger.error('authorizationPolicy.authorize threw unexpectedly', err, { tenantId: this.tenantId });
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

  private async runMiddlewareAfter(ctx: OperationContext, result?: ApprovalInstance | void): Promise<void> {
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
    const level = instance.levels.find((l) => l.level === instance.currentLevel);
    const notifEvent = {
      type: eventType,
      instanceId: instance.id,
      documentId: instance.documentId,
      documentType: instance.documentType,
      timestamp: this.clock.now(),
      recipients: level?.approverIds ?? [],
      templateName: instance.templateName,
      tenantId: instance.tenantId,
      payload,
    };
    try {
      await this.opts.notificationAdapter.notify(notifEvent);
    } catch (err) {
      this.logger.error('notificationAdapter.notify threw', err, { tenantId: this.tenantId, instanceId: instance.id });
    }
  }

  private async runExternalAudit(instance: ApprovalInstance, entry: AuditEntry): Promise<void> {
    if (!this.opts.auditAdapter) return;
    try {
      await this.opts.auditAdapter.append(this.tenantId, instance.id, entry, instance);
    } catch (err) {
      this.logger.error('auditAdapter.append threw', err, { tenantId: this.tenantId, instanceId: instance.id });
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
    throw new ApprovalValidationError(
      err instanceof Error ? err.message : 'Invalid input',
      err,
    );
  }
}
