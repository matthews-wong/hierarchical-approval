import { describe, it, expect } from 'vitest';
import { defaultIdGenerator } from '../../../src/utils/IdGenerator.js';

describe('defaultIdGenerator', () => {
  it('generates IDs with expected prefix', () => {
    expect(defaultIdGenerator('inst')).toMatch(/^inst_/);
    expect(defaultIdGenerator('tpl')).toMatch(/^tpl_/);
  });

  it('generates IDs with expected length', () => {
    expect(defaultIdGenerator('inst').length).toBeGreaterThan(15);
  });

  it('generates a reasonable ID length', () => {
    const id = defaultIdGenerator('inst');
    expect(id.length).toBeGreaterThan(10);
    expect(id.length).toBeLessThan(40);
  });

  it('generates unique IDs across rapid calls', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => defaultIdGenerator('inst')));
    expect(ids.size).toBe(1000);
  });
});
