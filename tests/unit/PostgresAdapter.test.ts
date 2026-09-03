/**
 * Unit tests for PostgresAdapter with an injected fake pool (no database
 * required): constructor tablePrefix validation, template result mapping,
 * and the optimistic-locking update path.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { ApprovalConflictError } from '../../src/errors.js';
import type { ApprovalInstance, ApprovalTemplate } from '../../src/types/index.js';

function makePool() {
  const query = vi.fn();
  const pool = { query } as unknown as Pool;
  return { pool, query };
}

function makeAdapter(pool: Pool, overrides: Record<string, unknown> = {}) {
  return new PostgresAdapter({ pool, ...overrides });
}

function makeTemplate(): ApprovalTemplate {
  return {
    id: 'tmpl-1',
    tenantId: 't',
    name: 'Simple',
    documentType: 'doc',
    levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'bob' }], mode: 'any' }],
    createdAt: new Date('2026-08-12T12:00:00.000Z'),
    version: 1,
  };
}

function makeInstance(overrides: Partial<ApprovalInstance> = {}): ApprovalInstance {
  return {
    id: 'inst-1',
    tenantId: 't',
    templateId: 'tmpl-1',
    templateName: 'Simple',
    documentId: 'D-1',
    documentType: 'doc',
    submittedBy: 'alice',
    status: 'pending',
    currentLevel: 1,
    version: 2,
    levels: [
      {
        level: 1,
        name: 'L1',
        mode: 'any',
        approverConfigs: [{ type: 'user', userId: 'bob' }],
        approverIds: ['bob'],
        approvedBy: [],
        rejectedBy: [],
        status: 'pending',
      },
    ],
    auditLog: [],
    data: {},
    metadata: {},
    createdAt: new Date('2026-08-12T12:00:00.000Z'),
    updatedAt: new Date('2026-08-12T12:00:00.000Z'),
    ...overrides,
  };
}

describe('PostgresAdapter — constructor', () => {
  it('rejects an invalid tablePrefix', () => {
    const { pool } = makePool();
    expect(() => makeAdapter(pool, { tablePrefix: '1bad' })).toThrow(/tablePrefix/);
    expect(() => makeAdapter(pool, { tablePrefix: 'has-dash' })).toThrow(/tablePrefix/);
    expect(() => makeAdapter(pool, { tablePrefix: 'Upper' })).toThrow(/tablePrefix/);
  });

  it('accepts a valid custom tablePrefix and uses it in queries', async () => {
    const { pool, query } = makePool();
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const adapter = makeAdapter(pool, { tablePrefix: 'ha_approval', schema: 'app' });

    await adapter.getTemplate('t', 'Simple');

    expect(query).toHaveBeenCalledWith(expect.stringContaining('app.ha_approval_templates'), [
      't',
      'Simple',
    ]);
  });
});

describe('PostgresAdapter — templates', () => {
  it('getTemplate returns the stored template data', async () => {
    const { pool, query } = makePool();
    const template = makeTemplate();
    query.mockResolvedValue({ rows: [{ data: template }], rowCount: 1 });

    const adapter = makeAdapter(pool);
    await expect(adapter.getTemplate('t', 'Simple')).resolves.toEqual(template);
  });

  it('getTemplate returns null when no row matches', async () => {
    const { pool, query } = makePool();
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    const adapter = makeAdapter(pool);
    await expect(adapter.getTemplate('t', 'Missing')).resolves.toBeNull();
  });
});

describe('PostgresAdapter — optimistic locking', () => {
  it('updateInstance resolves when the versioned UPDATE matches a row', async () => {
    const { pool, query } = makePool();
    query.mockResolvedValue({ rows: [{ id: 'inst-1' }], rowCount: 1 });

    const adapter = makeAdapter(pool);
    const instance = makeInstance({
      id: 'inst-1',
      status: 'approved',
      currentLevel: 1,
      version: 2,
      levels: [],
    });

    await expect(adapter.updateInstance(instance, 2)).resolves.toBeUndefined();

    // The parameter list carries every mutable column, not just the handful
    // updateInstance used to write — see PostgresAdapter.persistence.test.ts.
    expect(query).toHaveBeenCalledWith(expect.any(String), [
      't',
      'inst-1',
      2,
      'approved',
      1,
      2,
      '[]',
      null,
      instance.updatedAt.toISOString(),
      JSON.stringify(instance.data ?? {}),
      JSON.stringify(instance.metadata ?? {}),
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  it('updateInstance throws ApprovalConflictError when the UPDATE matches no row', async () => {
    const { pool, query } = makePool();
    query.mockResolvedValue({ rows: [], rowCount: 0 });

    const adapter = makeAdapter(pool);
    const instance = makeInstance({
      id: 'inst-9',
      status: 'approved',
      currentLevel: 1,
      version: 2,
      levels: [],
    });

    await expect(adapter.updateInstance(instance, 1)).rejects.toThrow(
      /Concurrent modification detected on instance "inst-9"/,
    );
    await expect(adapter.updateInstance(instance, 1)).rejects.toBeInstanceOf(ApprovalConflictError);
  });
});
