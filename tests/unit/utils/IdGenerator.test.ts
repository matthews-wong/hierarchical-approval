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
});
