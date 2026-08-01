import { describe, it, expect } from 'vitest';
import { defaultIdGenerator } from '../../../src/utils/IdGenerator.js';

describe('defaultIdGenerator', () => {
  it('generates IDs with expected prefix', () => {
    expect(defaultIdGenerator('inst')).toMatch(/^inst_/);
    expect(defaultIdGenerator('tpl')).toMatch(/^tpl_/);
  });

  it('generates unique IDs', () => {
    const id1 = defaultIdGenerator('inst');
    const id2 = defaultIdGenerator('inst');
    expect(id1).not.toBe(id2);
  });

  it('generates a reasonable ID length', () => {
    const id = defaultIdGenerator('inst');
    expect(id.length).toBeGreaterThan(10);
    expect(id.length).toBeLessThan(40);
  });
});
