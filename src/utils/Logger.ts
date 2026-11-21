/** Structured logger injected into engine and plugin components. */
export interface Logger {
  /** Routine, expected activity. */
  info(msg: string, context?: Record<string, unknown>): void;
  /** Unexpected but recoverable condition. */
  warn(msg: string, context?: Record<string, unknown>): void;
  /** A caught error that did not stop the calling operation. */
  error(msg: string, err?: unknown, context?: Record<string, unknown>): void;
  /** A caught error severe enough that the calling operation could not continue. */
  fatal(msg: string, err?: unknown, context?: Record<string, unknown>): void;
  /** Verbose, developer-facing detail. */
  debug(msg: string, context?: Record<string, unknown>): void;
}

/** {@link Logger} that discards every call — the default when no logger is configured. */
export const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  debug: () => {},
};

/**
 * Wraps `logger` so that a call which throws is swallowed. Logging is
 * best-effort: a broken sink must not abort an operation that has already
 * persisted its state.
 */
export function safeLogger(logger: Logger): Logger {
  const guard =
    <A extends unknown[]>(call: (...args: A) => void) =>
    (...args: A): void => {
      try {
        call(...args);
      } catch {
        // Nowhere left to report a failing logger.
      }
    };
  return {
    info: guard((msg, context) => logger.info(msg, context)),
    warn: guard((msg, context) => logger.warn(msg, context)),
    error: guard((msg, err, context) => logger.error(msg, err, context)),
    fatal: guard((msg, err, context) => logger.fatal(msg, err, context)),
    debug: guard((msg, context) => logger.debug(msg, context)),
  };
}
