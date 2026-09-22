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
