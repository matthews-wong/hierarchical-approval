import { describe, it, expect } from 'vitest';
import {
  evaluateConditions,
  registerConditionOperator,
} from '../../src/engine/ConditionEvaluator.js';
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
    expect(evaluateConditions(rules, { amount: 6000, dept: 'engineering' }).addLevels).toHaveLength(
      1,
    );
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

  it('handles not_in operator', () => {
    const notInRule: ConditionRule[] = [
      {
        when: { field: 'region', operator: 'not_in', value: ['EU', 'APAC'] },
        addLevels: [extraLevel],
      },
    ];
    expect(evaluateConditions(notInRule, { region: 'US' }).addLevels).toHaveLength(1);
    expect(evaluateConditions(notInRule, { region: 'EU' }).addLevels).toHaveLength(0);
  });

  it('missing dot-path segment resolves to undefined instead of throwing', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'vendor.country', operator: '==', value: 'US' }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(rules, {}).addLevels).toHaveLength(0);
    expect(evaluateConditions(rules, { vendor: { region: 'EU' } }).addLevels).toHaveLength(0);
  });

  it('non-array in / not_in values never match', () => {
    const inRule: ConditionRule[] = [
      { when: { field: 'type', operator: 'in', value: 'A' }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(inRule, { type: 'A' }).addLevels).toHaveLength(0);

    const notInRule: ConditionRule[] = [
      { when: { field: 'type', operator: 'not_in', value: 'A' }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(notInRule, { type: 'B' }).addLevels).toHaveLength(0);
  });

  it('unknown operator throws an error naming the operator', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'amount', operator: 'between', value: [1, 10] }, addLevels: [extraLevel] },
    ];
    expect(() => evaluateConditions(rules, { amount: 5 })).toThrow(
      /Unknown condition operator "between"/,
    );
  });

  it('a matching rule applies both addLevels and skipLevels mutations', () => {
    const rules: ConditionRule[] = [
      {
        when: { field: 'fastTrack', operator: '==', value: true },
        addLevels: [extraLevel],
        skipLevels: [2, 4],
      },
    ];
    const result = evaluateConditions(rules, { fastTrack: true });
    expect(result.addLevels).toHaveLength(1);
    expect(result.skipLevels.has(2)).toBe(true);
    expect(result.skipLevels.has(4)).toBe(true);
  });

  it('handles <, >=, <=, != operators', () => {
    const ltRule: ConditionRule[] = [
      { when: { field: 'amount', operator: '<', value: 10000 }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(ltRule, { amount: 5000 }).addLevels).toHaveLength(1);
    expect(evaluateConditions(ltRule, { amount: 15000 }).addLevels).toHaveLength(0);

    const gteRule: ConditionRule[] = [
      { when: { field: 'amount', operator: '>=', value: 10000 }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(gteRule, { amount: 10000 }).addLevels).toHaveLength(1);
    expect(evaluateConditions(gteRule, { amount: 9999 }).addLevels).toHaveLength(0);

    const lteRule: ConditionRule[] = [
      { when: { field: 'amount', operator: '<=', value: 10000 }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(lteRule, { amount: 10000 }).addLevels).toHaveLength(1);
    expect(evaluateConditions(lteRule, { amount: 10001 }).addLevels).toHaveLength(0);

    const neqRule: ConditionRule[] = [
      { when: { field: 'dept', operator: '!=', value: 'finance' }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(neqRule, { dept: 'engineering' }).addLevels).toHaveLength(1);
    expect(evaluateConditions(neqRule, { dept: 'finance' }).addLevels).toHaveLength(0);
  });

  it('== matches identical primitive values', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'code', operator: '==', value: 100 }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(rules, { code: 100 }).addLevels).toHaveLength(1);
  });

  it('== does not coerce between string and number', () => {
    const rules: ConditionRule[] = [
      { when: { field: 'code', operator: '==', value: 100 }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(rules, { code: '100' }).addLevels).toHaveLength(0);
  });

  it('a custom operator registered with registerConditionOperator is applied', () => {
    registerConditionOperator(
      'starts_with',
      (actual, expected) => typeof actual === 'string' && actual.startsWith(String(expected)),
    );
    const rules: ConditionRule[] = [
      { when: { field: 'dept', operator: 'starts_with', value: 'eng' }, addLevels: [extraLevel] },
    ];
    expect(evaluateConditions(rules, { dept: 'engineering' }).addLevels).toHaveLength(1);
    expect(evaluateConditions(rules, { dept: 'sales' }).addLevels).toHaveLength(0);
  });
});
