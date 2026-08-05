import { describe, it, expect } from 'vitest';
import { CompositeAuditAdapter } from '../../../src/plugins/audit/index.js';
import type { IAuditAdapter } from '../../../src/adapters/IAuditAdapter.js';
import { makeEntry, makeInstance } from './_helpers.js';

describe('CompositeAuditAdapter regression', () => {
  it('does not leak instance identity when child names are unspecified', async () => {
    let capturedChildId = '';
    const mockAdapter: IAuditAdapter = {
      append: async () => {
        // Mock success
      },
    };
    
    // Test the logic that generates the default ID: 'child[${index}]'
    // If the index is 0, ID is 'child[0]'
    const composite = new CompositeAuditAdapter({
      children: [mockAdapter],
    });

    // We can't easily access the private `children` array, but we can 
    // observe the logger output if a child fails.
    const logs: string[] = [];
    const logger = {
        error: (msg: string) => logs.push(msg),
        info: () => {},
        debug: () => {},
        warn: () => {},
    };

    const failingAdapter: IAuditAdapter = {
        append: async () => { throw new Error('boom'); }
    };
    
    const compositeWithLogger = new CompositeAuditAdapter({
        children: [failingAdapter],
        logger: logger as any
    });

    await compositeWithLogger.append('t', 'i', makeEntry(), makeInstance());
    
    expect(logs[0]).toContain('child[0]');
  });
});
