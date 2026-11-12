import { describe, expect, it } from 'vitest';
import { ApprovalError } from '../../src/index.js';

describe('ApprovalError.toHttpStatus', () => {
  it.each([
    ['NOT_FOUND', 404],
    ['CONFLICT', 409],
    ['CANNOT_CANCEL', 409],
    ['FORBIDDEN', 403],
    ['VALIDATION', 422],
    ['TEMPLATE_NOT_FOUND', 404],
    ['SCHEDULER_SHUTDOWN', 503],
  ])('maps %s to %i', (code, status) => {
    expect(new ApprovalError('x', code).toHttpStatus()).toBe(status);
  });

  it('returns 500 for an unmapped code', () => {
    expect(new ApprovalError('x', 'UNKNOWN').toHttpStatus()).toBe(500);
  });

  it.each(['', 'not_found', 'Not_Found', ' NOT_FOUND'])(
    'matches codes exactly, so %j yields 500',
    (code) => {
      expect(new ApprovalError('x', code).toHttpStatus()).toBe(500);
    },
  );

  it('does not trim a trailing space, while the exact code still maps', () => {
    expect(new ApprovalError('x', 'NOT_FOUND').toHttpStatus()).toBe(404);
    expect(new ApprovalError('x', 'NOT_FOUND ').toHttpStatus()).toBe(500);
  });

  it.each(['toString', 'constructor', '__proto__'])(
    'returns 500 for the inherited object key %s',
    (code) => {
      expect(new ApprovalError('x', code).toHttpStatus()).toBe(500);
    },
  );
});
