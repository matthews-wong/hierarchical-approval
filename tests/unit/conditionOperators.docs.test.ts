import { describe, it, expect } from 'vitest';
import {
  evaluateConditions,
  registerConditionOperator,
  toComparableNumber,
} from '../../src/engine/ConditionEvaluator.js';
import type { ConditionRule } from '../../src/types/index.js';

/**
 * Executable copy of the custom-operator recipes documented in README
 * ("Conditional chains" → "Register custom operators"). Keeping them as tests
 * means a snippet cannot silently rot or stop compiling.
 */
describe('README custom-operator recipes', () => {
  const extraLevel = {
    level: 3,
    name: 'CFO',
    approvers: [{ type: 'user' as const, userId: 'cfo' }],
    mode: 'any' as const,
  };

  it('the documented `contains` operator works as shown', () => {
    registerConditionOperator(
      'contains',
      (actual, expected) => typeof actual === 'string' && actual.includes(String(expected)),
    );
    const rules: ConditionRule[] = [
      { when: { field: 'notes', operator: 'contains', value: 'urgent' }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(rules, { notes: 'please treat as urgent' }).addLevels).toHaveLength(
      1,
    );
    expect(evaluateConditions(rules, { notes: 'routine' }).addLevels).toHaveLength(0);
    expect(evaluateConditions(rules, { notes: null }).addLevels).toHaveLength(0);
  });

  it('the documented `between` operator inherits numeric strictness', () => {
    registerConditionOperator('between', (actual, expected) => {
      const value = toComparableNumber(actual);
      if (value === null || !Array.isArray(expected) || expected.length !== 2) return false;
      const min = toComparableNumber(expected[0]);
      const max = toComparableNumber(expected[1]);
      if (min === null || max === null) return false;
      return value >= min && value <= max;
    });

    const rules: ConditionRule[] = [
      {
        when: { field: 'amount', operator: 'between', value: [1000, 5000] },
        addLevels: [extraLevel],
      },
    ];
    expect(evaluateConditions(rules, { amount: 2500 }).addLevels).toHaveLength(1);
    expect(evaluateConditions(rules, { amount: '2500' }).addLevels).toHaveLength(1);
    expect(evaluateConditions(rules, { amount: 1000 }).addLevels).toHaveLength(1);
    expect(evaluateConditions(rules, { amount: 5000 }).addLevels).toHaveLength(1);
    expect(evaluateConditions(rules, { amount: 999 }).addLevels).toHaveLength(0);

    // The whole point of routing through toComparableNumber: no zero-coercion.
    expect(evaluateConditions(rules, { amount: null }).addLevels).toHaveLength(0);
    expect(evaluateConditions(rules, { amount: '' }).addLevels).toHaveLength(0);
    expect(evaluateConditions(rules, { amount: false }).addLevels).toHaveLength(0);

    // A malformed bound is rejected rather than silently treated as 0.
    const badBounds: ConditionRule[] = [
      {
        when: { field: 'amount', operator: 'between', value: [null, 5000] },
        addLevels: [extraLevel],
      },
    ];
    expect(evaluateConditions(badBounds, { amount: 2500 }).addLevels).toHaveLength(0);

    const notAnArray: ConditionRule[] = [
      { when: { field: 'amount', operator: 'between', value: 5000 }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(notAnArray, { amount: 2500 }).addLevels).toHaveLength(0);
  });
});
