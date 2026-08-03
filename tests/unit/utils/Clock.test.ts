import { describe, it, expect } from 'vitest';
import { systemClock } from '../../../src/utils/Clock.js';

describe('systemClock', () => {
  it('returns the current date', () => {
    const now = systemClock.now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
