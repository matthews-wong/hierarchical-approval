import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

const lvl = (n: number, name: string, userId: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
});

describe('template inheritance', () => {
  let engine: ApprovalEngine;

  beforeEach(async () => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PO-base',
      documentType: 'purchase_order',
      levels: [lvl(1, 'Manager', 'mgr'), lvl(2, 'Finance', 'fin')],
      slaDeadlineDays: 5,
      allowOverride: true,
      conditions: [
        {
          when: { field: 'amount', operator: '>', value: 10000 },
          addLevels: [lvl(3, 'CFO', 'cfo')],
        },
      ],
    });
  });

  const levelsOf = async (name: string) => {
    const t = await engine.getTemplate(name);
    return t.levels.map((l) => `${l.level}:${l.name}`);
  };

  it('inherits the whole chain when the child declares no levels', async () => {
    await engine.defineTemplate({
      name: 'PO-EU',
      extends: 'PO-base',
      documentType: 'purchase_order',
      levels: [],
    });
    expect(await levelsOf('PO-EU')).toEqual(['1:Manager', '2:Finance']);
  });

  it('inherits SLA, override flag and conditions', async () => {
    await engine.defineTemplate({
      name: 'PO-EU',
      extends: 'PO-base',
      documentType: 'purchase_order',
      levels: [],
    });
    const t = await engine.getTemplate('PO-EU');
    expect(t.slaDeadlineDays).toBe(5);
    expect(t.allowOverride).toBe(true);
    expect(t.conditions).toHaveLength(1);
  });

  it('overrides a single inherited level field by field', async () => {
    await engine.defineTemplate({
      name: 'PO-EU',
      extends: 'PO-base',
      documentType: 'purchase_order',
      // Swap only the approvers on level 2; name and mode come from the base.
      levels: [{ level: 2, approvers: [{ type: 'user', userId: 'eu-fin' }] } as never],
    });
    const t = await engine.getTemplate('PO-EU');
    const finance = t.levels.find((l) => l.level === 2);
    expect(finance?.name).toBe('Finance');
    expect(finance?.mode).toBe('any');
    expect(finance?.approvers).toEqual([{ type: 'user', userId: 'eu-fin' }]);
  });

  it('appends a child-only level in level order', async () => {
    await engine.defineTemplate({
      name: 'PO-EU',
      extends: 'PO-base',
      documentType: 'purchase_order',
      levels: [lvl(4, 'EU Compliance', 'eu-comp')],
    });
    expect(await levelsOf('PO-EU')).toEqual(['1:Manager', '2:Finance', '4:EU Compliance']);
  });

  it('drops an inherited level with removeLevels', async () => {
    await engine.defineTemplate({
      name: 'PO-Fast',
      extends: 'PO-base',
      documentType: 'purchase_order',
      removeLevels: [2],
      levels: [],
    });
    expect(await levelsOf('PO-Fast')).toEqual(['1:Manager']);
  });

  it('replaces conditions wholesale when the child supplies them', async () => {
    await engine.defineTemplate({
      name: 'PO-EU',
      extends: 'PO-base',
      documentType: 'purchase_order',
      levels: [],
      conditions: [{ when: { field: 'x', operator: '==', value: 1 }, skipLevels: [2] }],
    });
    const t = await engine.getTemplate('PO-EU');
    expect(t.conditions).toHaveLength(1);
    expect(t.conditions?.[0]?.skipLevels).toEqual([2]);
  });

  it('overrides an inherited SLA with the child value', async () => {
    await engine.defineTemplate({
      name: 'PO-EU',
      extends: 'PO-base',
      documentType: 'purchase_order',
      levels: [],
      slaDeadlineDays: 1,
    });
    expect((await engine.getTemplate('PO-EU')).slaDeadlineDays).toBe(1);
  });

  it('stores the flattened result, so editing the base does not reshape the child', async () => {
    await engine.defineTemplate({
      name: 'PO-EU',
      extends: 'PO-base',
      documentType: 'purchase_order',
      levels: [],
    });
    await engine.updateTemplate({
      name: 'PO-base',
      documentType: 'purchase_order',
      levels: [lvl(1, 'Manager', 'mgr'), lvl(2, 'Finance', 'fin'), lvl(9, 'New', 'new')],
    });
    expect(await levelsOf('PO-EU')).toEqual(['1:Manager', '2:Finance']);
    expect(await levelsOf('PO-base')).toEqual(['1:Manager', '2:Finance', '9:New']);
  });

  it('does not persist the extends/removeLevels directives', async () => {
    await engine.defineTemplate({
      name: 'PO-Fast',
      extends: 'PO-base',
      documentType: 'purchase_order',
      removeLevels: [2],
      levels: [],
    });
    const t = await engine.getTemplate('PO-Fast');
    expect(t.extends).toBeUndefined();
    expect(t.removeLevels).toBeUndefined();
  });

  it('resolves a chain, because the base is already flattened', async () => {
    await engine.defineTemplate({
      name: 'PO-EU',
      extends: 'PO-base',
      documentType: 'purchase_order',
      levels: [lvl(4, 'EU Compliance', 'eu-comp')],
    });
    await engine.defineTemplate({
      name: 'PO-EU-DE',
      extends: 'PO-EU',
      documentType: 'purchase_order',
      levels: [lvl(5, 'Betriebsrat', 'br')],
    });
    expect(await levelsOf('PO-EU-DE')).toEqual([
      '1:Manager',
      '2:Finance',
      '4:EU Compliance',
      '5:Betriebsrat',
    ]);
  });

  it('runs an inherited chain end to end', async () => {
    await engine.defineTemplate({
      name: 'PO-Fast',
      extends: 'PO-base',
      documentType: 'purchase_order',
      removeLevels: [2],
      levels: [],
    });
    const i = await engine.submit({
      templateName: 'PO-Fast',
      documentId: 'doc-1',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: { amount: 10 },
    });
    expect(i.levels.map((l) => l.name)).toEqual(['Manager']);
    const done = await engine.approve(i.id, { approverId: 'mgr' });
    expect(done.status).toBe('approved');
  });

  describe('errors', () => {
    it('rejects extending a template that does not exist', async () => {
      await expect(
        engine.defineTemplate({
          name: 'PO-X',
          extends: 'no-such-template',
          documentType: 'purchase_order',
          levels: [],
        }),
      ).rejects.toThrow(/no-such-template/);
    });

    it('rejects a template extending itself', async () => {
      await expect(
        engine.defineTemplate({
          name: 'PO-self',
          extends: 'PO-self',
          documentType: 'purchase_order',
          levels: [],
        }),
      ).rejects.toThrow(/cannot extend itself/);
    });

    it('validates the flattened result, not the fragment', async () => {
      // removeLevels strips everything, so the resolved template has no levels.
      await expect(
        engine.defineTemplate({
          name: 'PO-empty',
          extends: 'PO-base',
          documentType: 'purchase_order',
          removeLevels: [1, 2],
          levels: [],
        }),
      ).rejects.toThrow(/at least one level/);
    });

    it('still requires levels on a template that does not extend', () => {
      const r = engine.validateTemplate({
        name: 'PO-none',
        documentType: 'purchase_order',
        levels: [],
      });
      expect(r.valid).toBe(false);
    });
  });
});
