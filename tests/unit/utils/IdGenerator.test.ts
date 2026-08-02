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
});
