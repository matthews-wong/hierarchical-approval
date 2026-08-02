export type IdGeneratorPrefix = 'inst' | 'tpl';

export type IdGeneratorFn = (prefix: IdGeneratorPrefix) => string;

export const defaultIdGenerator: IdGeneratorFn = (prefix) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
