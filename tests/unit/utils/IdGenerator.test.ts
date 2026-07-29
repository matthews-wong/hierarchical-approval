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
});
