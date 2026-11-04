import { describe, it, expect } from 'vitest';
import { ApprovalTestKit } from '../../../src/testing/ApprovalTestKit.js';
import { MemoryAdapter } from '../../../src/adapters/MemoryAdapter.js';
import { ApprovalValidationError } from '../../../src/errors.js';

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

describe('ApprovalTestKit.fullyApprove', () => {
  it('rejects with an ApprovalValidationError naming the level that has no approver', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate({
      name: 'T',
      documentType: 'doc',
      levels: [
        { level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' },
        { level: 2, name: 'L2', approvers: [{ type: 'user', userId: 'u2' }], mode: 'any' },
      ],
    });
    const instance = await engine.submit({ templateName: 'T', documentId: 'D1', documentType: 'doc', submittedBy: 'sub', data: {} });

    const failure = ApprovalTestKit.fullyApprove(engine, instance.id, { 1: 'u1' });

    await expect(failure).rejects.toBeInstanceOf(ApprovalValidationError);
    await expect(failure).rejects.toThrow('No approver provided for level 2');
    await engine.shutdown();
  });

  it('rejects before approving anything when level 1 has no approver', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate({
      name: 'T',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
    });
    const instance = await engine.submit({ templateName: 'T', documentId: 'D1', documentType: 'doc', submittedBy: 'sub', data: {} });

    await expect(ApprovalTestKit.fullyApprove(engine, instance.id, {})).rejects.toThrow(
      'No approver provided for level 1',
    );

    const after = await engine.getInstance(instance.id);
    expect(after.status).toBe('pending');
    await engine.shutdown();
  });

  it('treats an empty-string approver id as missing', async () => {
    const { engine } = ApprovalTestKit.create();
    await engine.defineTemplate({
      name: 'T',
      documentType: 'doc',
      levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
    });
    const instance = await engine.submit({ templateName: 'T', documentId: 'D1', documentType: 'doc', submittedBy: 'sub', data: {} });

    await expect(ApprovalTestKit.fullyApprove(engine, instance.id, { 1: '' })).rejects.toBeInstanceOf(
      ApprovalValidationError,
    );
    await engine.shutdown();
  });
});
