import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine, TEMPLATE_BUNDLE_VERSION } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { TemplateBundle } from '../../src/engine/ApprovalEngine.js';

const u = (n: number, name: string, userId: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
});

const newEngine = () => new ApprovalEngine({ adapter: new MemoryAdapter() });

describe('template bundles', () => {
  let source: ApprovalEngine;

  beforeEach(async () => {
    source = newEngine();
    await source.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [u(1, 'Manager', 'mgr'), u(2, 'Finance', 'fin')],
      slaDeadlineDays: 5,
      conditions: [
        { when: { field: 'amount', operator: '>', value: 10000 }, addLevels: [u(3, 'CFO', 'cfo')] },
      ],
    });
    await source.defineTemplate({
      name: 'INV',
      documentType: 'invoice',
      levels: [u(1, 'AP', 'ap')],
    });
  });

  describe('export', () => {
    it('exports every template with a version stamp', async () => {
      const bundle = await source.exportTemplates();
      expect(bundle.bundleVersion).toBe(TEMPLATE_BUNDLE_VERSION);
      expect(bundle.exportedAt).toBeInstanceOf(Date);
      expect(bundle.templates.map((t) => t.name).sort()).toEqual(['INV', 'PO']);
    });

    it('strips everything environment-specific', async () => {
      const bundle = await source.exportTemplates(['PO']);
      const po = bundle.templates[0] as Record<string, unknown>;
      for (const key of ['id', 'tenantId', 'createdAt', 'version', 'previousVersionId']) {
        expect(po).not.toHaveProperty(key);
      }
      // The parts that describe the workflow itself survive.
      expect(po['documentType']).toBe('purchase_order');
      expect(po['slaDeadlineDays']).toBe(5);
      expect((po['levels'] as unknown[]).length).toBe(2);
      expect((po['conditions'] as unknown[]).length).toBe(1);
    });

    it('exports a named subset', async () => {
      const bundle = await source.exportTemplates(['INV']);
      expect(bundle.templates.map((t) => t.name)).toEqual(['INV']);
    });

    it('fails loudly on a name that does not exist', async () => {
      await expect(source.exportTemplates(['PO', 'nope'])).rejects.toThrow(/nope/);
    });
  });

  describe('import', () => {
    it('recreates the templates in a fresh environment', async () => {
      const bundle = await source.exportTemplates();
      const target = newEngine();

      const result = await target.importTemplates(bundle);
      expect(result.created.sort()).toEqual(['INV', 'PO']);
      expect(result.errors).toEqual([]);

      const po = await target.getTemplate('PO');
      expect(po.levels.map((l) => l.name)).toEqual(['Manager', 'Finance']);
      expect(po.slaDeadlineDays).toBe(5);
      // The target assigns its own identity.
      expect(po.tenantId).toBe('default');
      expect(po.version).toBe(1);
      expect(po.id).toMatch(/^tpl_/);
    });

    it('the imported template actually runs', async () => {
      const target = newEngine();
      await target.importTemplates(await source.exportTemplates(['PO']));

      const i = await target.submit({
        templateName: 'PO',
        documentId: 'po-1',
        documentType: 'purchase_order',
        submittedBy: 'buyer',
        data: { amount: 20000 },
      });
      // The exported condition came across intact.
      expect(i.levels.map((l) => l.name)).toEqual(['Manager', 'Finance', 'CFO']);
    });

    it('skips existing templates in create mode', async () => {
      const bundle = await source.exportTemplates();
      const result = await source.importTemplates(bundle);
      expect(result.skipped.sort()).toEqual(['INV', 'PO']);
      expect(result.created).toEqual([]);
    });

    it('updates existing templates in upsert mode, bumping the version', async () => {
      const bundle = await source.exportTemplates(['PO']);
      const before = await source.getTemplate('PO');

      const result = await source.importTemplates(bundle, { mode: 'upsert' });
      expect(result.updated).toEqual(['PO']);

      const after = await source.getTemplate('PO');
      expect(after.version).toBe(before.version + 1);
      expect(after.previousVersionId).toBe(before.id);
    });

    it('dryRun reports without writing', async () => {
      const bundle = await source.exportTemplates();
      const target = newEngine();

      const result = await target.importTemplates(bundle, { dryRun: true });
      expect(result.dryRun).toBe(true);
      expect(result.created.sort()).toEqual(['INV', 'PO']);
      await expect(target.getTemplate('PO')).rejects.toThrow();
    });

    it('rejects an unsupported bundle version', async () => {
      const bundle = { ...(await source.exportTemplates()), bundleVersion: 99 };
      await expect(newEngine().importTemplates(bundle)).rejects.toThrow(
        /Unsupported template bundle version 99/,
      );
    });

    it('rejects an empty bundle', async () => {
      const bundle: TemplateBundle = {
        bundleVersion: TEMPLATE_BUNDLE_VERSION,
        exportedAt: new Date(),
        templates: [],
      };
      await expect(newEngine().importTemplates(bundle)).rejects.toThrow(/no templates/);
    });

    it('rejects duplicate names within one bundle', async () => {
      const bundle = await source.exportTemplates(['PO']);
      bundle.templates.push({ ...bundle.templates[0]! });
      await expect(newEngine().importTemplates(bundle)).rejects.toThrow(/duplicate names: PO/);
    });

    it('validates every template before writing any', async () => {
      const bundle = await source.exportTemplates();
      // Break the second one only.
      bundle.templates[1]!.levels = [];

      const target = newEngine();
      await expect(target.importTemplates(bundle)).rejects.toThrow(
        /failed validation and was not applied/,
      );

      // A half-applied bundle is worse than one rejected outright: nothing landed.
      await expect(target.getTemplate('PO')).rejects.toThrow();
      await expect(target.getTemplate('INV')).rejects.toThrow();
    });

    it('names the offending template in the validation error', async () => {
      const bundle = await source.exportTemplates(['INV']);
      bundle.templates[0]!.levels = [];
      await expect(newEngine().importTemplates(bundle)).rejects.toThrow(/INV:/);
    });

    it('round-trips a bundle through JSON', async () => {
      const bundle = await source.exportTemplates();
      const wire = JSON.parse(JSON.stringify(bundle)) as TemplateBundle;

      const target = newEngine();
      const result = await target.importTemplates(wire);
      expect(result.created.sort()).toEqual(['INV', 'PO']);
      expect((await target.getTemplate('PO')).levels).toHaveLength(2);
    });
  });
});
