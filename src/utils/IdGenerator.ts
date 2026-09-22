/** Entity kind an id is generated for: instance, template, attachment, or comment. */
export type IdGeneratorPrefix = 'inst' | 'tpl' | 'att' | 'cmt';

/** Produces a unique id for the given entity kind. */
export type IdGeneratorFn = (prefix: IdGeneratorPrefix) => string;

/** {@link IdGeneratorFn} used when no custom generator is configured. */
export const defaultIdGenerator: IdGeneratorFn = (prefix) =>
  `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
