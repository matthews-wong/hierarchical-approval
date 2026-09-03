import type {
  Condition,
  ConditionExpression,
  ConditionGroup,
  ConditionRule,
  ApprovalLevelConfig,
} from '../types/index.js';
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

/** Narrow an expression to a boolean combinator, or return null if it is a leaf condition. */
function asGroup(expression: ConditionExpression): ConditionGroup | null {
  if (expression === null || typeof expression !== 'object' || Array.isArray(expression)) {
    return null;
  }
  const candidate = expression as Partial<Record<'all' | 'any' | 'not', unknown>>;
  const keys = (['all', 'any', 'not'] as const).filter((k) => candidate[k] !== undefined);
  if (keys.length === 0) return null;
  if (keys.length > 1) {
    throw new ApprovalValidationError(
      `Condition group must set exactly one of "all", "any" or "not" (got ${keys.join(', ')}).`,
    );
  }
  const key = keys[0] as 'all' | 'any' | 'not';
  if (key !== 'not' && !Array.isArray(candidate[key])) {
    throw new ApprovalValidationError(`Condition group "${key}" must be an array of expressions.`);
  }
  if (key !== 'not' && (candidate[key] as unknown[]).length === 0) {
    // An empty `all` is vacuously true and an empty `any` vacuously false; both are
    // far more likely to be a construction bug than an intent, so reject them.
    throw new ApprovalValidationError(`Condition group "${key}" must not be empty.`);
  }
  return expression as ConditionGroup;
}

/**
 * Evaluate a condition expression tree.
 *
 * A bare condition is a leaf; an array is shorthand for `all`, which is what a
 * `when: [...]` meant before groups existed; and a group applies its
 * combinator to nested expressions, recursing to any depth.
 */
function evaluateExpression(
  expression: ConditionExpression,
  data: Record<string, unknown>,
): boolean {
  if (Array.isArray(expression)) {
    return expression.every((child) => evaluateExpression(child, data));
  }

  const group = asGroup(expression);
  if (group === null) {
    return evaluateCondition(expression as Condition, data);
  }
  if (group.all !== undefined) {
    return group.all.every((child) => evaluateExpression(child, data));
  }
  if (group.any !== undefined) {
    return group.any.some((child) => evaluateExpression(child, data));
  }
  return !evaluateExpression(group.not, data);
}

/**
 * Statically check a condition expression tree, collecting every problem rather
 * than throwing on the first.
 *
 * Runs at template-definition time so a malformed group is caught while the
 * author is looking at it, instead of at submit time on a real document. The
 * operator check is deliberately deferred: custom operators can be registered
 * after a template is defined, so an unknown name is only an error once the
 * condition is actually evaluated.
 *
 * @param expression - The `when` expression to check.
 * @param path - Field path prefix used in reported errors.
 * @returns One entry per problem found; empty when the tree is well formed.
 */
export function validateConditionExpression(
  expression: ConditionExpression,
  path: string,
): Array<{ field: string; message: string }> {
  const errors: Array<{ field: string; message: string }> = [];

  const walk = (node: ConditionExpression, at: string): void => {
    if (Array.isArray(node)) {
      if (node.length === 0) {
        errors.push({ field: at, message: 'Condition list must not be empty.' });
      }
      node.forEach((child, i) => walk(child, `${at}[${i}]`));
      return;
    }

    let group: ConditionGroup | null;
    try {
      group = asGroup(node);
    } catch (err) {
      errors.push({ field: at, message: (err as Error).message });
      return;
    }

    if (group === null) {
      const leaf = node as Partial<Condition>;
      if (typeof leaf?.field !== 'string' || leaf.field.length === 0) {
        errors.push({
          field: `${at}.field`,
          message: 'Condition requires a non-empty field path.',
        });
      }
      if (typeof leaf?.operator !== 'string' || leaf.operator.length === 0) {
        errors.push({ field: `${at}.operator`, message: 'Condition requires an operator.' });
      }
      return;
    }

    if (group.all !== undefined) {
      group.all.forEach((child, i) => walk(child, `${at}.all[${i}]`));
    } else if (group.any !== undefined) {
      group.any.forEach((child, i) => walk(child, `${at}.any[${i}]`));
    } else {
      walk(group.not, `${at}.not`);
    }
  };

  walk(expression, path);
  return errors;
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
    if (evaluateExpression(rule.when, data)) {
      if (rule.addLevels) mutations.addLevels.push(...rule.addLevels);
      if (rule.skipLevels) rule.skipLevels.forEach((l) => mutations.skipLevels.add(l));
    }
  }

  return mutations;
}
