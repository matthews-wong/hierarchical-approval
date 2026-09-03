import { describe, it, expect } from 'vitest';
import { ApprovalTestKit } from '../../../src/testing/ApprovalTestKit.js';
import { MemoryAdapter } from '../../../src/adapters/MemoryAdapter.js';

describe('ApprovalTestKit.create', () => {
  it('reuses a caller-supplied MemoryAdapter instead of creating a new one', async () => {
    const suppliedAdapter = new MemoryAdapter();
    const { engine, adapter } = ApprovalTestKit.create({
      adapter: suppliedAdapter,
      tenantId: 't1',
    });

    expect(adapter).toBe(suppliedAdapter);

    await engine.defineTemplate({
      name: 'T',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
    });
    const instance = await engine.submit({ templateName: 'T', documentId: 'D1', documentType: 'doc', submittedBy: 'sub', data: {} });

    const stored = await suppliedAdapter.getInstance('t1', instance.id);
    expect(stored).not.toBeNull();
    await engine.shutdown();
  });
});
