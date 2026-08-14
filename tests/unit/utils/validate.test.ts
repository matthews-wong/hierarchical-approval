import { describe, expect, it } from 'vitest';
import {
  AddCommentOptionsSchema,
  ApproveOptionsSchema,
  CancelOptionsSchema,
  DelegateOptionsSchema,
  EscalateOptionsSchema,
  OverrideOptionsSchema,
  ReassignOptionsSchema,
  RejectOptionsSchema,
  ResubmitOptionsSchema,
  SubmitOptionsSchema,
} from '../../../src/utils/validate.js';

describe('validate schemas', () => {
  describe('SubmitOptionsSchema', () => {
    it('applies defaults for data and metadata when omitted', () => {
      const parsed = SubmitOptionsSchema.parse({
        templateName: 'expense-approval',
        documentId: 'doc-123',
        documentType: 'expense',
        submittedBy: 'alice',
      });

      expect(parsed.data).toEqual({});
      expect(parsed.metadata).toEqual({});
      expect(parsed.expiresAt).toBeUndefined();
      expect(parsed.deadlineAction).toBeUndefined();
    });

    it('coerces string dates to Date for expiresAt', () => {
      const parsed = SubmitOptionsSchema.parse({
        templateName: 'expense-approval',
        documentId: 'doc-123',
        documentType: 'expense',
        submittedBy: 'alice',
        expiresAt: '2026-12-31T23:59:59.000Z',
        deadlineAction: 'reject',
      });

      expect(parsed.expiresAt).toBeInstanceOf(Date);
      expect(parsed.expiresAt?.toISOString()).toBe('2026-12-31T23:59:59.000Z');
      expect(parsed.deadlineAction).toBe('reject');
    });

    it('rejects empty strings for required fields', () => {
      expect(() =>
        SubmitOptionsSchema.parse({
          templateName: '',
          documentId: 'doc-123',
          documentType: 'expense',
          submittedBy: 'alice',
        })
      ).toThrow();
    });

    it('rejects invalid deadlineAction values', () => {
      expect(() =>
        SubmitOptionsSchema.parse({
          templateName: 'tmpl',
          documentId: 'doc-123',
          documentType: 'expense',
          submittedBy: 'alice',
          deadlineAction: 'escalate' as unknown as 'cancel',
        })
      ).toThrow();
    });
  });

  describe('ApproveOptionsSchema', () => {
    it('parses valid payload with optional comment', () => {
      const parsed = ApproveOptionsSchema.parse({ approverId: 'bob', comment: 'looks good' });
      expect(parsed).toEqual({ approverId: 'bob', comment: 'looks good' });
    });

    it('parses valid payload without comment', () => {
      const parsed = ApproveOptionsSchema.parse({ approverId: 'bob' });
      expect(parsed.approverId).toBe('bob');
      expect(parsed.comment).toBeUndefined();
    });

    it('rejects empty approverId', () => {
      expect(() => ApproveOptionsSchema.parse({ approverId: '' })).toThrow();
    });
  });

  describe('RejectOptionsSchema', () => {
    it('parses valid rejection with returnTo', () => {
      const parsed = RejectOptionsSchema.parse({
        approverId: 'bob',
        reason: 'Budget exceeded',
        returnTo: 'previous',
      });
      expect(parsed.returnTo).toBe('previous');
      expect(parsed.reason).toBe('Budget exceeded');
    });

    it('rejects invalid returnTo target', () => {
      expect(() =>
        RejectOptionsSchema.parse({
          approverId: 'bob',
          reason: 'Budget exceeded',
          returnTo: 'manager' as unknown as 'originator',
        })
      ).toThrow();
    });
  });

  describe('DelegateOptionsSchema', () => {
    it('parses delegation with coerced until date', () => {
      const parsed = DelegateOptionsSchema.parse({
        fromApprover: 'mgr-1',
        toApprover: 'mgr-2',
        reason: 'Out of office',
        until: '2026-09-01T00:00:00.000Z',
      });
      expect(parsed.until).toBeInstanceOf(Date);
      expect(parsed.until?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
    });

    it('rejects empty fromApprover or toApprover', () => {
      expect(() =>
        DelegateOptionsSchema.parse({
          fromApprover: '',
          toApprover: 'mgr-2',
          reason: 'Out of office',
        })
      ).toThrow();
    });
  });

  describe('ReassignOptionsSchema', () => {
    it('parses valid reassign payload', () => {
      const parsed = ReassignOptionsSchema.parse({
        reassignedBy: 'admin',
        fromApprover: 'mgr-1',
        toApprover: 'mgr-3',
        reason: 'Role change',
      });
      expect(parsed.reassignedBy).toBe('admin');
      expect(parsed.fromApprover).toBe('mgr-1');
      expect(parsed.toApprover).toBe('mgr-3');
    });
  });

  describe('CancelOptionsSchema and EscalateOptionsSchema', () => {
    it('parses valid cancel payload and rejects empty reason', () => {
      const parsed = CancelOptionsSchema.parse({
        cancelledBy: 'user-1',
        reason: 'Duplicate request',
      });
      expect(parsed.cancelledBy).toBe('user-1');
      expect(() =>
        CancelOptionsSchema.parse({ cancelledBy: 'user-1', reason: '' })
      ).toThrow();
    });

    it('parses valid escalate payload', () => {
      const parsed = EscalateOptionsSchema.parse({ escalatedBy: 'system' });
      expect(parsed.escalatedBy).toBe('system');
      expect(() => EscalateOptionsSchema.parse({ escalatedBy: '' })).toThrow();
    });
  });

  describe('ResubmitOptionsSchema', () => {
    it('parses resubmit with optional reason and updatedData', () => {
      const parsed = ResubmitOptionsSchema.parse({
        resubmittedBy: 'user-1',
        reason: 'Added receipts',
        updatedData: { amount: 250 },
      });
      expect(parsed.updatedData).toEqual({ amount: 250 });
      expect(parsed.reason).toBe('Added receipts');
    });

    it('parses resubmit without optional fields', () => {
      const parsed = ResubmitOptionsSchema.parse({ resubmittedBy: 'user-1' });
      expect(parsed.resubmittedBy).toBe('user-1');
      expect(parsed.reason).toBeUndefined();
      expect(parsed.updatedData).toBeUndefined();
    });
  });

  describe('AddCommentOptionsSchema and OverrideOptionsSchema', () => {
    it('parses valid AddCommentOptions', () => {
      const parsed = AddCommentOptionsSchema.parse({
        actorId: 'auditor-1',
        comment: 'Verified against PO',
      });
      expect(parsed.actorId).toBe('auditor-1');
      expect(parsed.comment).toBe('Verified against PO');
    });

    it('parses valid OverrideOptions', () => {
      const parsed = OverrideOptionsSchema.parse({
        overriddenBy: 'vp-ops',
        justification: 'Executive exception approved',
      });
      expect(parsed.overriddenBy).toBe('vp-ops');
      expect(parsed.justification).toBe('Executive exception approved');
    });

    it('rejects empty justification on OverrideOptions', () => {
      expect(() =>
        OverrideOptionsSchema.parse({
          overriddenBy: 'vp-ops',
          justification: '',
        })
      ).toThrow();
    });
  });
});
