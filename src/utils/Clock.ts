/** Time source injected into engine and plugin components, so tests can control the clock. */
export interface Clock {
  now(): Date;
}

/** {@link Clock} backed by the real wall clock — the default when no clock is configured. */
export const systemClock: Clock = { now: () => new Date() };
