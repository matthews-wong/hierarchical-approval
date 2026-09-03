import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { FakePool } from '../unit/adapters/_fakePg.js';
import type { AttachmentEvent } from '../../src/types/index.js';

describe('attachments', () => {
  let engine: ApprovalEngine;

  beforeEach(async () => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
    });
  });

  const submit = async () =>
    engine.submit({
      templateName: 'PO',
      documentId: `doc-${Math.random()}`,
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: {},
    });

  const quote = { actorId: 'buyer', name: 'quote.pdf', uri: 's3://bucket/quote.pdf' };

  it('attaches a reference with metadata', async () => {
    const i = await submit();
    const after = await engine.addAttachment(i.id, {
      ...quote,
      contentType: 'application/pdf',
      sizeBytes: 1024,
    });

    expect(after.attachments).toHaveLength(1);
    const a = after.attachments?.[0];
    expect(a?.name).toBe('quote.pdf');
    expect(a?.uri).toBe('s3://bucket/quote.pdf');
    expect(a?.contentType).toBe('application/pdf');
    expect(a?.sizeBytes).toBe(1024);
    expect(a?.addedBy).toBe('buyer');
    expect(a?.addedAt).toBeInstanceOf(Date);
    expect(a?.level).toBe(1);
    expect(a?.id).toMatch(/^att_/);
  });

  it('accumulates several attachments', async () => {
    const i = await submit();
    await engine.addAttachment(i.id, quote);
    const after = await engine.addAttachment(i.id, {
      actorId: 'mgr',
      name: 'approval-note.txt',
      uri: 'dms://note/1',
    });
    expect(after.attachments?.map((a) => a.name)).toEqual(['quote.pdf', 'approval-note.txt']);
  });

  it('removes by id and leaves the rest', async () => {
    const i = await submit();
    const withOne = await engine.addAttachment(i.id, quote);
    const withTwo = await engine.addAttachment(i.id, {
      actorId: 'mgr',
      name: 'b.txt',
      uri: 'dms://b',
    });
    const id = withOne.attachments?.[0]?.id as string;
    expect(withTwo.attachments).toHaveLength(2);

    const after = await engine.removeAttachment(i.id, { actorId: 'buyer', attachmentId: id });
    expect(after.attachments?.map((a) => a.name)).toEqual(['b.txt']);
  });

  it('emits events for add and remove', async () => {
    const added: AttachmentEvent[] = [];
    const removed: AttachmentEvent[] = [];
    engine.on('approval:attachment_added', (e) => added.push(e));
    engine.on('approval:attachment_removed', (e) => removed.push(e));

    const i = await submit();
    const withOne = await engine.addAttachment(i.id, quote);
    await engine.removeAttachment(i.id, {
      actorId: 'buyer',
      attachmentId: withOne.attachments?.[0]?.id as string,
    });

    expect(added[0]?.name).toBe('quote.pdf');
    expect(added[0]?.uri).toBe('s3://bucket/quote.pdf');
    expect(removed[0]?.name).toBe('quote.pdf');
  });

  it('keeps what was removed in the audit trail', async () => {
    const i = await submit();
    const withOne = await engine.addAttachment(i.id, quote);
    await engine.removeAttachment(i.id, {
      actorId: 'buyer',
      attachmentId: withOne.attachments?.[0]?.id as string,
      reason: 'superseded',
    });

    const history = await engine.getHistory(i.id);
    const add = history.find((h) => h.action === 'attachment_added');
    const rm = history.find((h) => h.action === 'attachment_removed');
    expect(add?.newValue?.['name']).toBe('quote.pdf');
    // The trail must still show an approver saw evidence no longer listed.
    expect(rm?.oldValue?.['name']).toBe('quote.pdf');
    expect(rm?.oldValue?.['uri']).toBe('s3://bucket/quote.pdf');
    expect(rm?.reason).toBe('superseded');
  });

  it('survives an approval, staying on the completed instance', async () => {
    const i = await submit();
    await engine.addAttachment(i.id, quote);
    const done = await engine.approve(i.id, { approverId: 'mgr' });
    expect(done.status).toBe('approved');
    expect(done.attachments).toHaveLength(1);
  });

  describe('guards', () => {
    it('refuses to attach to a terminal instance', async () => {
      const i = await submit();
      await engine.cancel(i.id, { cancelledBy: 'buyer', reason: 'x' });
      await expect(engine.addAttachment(i.id, quote)).rejects.toThrow(
        /Cannot attach to a "cancelled"/,
      );
    });

    it('refuses to remove an attachment that is not there', async () => {
      const i = await submit();
      await expect(
        engine.removeAttachment(i.id, { actorId: 'buyer', attachmentId: 'att_nope' }),
      ).rejects.toThrow(/is not on this approval/);
    });

    it('is subject to the authorization policy', async () => {
      const denying = new ApprovalEngine({
        adapter: new MemoryAdapter(),
        authorizationPolicy: {
          authorize: (ctx) => (ctx.operation === 'addAttachment' ? 'denied' : undefined),
        },
      });
      await denying.defineTemplate({
        name: 'PO',
        documentType: 'purchase_order',
        levels: [
          { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
        ],
      });
      const i = await denying.submit({
        templateName: 'PO',
        documentId: 'd',
        documentType: 'purchase_order',
        submittedBy: 'buyer',
        data: {},
      });
      await expect(denying.addAttachment(i.id, quote)).rejects.toThrow(/denied/);
    });
  });

  describe('PostgresAdapter persistence', () => {
    const fresh = () => {
      const pool = new FakePool();
      return { pool, adapter: new PostgresAdapter({ pool: pool.asPool() }) };
    };

    it('writes attachments on insert and update, and migrates the column', async () => {
      const { pool, adapter } = fresh();
      await adapter.migrate();
      const migration = pool.queries.map((q) => q.sql).join('\n');
      expect(migration).toContain('ADD COLUMN IF NOT EXISTS attachments');

      pool.queueResult({ rows: [{ id: 'inst-1' }], rowCount: 1 });
      await adapter.updateInstance(
        {
          id: 'inst-1',
          tenantId: 't1',
          templateId: 'tpl',
          templateName: 'PO',
          documentId: 'd',
          documentType: 'purchase_order',
          submittedBy: 'buyer',
          status: 'pending',
          currentLevel: 1,
          version: 1,
          levels: [],
          auditLog: [],
          data: {},
          metadata: {},
          createdAt: new Date(),
          updatedAt: new Date(),
          attachments: [
            {
              id: 'att_1',
              name: 'quote.pdf',
              uri: 's3://b/quote.pdf',
              addedBy: 'buyer',
              addedAt: new Date('2026-01-01T00:00:00Z'),
            },
          ],
        },
        1,
      );

      const update = [...pool.queries].reverse().find((q) => q.sql.includes('UPDATE'));
      expect(update?.sql).toMatch(/attachments\s+=\s+\$/);
      expect(update?.params.some((p) => String(p).includes('quote.pdf'))).toBe(true);
    });
  });
});
