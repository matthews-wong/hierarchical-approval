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

  it('coerces epoch-millisecond expiresAt to a Date', async () => {
    const engine = await setup();
    const epoch = Date.UTC(2030, 0, 1);
    const instance = await engine.submit({
      templateName: 'PO',
      documentId: 'po-3',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      expiresAt: epoch,
    });
    expect(instance.expiresAt).toEqual(new Date(epoch));
  });

  it('keeps a Date expiresAt as the same instant', async () => {
    const engine = await setup();
    const when = new Date('2031-06-15T12:00:00.000Z');
    const instance = await engine.submit({
      templateName: 'PO',
      documentId: 'po-4',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      expiresAt: when,
    });
    expect(instance.expiresAt?.getTime()).toBe(when.getTime());
  });

  it('keeps explicit data and metadata instead of defaulting them', async () => {
    const engine = await setup();
    const instance = await engine.submit({
      templateName: 'PO',
      documentId: 'po-5',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: { amount: 250 },
      metadata: { region: 'emea' },
    });
    expect(instance.data).toEqual({ amount: 250 });
    expect(instance.metadata).toEqual({ region: 'emea' });
  });

  it('rejects an expiresAt string that is not a date', async () => {
    const engine = await setup();
    await expect(
      engine.submit({
        templateName: 'PO',
        documentId: 'po-6',
        documentType: 'purchase_order',
        submittedBy: 'buyer',
        expiresAt: 'not-a-date',
      }),
    ).rejects.toThrow();
  });
});
