export type IdGeneratorFn = (prefix: 'inst' | 'tpl') => string;

export const defaultIdGenerator: IdGeneratorFn = (prefix) =>
  `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
