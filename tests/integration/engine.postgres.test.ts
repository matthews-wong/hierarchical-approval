import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newDb, IMemoryDb } from 'pg-mem';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

const sampleTemplate: ApprovalTemplateConfig = {
  name: 'Purchase Order',
  documentType: 'purchase_order',
  levels: [
    {
      level: 1,
      name: 'Manager Approval',
      approvers: [{ type: 'user', userId: 'mgr-1' }],
      mode: 'any',
    },
    {
      level: 2,
      name: 'Finance Approval',
      approvers: [{ type: 'user', userId: 'fin-1' }],
      mode: 'any',
    },
  ],
};

describe('PostgresAdapter integration (pg-mem)', () => {
  let db: IMemoryDb;
  let adapter: PostgresAdapter;

  beforeEach(async () => {
    db = newDb();
    const { Pool } = db.adapters.createPg();
    adapter = new PostgresAdapter({ pool: new Pool() });
    await adapter.migrate();
  });

  afterEach(async () => {
    await adapter.close().catch(() => {});
  });

  describe('Template operations & Engine setup', () => {
    it('should define and retrieve templates using PostgresAdapter', async () => {
      const engine = new ApprovalEngine({
        adapter,
        tenantId: 'tenant-pg-1',
        escalationPollIntervalMs: 0,
      });

      await engine.defineTemplate(sampleTemplate);
      const retrieved = await adapter.getTemplate('tenant-pg-1', sampleTemplate.name);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.name).toBe(sampleTemplate.name);
      expect(retrieved?.documentType).toBe(sampleTemplate.documentType);
    });

    it('should submit instance and store it in Postgres', async () => {
      const engine = new ApprovalEngine({
        adapter,
        tenantId: 'tenant-pg-1',
        escalationPollIntervalMs: 0,
      });

      await engine.defineTemplate(sampleTemplate);
      const instance = await engine.submit({
        templateName: sampleTemplate.name,
        documentId: 'doc-101',
        documentType: 'purchase_order',
        submittedBy: 'alice',
        data: { amount: 500 },
      });

      expect(instance.id).toBeDefined();
      expect(instance.status).toBe('pending');

      const fetched = await adapter.getInstance('tenant-pg-1', instance.id);
      expect(fetched).not.toBeNull();
      expect(fetched?.id).toBe(instance.id);
      expect(fetched?.submittedBy).toBe('alice');
      expect(fetched?.data).toEqual({ amount: 500 });
    });
  });
});
