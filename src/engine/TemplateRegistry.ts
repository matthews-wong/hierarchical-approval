import type { IStorageAdapter } from '../adapters/IStorageAdapter.js';
import type { ApprovalTemplateConfig, ApprovalTemplate } from '../types/index.js';
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
