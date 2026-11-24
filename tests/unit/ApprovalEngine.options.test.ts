import { describe, expect, it } from 'vitest';
import { ApprovalEngine, ApprovalValidationError } from '../../src/index.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';

describe('ApprovalEngine construction', () => {
  it('throws a validation error naming the adapter option when it is missing', () => {
    expect(() => new ApprovalEngine({} as never)).toThrow(ApprovalValidationError);
    expect(() => new ApprovalEngine({} as never)).toThrow(/`adapter` option/);
  });

  it('constructs with only an adapter', async () => {
    const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
    await engine.shutdown();
    expect(engine).toBeInstanceOf(ApprovalEngine);
  });
});
