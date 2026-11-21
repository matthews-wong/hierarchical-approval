import { describe, it, expect, vi } from 'vitest';
import { noopLogger, safeLogger } from '../../../src/utils/Logger.js';

describe('noopLogger', () => {
  it('exposes every Logger method as a safe no-op', () => {
    expect(noopLogger.info('msg')).toBeUndefined();
    expect(noopLogger.warn('msg')).toBeUndefined();
    expect(noopLogger.error('msg', new Error('boom'))).toBeUndefined();
    expect(noopLogger.fatal('msg', new Error('boom'))).toBeUndefined();
    expect(noopLogger.debug('msg')).toBeUndefined();
  });
});

describe('safeLogger', () => {
  const boom = (): never => {
    throw new Error('sink-down');
  };

  it('swallows a throw from every Logger method', () => {
    const logger = safeLogger({ info: boom, warn: boom, error: boom, fatal: boom, debug: boom });

    expect(() => logger.info('m')).not.toThrow();
    expect(() => logger.warn('m')).not.toThrow();
    expect(() => logger.error('m', new Error('e'))).not.toThrow();
    expect(() => logger.fatal('m', new Error('e'))).not.toThrow();
    expect(() => logger.debug('m')).not.toThrow();
  });

  it('forwards message, error and context to the wrapped logger', () => {
    const inner = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), debug: vi.fn() };
    const logger = safeLogger(inner);
    const err = new Error('e');

    logger.info('i', { a: 1 });
    logger.error('x', err, { b: 2 });
    logger.fatal('f', err, { c: 3 });

    expect(inner.info).toHaveBeenCalledWith('i', { a: 1 });
    expect(inner.error).toHaveBeenCalledWith('x', err, { b: 2 });
    expect(inner.fatal).toHaveBeenCalledWith('f', err, { c: 3 });
  });
});
