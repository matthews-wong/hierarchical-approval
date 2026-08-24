import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { InMemorySchedulerAdapter } from '../../../src/plugins/scheduler/index.js';
import { spyLogger } from './_helpers.js';

describe('InMemorySchedulerAdapter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires the callback at the scheduled time, not before (fake timers, no real waiting)', async () => {
    const adapter = new InMemorySchedulerAdapter();
    let fired = false;

    await adapter.scheduleAt('job-1', new Date(Date.now() + 5000), async () => {
      fired = true;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(fired).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toBe(true);
  });

  it('cancel() prevents a pending callback from firing', async () => {
    const adapter = new InMemorySchedulerAdapter();
    let fired = false;

    const handle = await adapter.scheduleAt('job-2', new Date(Date.now() + 5000), async () => {
      fired = true;
    });
    await adapter.cancel(handle);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fired).toBe(false);
  });

  it('cancel() on an unknown or already-fired handle is a safe no-op', async () => {
    const adapter = new InMemorySchedulerAdapter();
    await expect(adapter.cancel('does-not-exist')).resolves.toBeUndefined();
  });

  it('shutdown() clears every pending timer, leaving no open handles', async () => {
    const adapter = new InMemorySchedulerAdapter();
    let fired = false;

    await adapter.scheduleAt('job-3', new Date(Date.now() + 5000), async () => {
      fired = true;
    });
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await adapter.shutdown();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(fired).toBe(false);
  });

  it('shutdown() is idempotent when called multiple times', async () => {
    const adapter = new InMemorySchedulerAdapter();
    await adapter.shutdown();
    await expect(adapter.shutdown()).resolves.toBeUndefined();
  });

  it('rejects scheduleAt() once shutdown() has run', async () => {
    const adapter = new InMemorySchedulerAdapter();
    await adapter.shutdown();

    await expect(
      adapter.scheduleAt('job-4', new Date(Date.now() + 1000), async () => {}),
    ).rejects.toThrow(/shutdown/);
  });

  it('logs and swallows an error thrown by the scheduled callback (never crashes the process)', async () => {
    const logger = spyLogger();
    const adapter = new InMemorySchedulerAdapter({ logger });
    const boom = new Error('boom');

    await adapter.scheduleAt('job-5', new Date(Date.now() + 1000), async () => {
      throw boom;
    });

    await vi.advanceTimersByTimeAsync(1000);
    // Let the callback promise's .catch() microtask run.
    await vi.advanceTimersByTimeAsync(0);

    expect(logger.error).toHaveBeenCalledWith(
      'InMemorySchedulerAdapter: scheduled callback threw',
      boom,
      expect.objectContaining({ id: 'job-5' }),
    );
  });

  it('computes the delay from the injected clock, not the real system clock', async () => {
    const clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
    const adapter = new InMemorySchedulerAdapter({ clock });
    let fired = false;

    await adapter.scheduleAt('job-6', new Date('2026-01-01T00:00:05.000Z'), async () => {
      fired = true;
    });

    await vi.advanceTimersByTimeAsync(4999);
    expect(fired).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toBe(true);
  });

  it('never produces a negative setTimeout delay for a runAt already in the past', async () => {
    const adapter = new InMemorySchedulerAdapter();
    let fired = false;

    await adapter.scheduleAt('job-7', new Date(Date.now() - 5000), async () => {
      fired = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(fired).toBe(true);
  });

  it('generates distinct handles when scheduling with the same job id and allows selective cancellation', async () => {
    const adapter = new InMemorySchedulerAdapter();
    let fired1 = false;
    let fired2 = false;

    const handle1 = await adapter.scheduleAt('job-repeat', new Date(Date.now() + 2000), async () => {
      fired1 = true;
    });
    const handle2 = await adapter.scheduleAt('job-repeat', new Date(Date.now() + 2000), async () => {
      fired2 = true;
    });

    expect(handle1).not.toBe(handle2);

    await adapter.cancel(handle1);
    await vi.advanceTimersByTimeAsync(2000);

    expect(fired1).toBe(false);
    expect(fired2).toBe(true);
  });
});
