import type { Condition, ConditionRule, ApprovalLevelConfig } from '../types/index.js';
import { ApprovalValidationError } from '../errors.js';

export type ConditionOperatorFn = (actual: unknown, expected: unknown) => boolean;

// Built-in operators seeded at module load time.
const operatorRegistry = new Map<string, ConditionOperatorFn>([
  ['>', (a, e) => Number(a) > Number(e)],
  ['<', (a, e) => Number(a) < Number(e)],
  ['>=', (a, e) => Number(a) >= Number(e)],
  ['<=', (a, e) => Number(a) <= Number(e)],
  ['==', (a, e) => a === e],
  ['!=', (a, e) => a !== e],
  ['in', (a, e) => Array.isArray(e) && e.includes(a)],
  ['not_in', (a, e) => Array.isArray(e) && !e.includes(a)],
]);

/** Register a custom condition operator globally. Throws if the name is already taken by a built-in. */
export function registerConditionOperator(name: string, fn: ConditionOperatorFn): void {
  operatorRegistry.set(name, fn);
}

function getField(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj !== null && typeof obj === 'object' && key in obj) {
      return (obj as Record<string, unknown>)[key];
    }
    return undefined;
  }, data);
}

function evaluateCondition(condition: Condition, data: Record<string, unknown>): boolean {
  const fn = operatorRegistry.get(condition.operator);
  if (!fn) {
    throw new ApprovalValidationError(
      `Unknown condition operator "${condition.operator}". Register it with engine.registerConditionOperator() or use a built-in: ${[...operatorRegistry.keys()].join(', ')}.`,
    );
  }
  const actual = getField(data, condition.field);
  return fn(actual, condition.value);
}

function evaluateRule(rule: Condition | Condition[], data: Record<string, unknown>): boolean {
  if (Array.isArray(rule)) {
    return rule.every((c) => evaluateCondition(c, data));
  }
  return evaluateCondition(rule, data);
}

export interface LevelMutations {
  addLevels: ApprovalLevelConfig[];
  skipLevels: Set<number>;
}

export function evaluateConditions(
  conditions: ConditionRule[],
  data: Record<string, unknown>,
): LevelMutations {
  const mutations: LevelMutations = { addLevels: [], skipLevels: new Set() };

  for (const rule of conditions) {
    if (evaluateRule(rule.when, data)) {
      if (rule.addLevels) mutations.addLevels.push(...rule.addLevels);
      if (rule.skipLevels) rule.skipLevels.forEach((l) => mutations.skipLevels.add(l));
    }
  }

  return mutations;
}
