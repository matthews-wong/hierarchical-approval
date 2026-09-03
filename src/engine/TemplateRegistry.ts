import type { IStorageAdapter } from '../adapters/IStorageAdapter.js';
import type {
  ApprovalTemplateConfig,
  ApprovalTemplate,
  ApprovalLevelConfig,
} from '../types/index.js';
import { ApprovalTemplateNotFoundError, ApprovalValidationError } from '../errors.js';
import type { Clock } from '../utils/Clock.js';
import { systemClock } from '../utils/Clock.js';
import type { IdGeneratorFn } from '../utils/IdGenerator.js';
import { defaultIdGenerator } from '../utils/IdGenerator.js';

export class TemplateRegistry {
  private readonly clock: Clock;
  private readonly generateId: IdGeneratorFn;

  constructor(
    private readonly adapter: IStorageAdapter,
    private readonly tenantId: string,
    opts?: { clock?: Clock; generateId?: IdGeneratorFn },
  ) {
    this.clock = opts?.clock ?? systemClock;
    this.generateId = opts?.generateId ?? defaultIdGenerator;
  }

  /**
   * Flatten a template that declares `extends` against its base.
   *
   * Resolution is done once, at define time, and the flattened result is what
   * gets stored. Resolving lazily on read would mean editing a base silently
   * reshapes every derived template — and every in-flight instance running
   * against one — which is exactly the surprise `templateSnapshot` exists to
   * prevent elsewhere in the engine.
   *
   * Merge rules:
   * - **Levels** are keyed by level number. A child level with the same number
   *   overrides the base level field by field, so a derived template can change
   *   just the approvers and inherit the rest. Child-only levels are appended,
   *   and `removeLevels` drops inherited ones.
   * - **conditions** are replaced wholesale when the child supplies them.
   *   Concatenating two rule lists would produce a chain neither author
   *   intended, and there is no meaningful way to "merge" boolean rules.
   * - **escalation**, **slaDeadlineDays** and **allowOverride** are taken from
   *   the child when set, otherwise inherited.
   *
   * A base that itself extends something is already flattened in storage, so
   * chains resolve naturally and cycles cannot form: the base must exist before
   * the child can name it.
   *
   * @param config - The raw config as supplied by the caller.
   * @returns The config with inheritance applied, or unchanged if no `extends`.
   */
  async resolveInheritance(config: ApprovalTemplateConfig): Promise<ApprovalTemplateConfig> {
    if (!config.extends) return config;

    if (config.extends === config.name) {
      throw new ApprovalValidationError(`Template "${config.name}" cannot extend itself.`);
    }

    const base = await this.adapter.getTemplate(this.tenantId, config.extends);
    if (!base) {
      throw new ApprovalTemplateNotFoundError(
        `${config.extends} (referenced by "${config.name}" via extends)`,
      );
    }

    const removed = new Set(config.removeLevels ?? []);
    const byLevel = new Map<number, ApprovalLevelConfig>();
    for (const lvl of base.levels) {
      if (!removed.has(lvl.level)) byLevel.set(lvl.level, lvl);
    }
    for (const lvl of config.levels ?? []) {
      const inherited = byLevel.get(lvl.level);
      byLevel.set(lvl.level, inherited ? { ...inherited, ...lvl } : lvl);
    }

    const levels = [...byLevel.values()].sort((a, b) => a.level - b.level);

    const resolved: ApprovalTemplateConfig = {
      ...config,
      levels,
      conditions: config.conditions ?? base.conditions,
      escalation: config.escalation ?? base.escalation,
      slaDeadlineDays: config.slaDeadlineDays ?? base.slaDeadlineDays,
      allowOverride: config.allowOverride ?? base.allowOverride,
    };
    // `extends`/`removeLevels` are directives for this call, not state to persist:
    // the stored template is already flattened.
    delete resolved.extends;
    delete resolved.removeLevels;
    return resolved;
  }

  async define(config: ApprovalTemplateConfig): Promise<string> {
    const existing = await this.adapter.getTemplate(this.tenantId, config.name);
    if (existing) {
      throw new ApprovalValidationError(
        `Template "${config.name}" already exists for this tenant. Delete it first or use engine.updateTemplate() to modify it.`,
      );
    }
    const id = this.generateId('tpl');
    const template: ApprovalTemplate = {
      ...config,
      id,
      tenantId: this.tenantId,
      createdAt: this.clock.now(),
      version: 1,
    };
    await this.adapter.saveTemplate(template);
    return id;
  }

  /** Update an existing template, incrementing its version. Throws if the template doesn't exist. */
  async update(config: ApprovalTemplateConfig): Promise<string> {
    const existing = await this.adapter.getTemplate(this.tenantId, config.name);
    if (!existing) {
      throw new ApprovalTemplateNotFoundError(config.name);
    }
    const newId = this.generateId('tpl');
    const updated: ApprovalTemplate = {
      ...config,
      id: newId,
      tenantId: this.tenantId,
      createdAt: existing.createdAt,
      version: (existing.version ?? 1) + 1,
      previousVersionId: existing.id,
    };
    await this.adapter.saveTemplate(updated);
    return newId;
  }

  async get(name: string): Promise<ApprovalTemplate> {
    const template = await this.adapter.getTemplate(this.tenantId, name);
    if (!template) throw new ApprovalTemplateNotFoundError(name);
    return template;
  }

  async list(): Promise<ApprovalTemplate[]> {
    return this.adapter.listTemplates(this.tenantId);
  }
}
