import { describe, it, expect } from 'vitest';
import { noopLogger } from '../../../src/utils/Logger';

describe('noopLogger', () => {
  it('should not throw when methods are called', () => {
    expect(() => noopLogger.info('test')).not.toThrow();
    expect(() => noopLogger.warn('test')).not.toThrow();
    expect(() => noopLogger.error('test')).not.toThrow();
    expect(() => noopLogger.debug('test')).not.toThrow();
  });
});
