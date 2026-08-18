import EventEmitter from 'eventemitter3';
import type { ApprovalEventMap, ApprovalEventName } from '../types/index.js';

export class EventBus {
  private emitter = new EventEmitter();

  emit<K extends ApprovalEventName>(event: K, payload: ApprovalEventMap[K]): void {
    this.emitter.emit(event, payload);
  }

  on<K extends ApprovalEventName>(
    event: K,
    listener: (payload: ApprovalEventMap[K]) => void,
  ): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends ApprovalEventName>(
    event: K,
    listener: (payload: ApprovalEventMap[K]) => void,
  ): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<K extends ApprovalEventName>(
    event: K,
    listener: (payload: ApprovalEventMap[K]) => void,
  ): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }
}
