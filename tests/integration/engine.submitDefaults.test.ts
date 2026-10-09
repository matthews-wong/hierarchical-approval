import { describe, it, expect } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

describe('submit defaults', () => {
  const setup = async (): Promise<ApprovalEngine> => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
    });
    return engine;
  };

  it('defaults data and metadata to empty objects when omitted', async () => {
    const engine = await setup();
    const instance = await engine.submit({
      templateName: 'PO',
      documentId: 'po-1',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
    });
    expect(instance.data).toEqual({});
    expect(instance.metadata).toEqual({});
  });

  it('coerces an ISO string expiresAt to a Date', async () => {
    const engine = await setup();
    const instance = await engine.submit({
      templateName: 'PO',
      documentId: 'po-2',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(instance.expiresAt).toEqual(new Date('2030-01-01T00:00:00.000Z'));
  });
});
