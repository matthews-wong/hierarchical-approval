import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { CommentedEvent } from '../../src/types/index.js';

describe('comment threads', () => {
  let engine: ApprovalEngine;
  let instanceId: string;

  beforeEach(async () => {
    engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
    });
    const i = await engine.submit({
      templateName: 'PO',
      documentId: 'po-1',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: {},
    });
    instanceId = i.id;
  });

  it('records a comment as an addressable object', async () => {
    await engine.addComment(instanceId, { actorId: 'mgr', comment: 'Need the quote.' });

    const comments = await engine.getComments(instanceId);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ authorId: 'mgr', body: 'Need the quote.', level: 1 });
    expect(comments[0]?.id).toMatch(/^cmt_/);
    expect(comments[0]?.createdAt).toBeInstanceOf(Date);
  });

  it('threads a reply to its parent', async () => {
    await engine.addComment(instanceId, { actorId: 'mgr', comment: 'Need the quote.' });
    const [first] = await engine.getComments(instanceId);

    await engine.addComment(instanceId, {
      actorId: 'buyer',
      comment: 'Attached.',
      parentCommentId: first!.id,
    });

    const comments = await engine.getComments(instanceId);
    expect(comments).toHaveLength(2);
    expect(comments[1]?.parentCommentId).toBe(first!.id);
  });

  it('refuses a reply to a comment that is not there', async () => {
    await expect(
      engine.addComment(instanceId, {
        actorId: 'mgr',
        comment: 'x',
        parentCommentId: 'cmt_nope',
      }),
    ).rejects.toThrow(/nothing to reply to/);
  });

  it('returns comments oldest first', async () => {
    for (const body of ['a', 'b', 'c']) {
      await engine.addComment(instanceId, { actorId: 'mgr', comment: body });
    }
    expect((await engine.getComments(instanceId)).map((c) => c.body)).toEqual(['a', 'b', 'c']);
  });

  it('notifies the people a comment mentions, and nobody else', async () => {
    const events: CommentedEvent[] = [];
    engine.on('approval:commented', (e) => events.push(e));

    await engine.addComment(instanceId, {
      actorId: 'mgr',
      comment: 'Can you confirm, @fin?',
      mentions: ['fin'],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.recipients).toEqual(['fin']);
    expect(events[0]?.authorId).toBe('mgr');
    expect(events[0]?.commentId).toMatch(/^cmt_/);
  });

  it('mentions nobody when none are named, rather than paging the level', async () => {
    const events: CommentedEvent[] = [];
    engine.on('approval:commented', (e) => events.push(e));
    await engine.addComment(instanceId, { actorId: 'mgr', comment: 'noted' });
    expect(events[0]?.recipients).toEqual([]);
  });

  it('still writes the comment to the audit trail', async () => {
    await engine.addComment(instanceId, { actorId: 'mgr', comment: 'Need the quote.' });
    const history = await engine.getHistory(instanceId);
    const entry = history.find((h) => h.action === 'commented');
    expect(entry?.comment).toBe('Need the quote.');
    expect(entry?.newValue?.['commentId']).toMatch(/^cmt_/);
  });

  it('keeps comments through an approval', async () => {
    await engine.addComment(instanceId, { actorId: 'mgr', comment: 'ok' });
    const done = await engine.approve(instanceId, { approverId: 'mgr' });
    expect(done.status).toBe('approved');
    expect(await engine.getComments(instanceId)).toHaveLength(1);
  });

  it('returns an empty list when nothing has been said', async () => {
    expect(await engine.getComments(instanceId)).toEqual([]);
  });
});

describe('date revival across adapters', () => {
  // Regression guard: MemoryAdapter clones through JSON, so every Date field
  // must be revived explicitly. Missing one leaves a value the type calls a
  // Date holding a string — which PostgresAdapter revives correctly, so the
  // two adapters disagree and the bug shows up under only one of them.
  it('revives attachment, comment and hold timestamps as Dates', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PO',
      documentType: 'purchase_order',
      levels: [
        { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
      ],
    });
    const i = await engine.submit({
      templateName: 'PO',
      documentId: 'po-dates',
      documentType: 'purchase_order',
      submittedBy: 'buyer',
      data: {},
    });

    await engine.addAttachment(i.id, { actorId: 'buyer', name: 'q.pdf', uri: 's3://b/q.pdf' });
    await engine.addComment(i.id, { actorId: 'mgr', comment: 'noted' });
    await engine.requestInfo(i.id, { approverId: 'mgr', question: 'which cost centre?' });

    const read = await engine.getInstance(i.id);
    expect(read.attachments?.[0]?.addedAt).toBeInstanceOf(Date);
    expect(read.comments?.[0]?.createdAt).toBeInstanceOf(Date);
    expect(read.infoRequest?.askedAt).toBeInstanceOf(Date);
  });

  it('revives reminderDueAt as a Date', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'REM',
      documentType: 'rem',
      levels: [
        {
          level: 1,
          name: 'Manager',
          approvers: [{ type: 'user', userId: 'mgr' }],
          mode: 'any',
          reminderAfterDays: 2,
        },
      ],
    });
    const i = await engine.submit({
      templateName: 'REM',
      documentId: 'rem-1',
      documentType: 'rem',
      submittedBy: 'buyer',
      data: {},
    });
    const read = await engine.getInstance(i.id);
    expect(read.levels[0]?.reminderDueAt).toBeInstanceOf(Date);
  });
});
