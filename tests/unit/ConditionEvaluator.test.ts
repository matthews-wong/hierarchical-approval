import { describe, it, expect } from 'vitest';
import { evaluateConditions } from '../../src/engine/ConditionEvaluator.js';
import type { ConditionRule } from '../../src/types/index.js';

describe('ConditionEvaluator', () => {
  const extraLevel = {
    level: 3,
    name: 'CFO',
    approvers: [{ type: 'user' as const, userId: 'cfo' }],
    mode: 'any' as const,
  };

  it('adds levels when condition matches', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'amount', operator: '>', value: 10000 }, addLevels: [extraLevel] },
    ];
    const result = evaluateConditions(rules, { amount: 15000 });
    expect(result.addLevels).toHaveLength(1);
    expect(result.addLevels[0]?.level).toBe(3);
  });

  it('does not add levels when condition does not match', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'amount', operator: '>', value: 10000 }, addLevels: [extraLevel] },
    ];
    const result = evaluateConditions(rules, { amount: 5000 });
    expect(result.addLevels).toHaveLength(0);
  });

  it('skips levels by number', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'fastTrack', operator: '==', value: true }, skipLevels: [2] },
    ];
    const result = evaluateConditions(rules, { fastTrack: true });
    expect(result.skipLevels.has(2)).toBe(true);
  });

  it('evaluates AND logic across condition array', () => {
    const rules: ConditionRule[] = [
      {
        when: [
          { field: 'amount', operator: '>', value: 5000 },
          { field: 'dept', operator: '==', value: 'engineering' },
        ],
        addLevels: [extraLevel],
      },
    ];
    expect(evaluateConditions(rules, { amount: 6000, dept: 'engineering' }).addLevels).toHaveLength(1);
    expect(evaluateConditions(rules, { amount: 6000, dept: 'finance' }).addLevels).toHaveLength(0);
  });

  it('resolves nested dot-path fields', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'vendor.country', operator: '==', value: 'US' }, addLevels: [extraLevel] },
    ];
    const result = evaluateConditions(rules, { vendor: { country: 'US' } });
    expect(result.addLevels).toHaveLength(1);
  });

  it('handles in / not_in operators', () => {
    const inRule: ConditionRule[] = [
      { when: { field: 'type', operator: 'in', value: ['A', 'B'] }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(inRule, { type: 'A' }).addLevels).toHaveLength(1);
    expect(evaluateConditions(inRule, { type: 'C' }).addLevels).toHaveLength(0);
  });
});
