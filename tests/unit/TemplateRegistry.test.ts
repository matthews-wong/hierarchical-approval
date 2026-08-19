import { describe, it, expect } from 'vitest';
import { TemplateRegistry } from '../../src/engine/TemplateRegistry.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { ApprovalTemplateNotFoundError, ApprovalValidationError } from '../../src/errors.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

const config: ApprovalTemplateConfig = {
  name: 'purchase',
  documentType: 'po',
  levels: [
    { level: 1, name: 'Manager', mode: 'any', approvers: [{ type: 'user', userId: 'bob' }] },
  ],
};

describe('TemplateRegistry', () => {
  it('define creates a v1 template with the tenant id and returns its id', async () => {
    const registry = new TemplateRegistry(new MemoryAdapter(), 't1');
    const id = await registry.define(config);
    expect(id).toBeTruthy();
    const template = await registry.get('purchase');
    expect(template).toMatchObject({
      id,
      tenantId: 't1',
      name: 'purchase',
      version: 1,
    });
    expect(template.createdAt).toBeInstanceOf(Date);
  });

  it('define throws when the template name already exists for the tenant', async () => {
    const registry = new TemplateRegistry(new MemoryAdapter(), 't1');
    await registry.define(config);
    await expect(registry.define(config)).rejects.toThrow(ApprovalValidationError);
    await expect(registry.define(config)).rejects.toThrow(/already exists/);
  });

  it('define allows the same name in a different tenant', async () => {
    const adapter = new MemoryAdapter();
    const registryA = new TemplateRegistry(adapter, 't1');
    const registryB = new TemplateRegistry(adapter, 't2');
    await registryA.define(config);
    await expect(registryB.define(config)).resolves.toBeTruthy();
    await expect(registryB.list()).resolves.toHaveLength(1);
  });

  it('update bumps the version and links the previous version id', async () => {
    const registry = new TemplateRegistry(new MemoryAdapter(), 't1');
    const firstId = await registry.define(config);
    const secondId = await registry.update(config);
    expect(secondId).not.toBe(firstId);
    const updated = await registry.get('purchase');
    expect(updated).toMatchObject({ id: secondId, version: 2, previousVersionId: firstId });
    expect(updated.createdAt).toBeInstanceOf(Date);
  });

  it('update throws ApprovalTemplateNotFoundError for an unknown template', async () => {
    const registry = new TemplateRegistry(new MemoryAdapter(), 't1');
    await expect(registry.update(config)).rejects.toThrow(ApprovalTemplateNotFoundError);
  });

  it('get throws ApprovalTemplateNotFoundError for an unknown template', async () => {
    const registry = new TemplateRegistry(new MemoryAdapter(), 't1');
    await expect(registry.get('missing')).rejects.toThrow(ApprovalTemplateNotFoundError);
  });

  it('list returns only this tenant templates', async () => {
    const adapter = new MemoryAdapter();
    await new TemplateRegistry(adapter, 't1').define(config);
    await new TemplateRegistry(adapter, 't2').define({ ...config, name: 'travel' });
    await expect(new TemplateRegistry(adapter, 't1').list()).resolves.toHaveLength(1);
  });

  it('update defaults version to 2 when existing.version is undefined', async () => {
    const adapter = new MemoryAdapter();
    const registry = new TemplateRegistry(adapter, 't1');
    const firstId = await registry.define(config);
    // Manually corrupt version in storage to undefined
    const existing = await adapter.getTemplate('t1', 'purchase');
    if (existing) {
      delete (existing as any).version;
      await adapter.saveTemplate(existing);
    }
    const secondId = await registry.update(config);
    const updated = await registry.get('purchase');
    expect(updated.version).toBe(2);
    expect(updated.previousVersionId).toBe(firstId);
  });
});
