import { describe, expect, it } from 'vitest';
import { ApprovalEngine, ApprovalValidationError } from '../../src/index.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

const MISSING_ADAPTER = /`adapter` option/;

describe('ApprovalEngine construction', () => {
  it.each([
    ['omitted', {}],
    ['undefined', { adapter: undefined }],
    ['null', { adapter: null }],
  ])('throws a validation error naming the adapter option when it is %s', (_label, opts) => {
    // Plain-JS callers can hand over what the types forbid.
    const construct = () => new ApprovalEngine(opts as never);
    expect(construct).toThrow(ApprovalValidationError);
    expect(construct).toThrow(MISSING_ADAPTER);
  });

  it('throws a validation error when the options object itself is missing', () => {
    // @ts-expect-error -- options are required by the type; a JS caller may omit them.
    const construct = () => new ApprovalEngine(undefined);
    expect(construct).toThrow(ApprovalValidationError);
    expect(construct).toThrow(MISSING_ADAPTER);
  });

  it('constructs with only an adapter and starts with no templates', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    try {
      await expect(engine.listTemplates()).resolves.toEqual([]);
    } finally {
      await engine.shutdown();
    }
  });
});
