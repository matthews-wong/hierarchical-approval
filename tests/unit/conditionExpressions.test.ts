import { describe, it, expect } from 'vitest';
import {
  evaluateConditions,
  validateConditionExpression,
} from '../../src/engine/ConditionEvaluator.js';
import type { ConditionRule, ConditionExpression } from '../../src/types/index.js';

const extraLevel = {
  level: 3,
  name: 'CFO',
  approvers: [{ type: 'user' as const, userId: 'cfo' }],
  mode: 'any' as const,
};

/** Does `when` fire against `data`? */
const fires = (when: ConditionExpression, data: Record<string, unknown>): boolean => {
  const rules: ConditionRule[] = [{ when, addLevels: [extraLevel] }];
  return evaluateConditions(rules, data).addLevels.length === 1;
};

describe('boolean condition expressions', () => {
  describe('backward compatibility', () => {
    it('a bare condition still works', () => {
      expect(fires({ field: 'amount', operator: '>', value: 100 }, { amount: 200 })).toBe(true);
      expect(fires({ field: 'amount', operator: '>', value: 100 }, { amount: 50 })).toBe(false);
    });

    it('an array still means AND', () => {
      const when: ConditionExpression = [
        { field: 'amount', operator: '>', value: 100 },
        { field: 'dept', operator: '==', value: 'eng' },
      ];
      expect(fires(when, { amount: 200, dept: 'eng' })).toBe(true);
      expect(fires(when, { amount: 200, dept: 'fin' })).toBe(false);
      expect(fires(when, { amount: 50, dept: 'eng' })).toBe(false);
    });
  });

  describe('all', () => {
    it('requires every child to hold', () => {
      const when: ConditionExpression = {
        all: [
          { field: 'amount', operator: '>', value: 100 },
          { field: 'dept', operator: '==', value: 'eng' },
        ],
      };
      expect(fires(when, { amount: 200, dept: 'eng' })).toBe(true);
      expect(fires(when, { amount: 200, dept: 'fin' })).toBe(false);
    });
  });

  describe('any', () => {
    it('requires at least one child to hold', () => {
      const when: ConditionExpression = {
        any: [
          { field: 'amount', operator: '>', value: 10000 },
          { field: 'risk', operator: '==', value: 'high' },
        ],
      };
      expect(fires(when, { amount: 20000, risk: 'low' })).toBe(true);
      expect(fires(when, { amount: 5, risk: 'high' })).toBe(true);
      expect(fires(when, { amount: 5, risk: 'low' })).toBe(false);
    });

    it('short-circuits without evaluating later children', () => {
      // A later child with an unknown operator would throw if it were reached.
      const when: ConditionExpression = {
        any: [
          { field: 'risk', operator: '==', value: 'high' },
          { field: 'x', operator: 'no_such_operator', value: 1 },
        ],
      };
      expect(fires(when, { risk: 'high' })).toBe(true);
      expect(() => fires(when, { risk: 'low' })).toThrow(/Unknown condition operator/);
    });
  });

  describe('not', () => {
    it('inverts a single expression', () => {
      const when: ConditionExpression = { not: { field: 'dept', operator: '==', value: 'eng' } };
      expect(fires(when, { dept: 'fin' })).toBe(true);
      expect(fires(when, { dept: 'eng' })).toBe(false);
    });

    it('inverts a group', () => {
      const when: ConditionExpression = {
        not: {
          any: [
            { field: 'dept', operator: '==', value: 'eng' },
            { field: 'dept', operator: '==', value: 'fin' },
          ],
        },
      };
      expect(fires(when, { dept: 'legal' })).toBe(true);
      expect(fires(when, { dept: 'eng' })).toBe(false);
    });

    it('double negation returns the original truth value', () => {
      const inner: ConditionExpression = { field: 'amount', operator: '>', value: 100 };
      expect(fires({ not: { not: inner } }, { amount: 200 })).toBe(true);
      expect(fires({ not: { not: inner } }, { amount: 50 })).toBe(false);
    });
  });

  describe('nesting', () => {
    it('expresses (A and B) or not C', () => {
      const when: ConditionExpression = {
        any: [
          {
            all: [
              { field: 'amount', operator: '>', value: 1000 },
              { field: 'dept', operator: '==', value: 'eng' },
            ],
          },
          { not: { field: 'region', operator: '==', value: 'US' } },
        ],
      };
      expect(fires(when, { amount: 2000, dept: 'eng', region: 'US' })).toBe(true); // left holds
      expect(fires(when, { amount: 1, dept: 'fin', region: 'EU' })).toBe(true); // right holds
      expect(fires(when, { amount: 1, dept: 'fin', region: 'US' })).toBe(false); // neither
    });

    it('mixes array shorthand inside a group', () => {
      const when: ConditionExpression = {
        any: [
          [
            { field: 'amount', operator: '>', value: 1000 },
            { field: 'dept', operator: '==', value: 'eng' },
          ],
          { field: 'override', operator: '==', value: true },
        ],
      };
      expect(fires(when, { amount: 2000, dept: 'eng' })).toBe(true);
      expect(fires(when, { amount: 1, dept: 'eng', override: true })).toBe(true);
      expect(fires(when, { amount: 1, dept: 'eng' })).toBe(false);
    });

    it('nests four levels deep', () => {
      const when: ConditionExpression = {
        all: [{ any: [{ not: { all: [{ field: 'a', operator: '==', value: 1 }] } }] }],
      };
      expect(fires(when, { a: 2 })).toBe(true);
      expect(fires(when, { a: 1 })).toBe(false);
    });
  });

  describe('malformed groups throw', () => {
    it('rejects more than one combinator key', () => {
      const when = {
        all: [{ field: 'a', operator: '==', value: 1 }],
        any: [{ field: 'b', operator: '==', value: 2 }],
      } as unknown as ConditionExpression;
      expect(() => fires(when, {})).toThrow(/exactly one of "all", "any" or "not"/);
    });

    it('rejects an empty all / any', () => {
      expect(() => fires({ all: [] }, {})).toThrow(/must not be empty/);
      expect(() => fires({ any: [] }, {})).toThrow(/must not be empty/);
    });

    it('rejects a non-array all / any', () => {
      const when = {
        all: { field: 'a', operator: '==', value: 1 },
      } as unknown as ConditionExpression;
      expect(() => fires(when, {})).toThrow(/must be an array of expressions/);
    });
  });

  describe('validateConditionExpression', () => {
    it('accepts a well-formed nested tree', () => {
      const when: ConditionExpression = {
        any: [
          { all: [{ field: 'a', operator: '==', value: 1 }] },
          { not: { field: 'b', operator: '>', value: 2 } },
        ],
      };
      expect(validateConditionExpression(when, 'when')).toEqual([]);
    });

    it('reports an empty group with its path', () => {
      const errors = validateConditionExpression({ all: [] }, 'conditions[0].when');
      expect(errors).toHaveLength(1);
      expect(errors[0]?.field).toBe('conditions[0].when');
      expect(errors[0]?.message).toMatch(/must not be empty/);
    });

    it('reports a leaf missing field or operator, with a nested path', () => {
      const when = {
        any: [{ operator: '==', value: 1 }, { field: 'b' }],
      } as unknown as ConditionExpression;
      const errors = validateConditionExpression(when, 'when');
      expect(errors.map((e) => e.field)).toEqual(['when.any[0].field', 'when.any[1].operator']);
    });

    it('collects every problem rather than stopping at the first', () => {
      const when = {
        all: [{ operator: '==', value: 1 }, { field: 'b' }, { any: [] }],
      } as unknown as ConditionExpression;
      expect(validateConditionExpression(when, 'w').length).toBe(3);
    });

    it('does not reject an operator that is not registered yet', () => {
      // Custom operators may be registered after the template is defined.
      const when: ConditionExpression = { field: 'a', operator: 'starts_with', value: 'x' };
      expect(validateConditionExpression(when, 'when')).toEqual([]);
    });
  });
});
