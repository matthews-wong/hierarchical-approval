/**
 * Unit tests for the EventBus wrapper over eventemitter3: subscription
 * semantics (once/off), chaining, and cross-event isolation.
 */
import { describe, it, expect, vi } from 'vitest';
import { EventBus } from '../../../src/utils/EventBus.js';
import type { SubmittedEvent } from '../../../src/types/index.js';

function submittedEvent(overrides: Partial<SubmittedEvent> = {}): SubmittedEvent {
  return {
    instanceId: 'inst-1',
    documentId: 'D-1',
    documentType: 'doc',
    timestamp: new Date('2026-08-12T12:00:00.000Z'),
    submittedBy: 'alice',
    currentApprovers: ['bob'],
    ...overrides,
  };
}

describe('EventBus', () => {
  it('delivers the payload to a registered listener', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on('approval:submitted', listener);
    const payload = submittedEvent();

    bus.emit('approval:submitted', payload);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(payload);
  });

  it('calls every listener registered on the same event', () => {
    const bus = new EventBus();
    const first = vi.fn();
    const second = vi.fn();
    bus.on('approval:submitted', first);
    bus.on('approval:submitted', second);

    bus.emit('approval:submitted', submittedEvent());

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('off removes only the given listener', () => {
    const bus = new EventBus();
    const removed = vi.fn();
    const kept = vi.fn();
    bus.on('approval:submitted', removed);
    bus.on('approval:submitted', kept);
    bus.off('approval:submitted', removed);

    bus.emit('approval:submitted', submittedEvent());

    expect(removed).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
  });

  it('off is a no-op for a listener that was never registered', () => {
    const bus = new EventBus();
    const never = vi.fn();

    expect(() => bus.off('approval:submitted', never)).not.toThrow();
    expect(bus.off('approval:submitted', never)).toBe(bus);
  });

  it('once fires exactly once across repeated emits', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.once('approval:submitted', listener);

    bus.emit('approval:submitted', submittedEvent());
    bus.emit('approval:submitted', submittedEvent());

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('on, off, and once return the bus for chaining', () => {
    const bus = new EventBus();
    const listener = vi.fn();

    expect(bus.on('approval:submitted', listener)).toBe(bus);
    expect(bus.once('approval:submitted', listener)).toBe(bus);
    expect(bus.off('approval:submitted', listener)).toBe(bus);
  });

  it('does not fire listeners registered on a different event', () => {
    const bus = new EventBus();
    const listener = vi.fn();
    bus.on('approval:submitted', listener);

    bus.emit('approval:approved', {
      instanceId: 'inst-1',
      documentId: 'D-1',
      documentType: 'doc',
      timestamp: new Date('2026-08-12T12:00:00.000Z'),
      approverId: 'bob',
      level: 1,
      isFinal: false,
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it('emit with no listeners is a no-op that does not throw', () => {
    const bus = new EventBus();

    expect(() => bus.emit('approval:submitted', submittedEvent())).not.toThrow();
  });
});
