import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

const level = (n: number, name: string, userId: string) => ({
  level: n,
  name,
  approvers: [{ type: 'user' as const, userId }],
  mode: 'any' as const,
});

describe('boolean condition expressions through the engine', () => {
  let engine: ApprovalEngine;

  beforeEach(() => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
  });

  const base = (config: Partial<ApprovalTemplateConfig> = {}): ApprovalTemplateConfig => ({
    name: 'PO',
    documentType: 'purchase_order',
    levels: [level(1, 'Manager', 'mgr'), level(2, 'Finance', 'fin')],
    ...config,
  });

  const submitWith = async (data: Record<string, unknown>) => {
    const instance = await engine.submit({
      templateName: 'PO',
      documentId: `doc-${JSON.stringify(data)}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data,
    });
    return instance.levels.map((l) => l.name);
  };

  it('an `any` rule escalates on either trigger', async () => {
    await engine.defineTemplate(
      base({
        conditions: [
          {
            when: {
              any: [
                { field: 'amount', operator: '>', value: 10000 },
                { field: 'risk', operator: '==', value: 'high' },
              ],
            },
            addLevels: [level(3, 'CFO', 'cfo')],
          },
        ],
      }),
    );

    expect(await submitWith({ amount: 20000, risk: 'low' })).toEqual(['Manager', 'Finance', 'CFO']);
    expect(await submitWith({ amount: 5, risk: 'high' })).toEqual(['Manager', 'Finance', 'CFO']);
    expect(await submitWith({ amount: 5, risk: 'low' })).toEqual(['Manager', 'Finance']);
  });

  it('a `not` rule skips a level for everything except one case', async () => {
    await engine.defineTemplate(
      base({
        conditions: [
          {
            when: { not: { field: 'region', operator: '==', value: 'US' } },
            skipLevels: [2],
          },
        ],
      }),
    );

    expect(await submitWith({ region: 'US' })).toEqual(['Manager', 'Finance']);
    expect(await submitWith({ region: 'EU' })).toEqual(['Manager']);
  });

  it('a nested (A and B) or C rule resolves correctly end to end', async () => {
    await engine.defineTemplate(
      base({
        conditions: [
          {
            when: {
              any: [
                {
                  all: [
                    { field: 'amount', operator: '>', value: 1000 },
                    { field: 'dept', operator: '==', value: 'eng' },
                  ],
                },
                { field: 'override', operator: '==', value: true },
              ],
            },
            addLevels: [level(3, 'CFO', 'cfo')],
          },
        ],
      }),
    );

    expect(await submitWith({ amount: 2000, dept: 'eng' })).toContain('CFO');
    expect(await submitWith({ amount: 1, dept: 'ops', override: true })).toContain('CFO');
    expect(await submitWith({ amount: 1, dept: 'ops' })).not.toContain('CFO');
  });

  it('validateTemplate reports a malformed group instead of failing at submit', () => {
    const result = engine.validateTemplate(
      base({ conditions: [{ when: { all: [] }, skipLevels: [2] }] }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain('conditions[0].when');
  });

  it('defineTemplate rejects a malformed group', async () => {
    await expect(
      engine.defineTemplate(base({ conditions: [{ when: { any: [] }, skipLevels: [2] }] })),
    ).rejects.toThrow(/must not be empty/);
  });

  it('defineTemplate reports a leaf missing its operator, with a nested path', () => {
    const conditions = [
      { when: { any: [{ field: 'amount' }] }, skipLevels: [2] },
    ] as unknown as ApprovalTemplateConfig['conditions'];
    const result = engine.validateTemplate(base({ conditions }));
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.field)).toContain('conditions[0].when.any[0].operator');
  });

  it('the numeric strictness from 0.7.0 still applies inside groups', async () => {
    await engine.defineTemplate(
      base({
        conditions: [
          {
            when: { any: [{ field: 'amount', operator: '<', value: 5000 }] },
            skipLevels: [2],
          },
        ],
      }),
    );
    expect(await submitWith({ amount: 4999 })).toEqual(['Manager']);
    expect(await submitWith({ amount: null })).toEqual(['Manager', 'Finance']);
  });
});
