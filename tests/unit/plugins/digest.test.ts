import { describe, it, expect, vi } from 'vitest';
import { DigestNotificationAdapter } from '../../../src/plugins/notify/DigestNotificationAdapter.js';
import type { Digest } from '../../../src/plugins/notify/DigestNotificationAdapter.js';
import type { NotificationEvent } from '../../../src/adapters/INotificationAdapter.js';
import type { Clock } from '../../../src/utils/Clock.js';

class TestClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

const event = (over: Partial<NotificationEvent> = {}): NotificationEvent =>
  ({
    type: 'approval:submitted',
    instanceId: 'inst-1',
    documentId: 'doc-1',
    documentType: 'purchase_order',
    timestamp: new Date('2026-01-01T00:00:00Z'),
    recipients: ['alice'],
    templateName: 'PO',
    tenantId: 'default',
    payload: {} as NotificationEvent['payload'],
    ...over,
  }) as NotificationEvent;

const build = (over: Record<string, unknown> = {}) => {
  const sent: Digest[] = [];
  const clock = new TestClock();
  const adapter = new DigestNotificationAdapter({
    send: (d) => {
      sent.push(d);
    },
    clock,
    ...over,
  });
  return { adapter, sent, clock };
};

describe('DigestNotificationAdapter', () => {
  it('buffers instead of sending immediately', async () => {
    const { adapter, sent } = build();
    await adapter.notify(event());
    expect(sent).toEqual([]);
    expect(adapter.pendingRecipients).toBe(1);
  });

  it('delivers one digest per recipient on flush', async () => {
    const { adapter, sent } = build();
    await adapter.notify(event({ recipients: ['alice', 'bob'] }));
    await adapter.notify(event({ recipients: ['alice'], instanceId: 'inst-2' }));
    await adapter.flush();

    expect(sent).toHaveLength(2);
    const alice = sent.find((d) => d.recipient === 'alice');
    expect(alice?.events).toHaveLength(2);
    expect(sent.find((d) => d.recipient === 'bob')?.events).toHaveLength(1);
  });

  it('keeps events in arrival order and records the window', async () => {
    const { adapter, sent, clock } = build();
    await adapter.notify(event({ instanceId: 'first' }));
    clock.advanceMs(60_000);
    await adapter.notify(event({ instanceId: 'second' }));
    clock.advanceMs(60_000);
    await adapter.flush();

    const d = sent[0]!;
    expect(d.events.map((e) => e.instanceId)).toEqual(['first', 'second']);
    expect(d.since.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(d.flushedAt.toISOString()).toBe('2026-01-01T00:02:00.000Z');
  });

  it('clears the buffer after flushing', async () => {
    const { adapter, sent } = build();
    await adapter.notify(event());
    await adapter.flush();
    await adapter.flush();
    expect(sent).toHaveLength(1);
    expect(adapter.pendingRecipients).toBe(0);
  });

  describe('urgent events bypass the buffer', () => {
    it.each([
      'approval:rejected',
      'approval:completed',
      'approval:sla_breached',
      'approval:expired',
    ])('%s is delivered immediately', async (type) => {
      const { adapter, sent } = build();
      await adapter.notify(event({ type: type as NotificationEvent['type'] }));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.events[0]?.type).toBe(type);
      expect(adapter.pendingRecipients).toBe(0);
    });

    it('respects a custom passthrough list', async () => {
      const { adapter, sent } = build({ passthrough: ['approval:submitted'] });
      await adapter.notify(event({ type: 'approval:submitted' }));
      expect(sent).toHaveLength(1);

      // A default-urgent type is now batched, because the caller said so.
      await adapter.notify(event({ type: 'approval:rejected' }));
      expect(sent).toHaveLength(1);
      expect(adapter.pendingRecipients).toBe(1);
    });
  });

  describe('maxBatchSize', () => {
    it('flushes a recipient once the cap is reached', async () => {
      const { adapter, sent } = build({ maxBatchSize: 3 });
      for (let i = 0; i < 3; i++) await adapter.notify(event({ instanceId: `i${i}` }));
      expect(sent).toHaveLength(1);
      expect(sent[0]?.events).toHaveLength(3);
    });

    it('does not force other recipients out early', async () => {
      const { adapter, sent } = build({ maxBatchSize: 2 });
      await adapter.notify(event({ recipients: ['bob'] }));
      await adapter.notify(event({ recipients: ['alice'] }));
      await adapter.notify(event({ recipients: ['alice'] }));

      // Only alice hit the cap; bob is still waiting.
      expect(sent.map((d) => d.recipient)).toEqual(['alice']);
      expect(adapter.pendingRecipients).toBe(1);
    });
  });

  describe('failure handling', () => {
    it('swallows a throwing send, as the adapter contract requires', async () => {
      const adapter = new DigestNotificationAdapter({
        send: () => {
          throw new Error('mailer down');
        },
      });
      await adapter.notify(event());
      await expect(adapter.flush()).resolves.toBeUndefined();
    });

    it('does not replay a failed digest into the next one', async () => {
      const seen: number[] = [];
      let calls = 0;
      const adapter = new DigestNotificationAdapter({
        send: (d) => {
          calls++;
          seen.push(d.events.length);
          if (calls === 1) throw new Error('mailer down');
        },
      });

      await adapter.notify(event({ instanceId: 'a' }));
      await adapter.flush();
      await adapter.notify(event({ instanceId: 'b' }));
      await adapter.flush();

      // Second digest holds only the new event, not a growing backlog.
      expect(seen).toEqual([1, 1]);
    });
  });

  describe('timer', () => {
    it('flushes on the interval', async () => {
      vi.useFakeTimers();
      try {
        const sent: Digest[] = [];
        const adapter = new DigestNotificationAdapter({
          intervalMs: 1000,
          send: (d) => {
            sent.push(d);
          },
        });
        await adapter.notify(event());
        expect(sent).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(1000);
        expect(sent).toHaveLength(1);
        await adapter.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it('rejects a non-positive interval', () => {
      expect(() => new DigestNotificationAdapter({ send: () => {}, intervalMs: 0 })).toThrow(
        /intervalMs must be a positive number/,
      );
    });

    it('stop() delivers what is buffered', async () => {
      const { adapter, sent } = build();
      await adapter.notify(event());
      await adapter.stop();
      expect(sent).toHaveLength(1);
    });
  });
});
