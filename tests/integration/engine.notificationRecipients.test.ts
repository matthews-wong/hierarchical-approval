import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { ApprovalTestKit } from '../../src/testing/ApprovalTestKit.js';
import type { NotificationEvent } from '../../src/adapters/INotificationAdapter.js';

/**
 * NotificationEvent.recipients is what an adapter actually delivers to. It was
 * read from the single level matching instance.currentLevel, which both missed
 * every other open branch of a parallel group and overwrote the audience an
 * event had already named for itself.
 */
describe('notification recipients', () => {
  let seen: Array<{ type: string; recipients: string[] }>;
  let engine: ApprovalEngine;

  const notifying = () =>
    new ApprovalEngine({
      adapter: new MemoryAdapter(),
      notificationAdapter: {
        notify: async (e: NotificationEvent) => {
          seen.push({ type: e.type, recipients: e.recipients });
        },
      },
    });

  const recipientsFor = (type: string) => seen.find((s) => s.type === type)?.recipients;

  beforeEach(() => {
    seen = [];
    engine = notifying();
  });

  const parallelTemplate = () =>
    engine.defineTemplate({
      name: 'PAR',
      documentType: 'contract',
      levels: [
        {
          level: 1,
          name: 'Finance',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'fin' }],
          mode: 'any',
        },
        {
          level: 2,
          name: 'Legal',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'legal' }],
          mode: 'any',
        },
      ],
    });

  const submit = () =>
    engine.submit({
      templateName: 'PAR',
      documentId: `c-${Math.random()}`,
      documentType: 'contract',
      submittedBy: 'buyer',
      data: {},
    });

  it('notifies every open branch that work arrived', async () => {
    await parallelTemplate();
    await submit();
    expect(recipientsFor('approval:submitted')?.sort()).toEqual(['fin', 'legal']);
  });

  it('drops a branch from the audience once it is decided', async () => {
    await parallelTemplate();
    const i = await submit();
    seen = [];
    await engine.approve(i.id, { approverId: 'legal' });
    expect(recipientsFor('approval:approved')).toEqual(['fin']);
  });

  it('sends a comment to the people it mentions, not to the current level', async () => {
    await parallelTemplate();
    const i = await submit();
    seen = [];
    await engine.addComment(i.id, {
      actorId: 'fin',
      comment: 'over to you',
      mentions: ['someone-else'],
    });
    expect(recipientsFor('approval:commented')).toEqual(['someone-else']);
  });

  it('sends a clarification request to the submitter', async () => {
    await parallelTemplate();
    const i = await submit();
    seen = [];
    await engine.requestInfo(i.id, { approverId: 'fin', question: 'which cost centre?' });
    expect(recipientsFor('approval:info_requested')).toEqual(['buyer']);
  });

  it('still names the single approver on a sequential template', async () => {
    await engine.defineTemplate({
      name: 'SEQ',
      documentType: 'seq',
      levels: [
        { level: 1, name: 'One', approvers: [{ type: 'user', userId: 'solo' }], mode: 'any' },
      ],
    });
    await engine.submit({
      templateName: 'SEQ',
      documentId: 's-1',
      documentType: 'seq',
      submittedBy: 'buyer',
      data: {},
    });
    expect(recipientsFor('approval:submitted')).toEqual(['solo']);
  });
});

describe('ApprovalTestKit.fullyApprove', () => {
  it('drives a parallel group to completion', async () => {
    // Keyed on instance.currentLevel, it approved only the lowest branch and
    // then re-offered the same decision, because currentLevel does not move
    // until the whole group closes.
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'PAR',
      documentType: 'contract',
      levels: [
        {
          level: 1,
          name: 'Finance',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'fin' }],
          mode: 'any',
        },
        {
          level: 2,
          name: 'Legal',
          group: 'rev',
          approvers: [{ type: 'user', userId: 'legal' }],
          mode: 'any',
        },
        { level: 3, name: 'CEO', approvers: [{ type: 'user', userId: 'ceo' }], mode: 'any' },
      ],
    });
    const i = await engine.submit({
      templateName: 'PAR',
      documentId: 'c-1',
      documentType: 'contract',
      submittedBy: 'buyer',
      data: {},
    });

    const done = await ApprovalTestKit.fullyApprove(engine, i.id, {
      1: 'fin',
      2: 'legal',
      3: 'ceo',
    });
    expect(done.status).toBe('approved');
  });

  it('still drives a sequential template', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'SEQ',
      documentType: 'seq',
      levels: [
        { level: 1, name: 'One', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' },
        { level: 2, name: 'Two', approvers: [{ type: 'user', userId: 'b' }], mode: 'any' },
      ],
    });
    const i = await engine.submit({
      templateName: 'SEQ',
      documentId: 's-1',
      documentType: 'seq',
      submittedBy: 'buyer',
      data: {},
    });
    const done = await ApprovalTestKit.fullyApprove(engine, i.id, { 1: 'a', 2: 'b' });
    expect(done.status).toBe('approved');
  });

  it('still reports a level with no approver supplied', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.defineTemplate({
      name: 'SEQ',
      documentType: 'seq',
      levels: [{ level: 1, name: 'One', approvers: [{ type: 'user', userId: 'a' }], mode: 'any' }],
    });
    const i = await engine.submit({
      templateName: 'SEQ',
      documentId: 's-2',
      documentType: 'seq',
      submittedBy: 'buyer',
      data: {},
    });
    await expect(ApprovalTestKit.fullyApprove(engine, i.id, {})).rejects.toThrow(
      /No approver provided for level 1/,
    );
  });
});
