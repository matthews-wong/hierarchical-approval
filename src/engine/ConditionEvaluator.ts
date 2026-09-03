import type { Condition, ConditionRule, ApprovalLevelConfig } from '../types/index.js';
import { ApprovalValidationError } from '../errors.js';

export type ConditionOperatorFn = (actual: unknown, expected: unknown) => boolean;

/**
 * Coerce a value to a number *only* when it unambiguously represents one.
 *
 * Plain `Number()` maps `null`, `''`, `'   '`, `[]` and `false` all to `0`, which
 * in an approval engine is an approval-bypass hazard: a rule such as
 * `{ amount: '<' 5000 } -> skipLevels: [2, 3]` would fire on a document whose
 * `amount` is missing or blank, silently skipping two approval levels. Numeric
 * comparison against a value that is not a number is not "false-y", it is
 * *undecidable*, so this returns `null` and the comparison reports no match —
 * the same outcome `undefined` has always produced.
 *
 * Accepted: finite numbers, bigints, `Date` (compared as epoch ms), and numeric
 * strings such as `'100'` or `' 1e3 '` (ERP payloads routinely arrive as JSON
 * strings). Rejected: `null`, `undefined`, booleans, arrays, objects, blank
 * strings, and the non-finite `NaN` / `Infinity`.
 *
 * @param value - The raw value taken from the condition or the context data.
 * @returns The numeric value, or `null` when the value is not comparable.
 */
export function toComparableNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isFinite(time) ? time : null;
  }
  if (typeof value === 'string') {
    // Number('') and Number('   ') are both 0 — reject blanks before coercing.
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Build a numeric operator that reports no match unless BOTH operands are comparable numbers. */
function numeric(compare: (left: number, right: number) => boolean): ConditionOperatorFn {
  return (actual, expected) => {
    const left = toComparableNumber(actual);
    const right = toComparableNumber(expected);
    if (left === null || right === null) return false;
    return compare(left, right);
  };
}

// Built-in operators seeded at module load time.
const operatorRegistry = new Map<string, ConditionOperatorFn>([
  ['>', numeric((a, e) => a > e)],
  ['<', numeric((a, e) => a < e)],
  ['>=', numeric((a, e) => a >= e)],
  ['<=', numeric((a, e) => a <= e)],
  ['==', (a, e) => a === e],
  ['!=', (a, e) => a !== e],
  ['in', (a, e) => Array.isArray(e) && e.includes(a)],
  ['not_in', (a, e) => Array.isArray(e) && !e.includes(a)],
]);

// Names reserved at module load so built-ins can never be shadowed by a custom operator.
const builtinOperatorNames = new Set(operatorRegistry.keys());

/** Register a custom condition operator globally. Throws if the name is already taken by a built-in. */
export function registerConditionOperator(name: string, fn: ConditionOperatorFn): void {
  if (builtinOperatorNames.has(name)) {
    throw new ApprovalValidationError(
      `Condition operator "${name}" is a built-in and cannot be overridden. Choose a different name.`,
    );
  }
  operatorRegistry.set(name, fn);
}

/**
 * Resolve a dot-separated path against the context data, reading **own**
 * properties only.
 *
 * The `in` operator this previously used walks the prototype chain, so a
 * condition on `isFastTrack` would be satisfied by an inherited
 * `Object.prototype.isFastTrack` that no document ever declared. Prototype
 * pollution is a common enough hazard in a JavaScript dependency tree that an
 * approval engine must not let it decide whether a level is skipped — so a path
 * segment that is not an own property resolves to `undefined`, exactly as a
 * genuinely absent field does. This also blocks `__proto__`, `constructor`, and
 * `prototype`, none of which are own properties of a data object.
 *
 * @param data - The instance context data the condition is evaluated against.
 * @param path - Dot-separated field path, e.g. `'vendor.country'`.
 * @returns The value at the path, or `undefined` if any segment is absent.
 */
function getField(data: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj !== null && typeof obj === 'object' && Object.prototype.hasOwnProperty.call(obj, key)) {
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
