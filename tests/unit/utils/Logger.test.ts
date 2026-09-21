import { describe, it, expect } from 'vitest';
import { noopLogger } from '../../../src/utils/Logger.js';

describe('noopLogger', () => {
  it('exposes every Logger method as a safe no-op', () => {
    expect(noopLogger.info('msg')).toBeUndefined();
    expect(noopLogger.warn('msg')).toBeUndefined();
    expect(noopLogger.error('msg', new Error('boom'))).toBeUndefined();
    expect(noopLogger.fatal('msg', new Error('boom'))).toBeUndefined();
    expect(noopLogger.debug('msg')).toBeUndefined();
  });
});
