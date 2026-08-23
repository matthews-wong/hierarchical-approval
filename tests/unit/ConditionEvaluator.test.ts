import { describe, it, expect } from 'vitest';
import {
  evaluateConditions,
  registerConditionOperator,
} from '../../src/engine/ConditionEvaluator.js';
import type { ConditionRule } from '../../src/types/index.js';

describe('ConditionEvaluator', () => {
  // ... existing tests ...

  it('handles null separately from undefined', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'amount', operator: '>', value: 5000 }, addLevels: [{ level: 3, name: 'CFO', approvers: [{ type: 'user' as const, userId: 'cfo' }], mode: 'any' as const }], },
    ];
    // Null is explicitly set - should NOT match as >5000 requires a number
    const resultWithNull = evaluateConditions(rules, { amount: null });
    expect(resultWithNull.addLevels).toHaveLength(0);

    // Undefined (field missing) already tested in 'ignores conditions with non-existent fields'
  });
});