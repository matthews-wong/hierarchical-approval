import { describe, it, expect, beforeEach } from 'vitest';
import { newDb } from 'pg-mem';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';

describe('PostgresAdapter integration', () => {
  let adapter: PostgresAdapter;

  beforeEach(async () => {
    // We need to bridge the pg-mem pool to the PostgresAdapter
    const dbInstance = newDb();
    const pool = dbInstance.adapters.createPg().pool;

    adapter = new PostgresAdapter({ connectionString: 'postgres://localhost/test' });

    // Completely bypass the getPool logic
    (adapter as any)._pool = pool;
    (adapter as any).getPool = async () => pool;

    await adapter.migrate();
  });

  it('can store and retrieve an instance', async () => {
    const engine = new ApprovalEngine({
      adapter: adapter as any,
      tenantId: 'test-tenant',
      clock: { now: () => new Date() } as any,
    });

    const instanceId = 'inst-1';
    await engine.submit({
      id: instanceId,
      templateName: 'template-1',
      documentId: 'doc-1',
      documentType: 'doc-type',
      submittedBy: 'user-1',
      data: {},
    });

    const instance = await adapter.getInstance('test-tenant', instanceId);
    expect(instance).not.toBeNull();
    expect(instance?.id).toBe(instanceId);
    expect(instance?.templateName).toBe('template-1');
  });
});
