import EventEmitter from 'eventemitter3';
import type { ApprovalEventMap, ApprovalEventName } from '../types/index.js';

/**
 * Invoked when a subscriber's listener throws synchronously or returns a
 * rejecting promise. Receives the thrown value and the event that was being
 * delivered.
 */
export type ListenerErrorHandler = (error: unknown, event: ApprovalEventName) => void;

type Wrapped = (...args: unknown[]) => void;

/**
 * Typed event bus for approval lifecycle events.
 *
 * Listener failures are **isolated**: a subscriber that throws cannot abort the
 * engine operation that emitted the event, nor prevent the remaining listeners
 * from running. Before this isolation existed, one buggy `engine.on()` handler
 * would propagate out of `emit()` mid-operation — after the instance had already
 * been persisted — and skip notification dispatch and after-middleware entirely.
 * Failures are reported through {@link setListenerErrorHandler}, matching the
 * swallow-and-log contract the notification and audit adapter paths already use.
 */
export class EventBus {
  private emitter = new EventEmitter();
  /** Per-event map of caller-supplied listener to the wrapper actually registered, so `off` can find it. */
  private wrappers = new Map<ApprovalEventName, Map<unknown, Wrapped>>();
  private onListenerError?: ListenerErrorHandler;

  /** Route listener failures somewhere. Without this they are swallowed silently. */
  setListenerErrorHandler(handler: ListenerErrorHandler): void {
    this.onListenerError = handler;
  }

  emit<K extends ApprovalEventName>(event: K, payload: ApprovalEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends ApprovalEventName>(
    event: K,
    listener: (payload: ApprovalEventMap[K]) => void,
  ): this {
    this.emitter.on(event, this.wrap(event, listener, false));
    return this;
  }

  off<K extends ApprovalEventName>(
    event: K,
    listener: (payload: ApprovalEventMap[K]) => void,
  ): this {
    const wrapped = this.wrappers.get(event)?.get(listener);
    if (wrapped) {
      this.emitter.off(event, wrapped);
      this.forget(event, listener);
    }
    return this;
  }

  once<K extends ApprovalEventName>(
    event: K,
    listener: (payload: ApprovalEventMap[K]) => void,
  ): this {
    this.emitter.once(event, this.wrap(event, listener, true));
    return this;
  }

  /**
   * Wraps a caller listener so its failure is contained. The wrapper is recorded
   * per event so {@link off} can unregister by the original function reference.
   */
  private wrap<K extends ApprovalEventName>(
    event: K,
    listener: (payload: ApprovalEventMap[K]) => void,
    once: boolean,
  ): Wrapped {
    const wrapped: Wrapped = (...args: unknown[]) => {
      try {
        const result: unknown = listener(args[0] as ApprovalEventMap[K]);
        // A listener declared `void` may still be `async`; an unhandled
        // rejection would otherwise escape as a process-level warning.
        if (typeof (result as PromiseLike<void> | undefined)?.then === 'function') {
          void Promise.resolve(result).catch((err: unknown) => {
            this.onListenerError?.(err, event);
          });
        }
      } catch (err) {
        this.onListenerError?.(err, event);
      } finally {
        // eventemitter3 removes a `once` registration itself; drop our bookkeeping too.
        if (once) this.forget(event, listener);
      }
    };

    let perEvent = this.wrappers.get(event);
    if (!perEvent) {
      perEvent = new Map<unknown, Wrapped>();
      this.wrappers.set(event, perEvent);
    }
    perEvent.set(listener, wrapped);
    return wrapped;
  }

  private forget(event: ApprovalEventName, listener: unknown): void {
    const perEvent = this.wrappers.get(event);
    if (!perEvent) return;
    perEvent.delete(listener);
    if (perEvent.size === 0) this.wrappers.delete(event);
  }
}
