import { describe, it, expect, vi } from 'vitest';
import {
  OutboxNotificationAdapter,
  InMemoryOutboxStore,
  CompositeNotificationAdapter,
  TemplatedNotificationAdapter,
  type IOutboxStore,
  type OutboxRecord,
} from '../../../src/plugins/notify/index.js';
import type { INotificationAdapter, NotificationEvent } from '../../../src/adapters/INotificationAdapter.js';
import { ManualClock, spyLogger } from './_helpers.js';

function makeEvent(over: Partial<NotificationEvent> = {}): NotificationEvent {
  return {
    type: 'approval:approved',
    instanceId: 'inst-1',
    documentId: 'doc-1',
    documentType: 'invoice',
    timestamp: new Date('2026-06-26T10:00:00.000Z'),
    recipients: ['user-1'],
    templateName: 'tpl',
    tenantId: 'tenant-1',
    payload: {
      instanceId: 'inst-1',
      documentId: 'doc-1',
      documentType: 'invoice',
      timestamp: new Date('2026-06-26T10:00:00.000Z'),
      approverId: 'mgr-1',
      level: 2,
      isFinal: false,
      comment: 'looks good',
    } as NotificationEvent['payload'],
    ...over,
  };
}

describe('InMemoryOutboxStore', () => {
  function rec(over: Partial<OutboxRecord> = {}): OutboxRecord {
    return {
      id: 'r1',
      partitionKey: 'tenant-1:inst-1',
      tenantId: 'tenant-1',
      event: makeEvent(),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      enqueuedAt: 0,
      ...over,
    };
  }

  it('enqueue + due filters by status pending and nextAttemptAt <= now', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(rec({ id: 'a', nextAttemptAt: 100 }));
    await store.enqueue(rec({ id: 'b', nextAttemptAt: 50 }));
    expect((await store.due(60)).map((r) => r.id)).toEqual(['b']);
    expect((await store.due(200)).map((r) => r.id).sort()).toEqual(['a', 'b']);
  });

  it('due() sorts by enqueuedAt then id (FIFO best-effort)', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(rec({ id: 'z', enqueuedAt: 1 }));
    await store.enqueue(rec({ id: 'a', enqueuedAt: 1 }));
    await store.enqueue(rec({ id: 'm', enqueuedAt: 0 }));
    expect((await store.due(100)).map((r) => r.id)).toEqual(['m', 'a', 'z']);
  });

  it('dead records are excluded from due/pending and shown in deadLettered', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(rec({ id: 'd', status: 'dead' }));
    expect(await store.due(100)).toEqual([]);
    expect(await store.pending()).toEqual([]);
    expect((await store.deadLettered()).map((r) => r.id)).toEqual(['d']);
  });

  it('remove deletes a record; size getter reflects total', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(rec({ id: 'a' }));
    await store.enqueue(rec({ id: 'b' }));
    expect(store.size).toBe(2);
    await store.remove('a');
    expect(store.size).toBe(1);
  });

  it('update does not resurrect a removed record', async () => {
    const store = new InMemoryOutboxStore();
    await store.enqueue(rec({ id: 'a' }));
    await store.remove('a');
    await store.update(rec({ id: 'a' }));
    expect(store.size).toBe(0);
  });
});

describe('OutboxNotificationAdapter — notify/enqueue', () => {
  it('notify enqueues and never throws; record preserves tenantId + partitionKey', async () => {
    const clock = new ManualClock(1234);
    const store = new InMemoryOutboxStore();
    const adapter = new OutboxNotificationAdapter({ transport: () => {}, store, clock });
    await adapter.notify(makeEvent({ tenantId: 'T', instanceId: 'I' }));
    const pending = await adapter.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.tenantId).toBe('T');
    expect(pending[0]!.partitionKey).toBe('T:I');
    expect(pending[0]!.enqueuedAt).toBe(1234);
    expect(pending[0]!.nextAttemptAt).toBe(1234);
  });

  it('enqueue failure is caught, logged, and swallowed', async () => {
    const logger = spyLogger();
    const store: IOutboxStore = {
      enqueue: async () => {
        throw new Error('store down');
      },
      due: async () => [],
      update: async () => {},
      remove: async () => {},
      pending: async () => [],
      deadLettered: async () => [],
    };
    const adapter = new OutboxNotificationAdapter({ transport: () => {}, store, logger });
    await expect(adapter.notify(makeEvent())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('OutboxNotificationAdapter — drain & delivery', () => {
  it('drain delivers a due record exactly once and removes it', async () => {
    const clock = new ManualClock(0);
    const transport = vi.fn(async () => {});
    const adapter = new OutboxNotificationAdapter({ transport, clock });
    await adapter.notify(makeEvent());
    const delivered = await adapter.drain();
    expect(delivered).toBe(1);
    expect(transport).toHaveBeenCalledOnce();
    expect(await adapter.pending()).toHaveLength(0);
    // Second drain delivers nothing (removed).
    expect(await adapter.drain()).toBe(0);
    expect(transport).toHaveBeenCalledOnce();
  });

  it('retries with deterministic exponential backoff from the injected clock', async () => {
    const clock = new ManualClock(0);
    let calls = 0;
    const transport = vi.fn(async () => {
      calls++;
      if (calls < 3) throw new Error('transient');
    });
    const adapter = new OutboxNotificationAdapter({
      transport,
      clock,
      maxAttempts: 5,
      baseDelayMs: 1000,
      backoffFactor: 2,
    });
    await adapter.notify(makeEvent());

    // Attempt 1 (fails) -> next at 0 + 1000.
    expect(await adapter.drain()).toBe(0);
    expect((await adapter.pending())[0]!.nextAttemptAt).toBe(1000);

    // Not yet due.
    expect(await adapter.drain()).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);

    // Advance to 1000 -> attempt 2 (fails) -> next at 1000 + 2000 = 3000.
    clock.set(1000);
    expect(await adapter.drain()).toBe(0);
    expect((await adapter.pending())[0]!.nextAttemptAt).toBe(3000);

    // Advance to 3000 -> attempt 3 succeeds.
    clock.set(3000);
    expect(await adapter.drain()).toBe(1);
    expect(transport).toHaveBeenCalledTimes(3);
    expect(await adapter.pending()).toHaveLength(0);
  });

  it('transport that fails N-1 times then succeeds delivers exactly once', async () => {
    const clock = new ManualClock(0);
    let calls = 0;
    const transport = vi.fn(async () => {
      calls++;
      if (calls < 4) throw new Error('fail');
    });
    const adapter = new OutboxNotificationAdapter({ transport, clock, maxAttempts: 5, baseDelayMs: 10, backoffFactor: 1 });
    await adapter.notify(makeEvent());
    // backoffFactor 1 => every retry waits 10ms.
    for (let t = 0; t <= 40; t += 10) {
      clock.set(t);
      await adapter.drain();
    }
    expect(transport).toHaveBeenCalledTimes(4);
    expect(await adapter.pending()).toHaveLength(0);
    expect(await adapter.deadLettered()).toHaveLength(0);
  });

  it('always-failing transport ends in dead-letter after exactly maxAttempts', async () => {
    const clock = new ManualClock(0);
    const transport = vi.fn(async () => {
      throw new Error('always');
    });
    const adapter = new OutboxNotificationAdapter({ transport, clock, maxAttempts: 3, baseDelayMs: 10, backoffFactor: 1 });
    await adapter.notify(makeEvent());
    for (let t = 0; t <= 30; t += 10) {
      clock.set(t);
      await adapter.drain();
    }
    expect(transport).toHaveBeenCalledTimes(3);
    const dead = await adapter.deadLettered();
    expect(dead).toHaveLength(1);
    expect(dead[0]!.attempts).toBe(3);
    expect(dead[0]!.lastError).toBe('always');
    expect(await adapter.pending()).toHaveLength(0);
  });

  it('maxAttempts = 1 sends straight to dead-letter on a single failure (no retry)', async () => {
    const clock = new ManualClock(0);
    const transport = vi.fn(async () => {
      throw new Error('boom');
    });
    const adapter = new OutboxNotificationAdapter({ transport, clock, maxAttempts: 1 });
    await adapter.notify(makeEvent());
    await adapter.drain();
    expect(transport).toHaveBeenCalledOnce();
    expect(await adapter.deadLettered()).toHaveLength(1);
    expect(await adapter.pending()).toHaveLength(0);
  });

  it('synchronous transport throw is treated as a failed attempt', async () => {
    const clock = new ManualClock(0);
    const transport = vi.fn(() => {
      throw new Error('sync throw');
    });
    const adapter = new OutboxNotificationAdapter({ transport, clock, maxAttempts: 1 });
    await adapter.notify(makeEvent());
    await adapter.drain();
    expect(await adapter.deadLettered()).toHaveLength(1);
  });

  it('does not deliver records whose nextAttemptAt is in the future', async () => {
    const clock = new ManualClock(0);
    let calls = 0;
    const transport = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('fail');
    });
    const adapter = new OutboxNotificationAdapter({ transport, clock, maxAttempts: 3, baseDelayMs: 1000 });
    await adapter.notify(makeEvent());
    await adapter.drain(); // fail -> retry @1000
    // Clock not advanced: nothing delivered prematurely.
    expect(await adapter.drain()).toBe(0);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('drain on an empty outbox returns 0 and does not throw', async () => {
    const adapter = new OutboxNotificationAdapter({ transport: () => {}, clock: new ManualClock(0) });
    expect(await adapter.drain()).toBe(0);
  });

  it('concurrent drains reuse the in-flight promise (no double delivery)', async () => {
    const clock = new ManualClock(0);
    let resolveTransport!: () => void;
    const gate = new Promise<void>((res) => {
      resolveTransport = res;
    });
    const transport = vi.fn(async () => {
      await gate;
    });
    const adapter = new OutboxNotificationAdapter({ transport, clock });
    await adapter.notify(makeEvent());
    const p1 = adapter.drain();
    const p2 = adapter.drain();
    resolveTransport();
    const [d1, d2] = await Promise.all([p1, p2]);
    // Both await the same in-flight run; transport invoked once.
    expect(transport).toHaveBeenCalledOnce();
    expect(d1).toBe(d2);
  });

  it('computeBackoff caps at maxDelayMs and never overflows for very high attempts', async () => {
    const clock = new ManualClock(0);
    const transport = vi.fn(async () => {
      throw new Error('fail');
    });
    const adapter = new OutboxNotificationAdapter({
      transport,
      clock,
      maxAttempts: 20,
      baseDelayMs: 1000,
      backoffFactor: 10,
      maxDelayMs: 60_000,
    });
    await adapter.notify(makeEvent());
    // Drive every attempt; the scheduled delay must always be finite and <= cap.
    for (let i = 0; i < 25; i++) {
      const before = (await adapter.pending())[0];
      if (!before) break;
      clock.set(before.nextAttemptAt);
      await adapter.drain();
      const after = (await adapter.pending())[0];
      if (after) {
        const delay = after.nextAttemptAt - clock.now().getTime();
        expect(Number.isFinite(delay)).toBe(true);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(60_000);
      }
    }
    expect((await adapter.deadLettered()).length).toBe(1);
  });

  it('store read error during drain is logged, not thrown', async () => {
    const logger = spyLogger();
    const store: IOutboxStore = {
      enqueue: async () => {},
      due: async () => {
        throw new Error('read fail');
      },
      update: async () => {},
      remove: async () => {},
      pending: async () => [],
      deadLettered: async () => [],
    };
    const adapter = new OutboxNotificationAdapter({ transport: () => {}, store, logger, clock: new ManualClock(0) });
    expect(await adapter.drain()).toBe(0);
    expect(logger.error).toHaveBeenCalled();
  });

  it('pending() read error is logged and returns []', async () => {
    const logger = spyLogger();
    const store: IOutboxStore = {
      enqueue: async () => {},
      due: async () => [],
      update: async () => {},
      remove: async () => {},
      pending: async () => {
        throw new Error('pending fail');
      },
      deadLettered: async () => [],
    };
    const adapter = new OutboxNotificationAdapter({ transport: () => {}, store, logger });
    expect(await adapter.pending()).toEqual([]);
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('CompositeNotificationAdapter', () => {
  it('fans notify to every child', async () => {
    const a = { notify: vi.fn(async () => {}) };
    const b = { notify: vi.fn(async () => {}) };
    const c = new CompositeNotificationAdapter({ children: [a, b] });
    const ev = makeEvent();
    await c.notify(ev);
    expect(a.notify).toHaveBeenCalledWith(ev);
    expect(b.notify).toHaveBeenCalledWith(ev);
  });

  it('zero children resolves as a no-op', async () => {
    const c = new CompositeNotificationAdapter({ children: [] });
    await expect(c.notify(makeEvent())).resolves.toBeUndefined();
  });

  it('a failing child does not block others; rejection logged with child identity', async () => {
    const logger = spyLogger();
    const good = { notify: vi.fn(async () => {}) };
    const bad: INotificationAdapter = {
      notify: async () => {
        throw new Error('boom');
      },
    };
    const c = new CompositeNotificationAdapter({
      children: [{ name: 'sms', adapter: bad }, good],
      logger,
    });
    await expect(c.notify(makeEvent())).resolves.toBeUndefined();
    expect(good.notify).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]![2]).toMatchObject({ child: 'sms' });
  });

  it('captures a synchronously-throwing child', async () => {
    const logger = spyLogger();
    const sync: INotificationAdapter = {
      notify: () => {
        throw new Error('sync boom');
      },
    };
    const good = { notify: vi.fn(async () => {}) };
    const c = new CompositeNotificationAdapter({ children: [sync, good], logger });
    await expect(c.notify(makeEvent())).resolves.toBeUndefined();
    expect(good.notify).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('every child throwing still resolves and logs all errors', async () => {
    const logger = spyLogger();
    const mk = (): INotificationAdapter => ({
      notify: async () => {
        throw new Error('x');
      },
    });
    const c = new CompositeNotificationAdapter({ children: [mk(), mk()], logger });
    await expect(c.notify(makeEvent())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it('bare adapter gets a child[i] name in logs', async () => {
    const logger = spyLogger();
    const bad: INotificationAdapter = {
      notify: async () => {
        throw new Error('boom');
      },
    };
    const c = new CompositeNotificationAdapter({ children: [bad], logger });
    await c.notify(makeEvent());
    expect(logger.error.mock.calls[0]![2]).toMatchObject({ child: 'child[0]' });
  });
});

describe('TemplatedNotificationAdapter', () => {
  it('renders string templates with {placeholder} interpolation from event then payload', async () => {
    const sent: unknown[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      templates: {
        'approval:approved': {
          subject: 'Doc {documentId} approved at level {level}',
          body: 'Comment: {comment}',
        },
      },
    });
    await adapter.notify(makeEvent());
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      channel: 'default',
      to: ['user-1'],
      subject: 'Doc doc-1 approved at level 2',
      body: 'Comment: looks good',
    });
  });

  it('function templates are supported', async () => {
    const sent: { subject: string; body: string }[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      templates: {
        'approval:approved': (e) => ({ subject: `S:${e.instanceId}`, body: `B:${e.type}` }),
      },
    });
    await adapter.notify(makeEvent());
    expect(sent[0]).toMatchObject({ subject: 'S:inst-1', body: 'B:approval:approved' });
  });

  it('unknown placeholder renders to the configured token (default empty), never throws', async () => {
    const sent: { subject: string }[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      templates: { 'approval:approved': { subject: '[{nope}]', body: '' } },
    });
    await adapter.notify(makeEvent());
    expect(sent[0]!.subject).toBe('[]');
  });

  it('uses a custom unknownPlaceholderToken', async () => {
    const sent: { subject: string }[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      unknownPlaceholderToken: 'N/A',
      templates: { 'approval:cancelled': { subject: 'reason={comment}', body: '' } },
    });
    await adapter.notify(makeEvent({ type: 'approval:cancelled', payload: { instanceId: 'x', documentId: 'd', documentType: 't', timestamp: new Date(), cancelledBy: 'u', reason: 'r' } as NotificationEvent['payload'] }));
    expect(sent[0]!.subject).toBe('reason=N/A');
  });

  it('Date placeholders render to ISO, arrays joined, objects JSON-stringified', async () => {
    const sent: { body: string }[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      templates: { 'approval:submitted': { subject: '', body: '{timestamp}|{currentApprovers}' } },
    });
    await adapter.notify(
      makeEvent({
        type: 'approval:submitted',
        timestamp: new Date('2026-01-02T03:04:05.000Z'),
        payload: {
          instanceId: 'i',
          documentId: 'd',
          documentType: 't',
          timestamp: new Date(),
          submittedBy: 'u',
          currentApprovers: ['a', 'b'],
        } as NotificationEvent['payload'],
      }),
    );
    expect(sent[0]!.body).toBe('2026-01-02T03:04:05.000Z|a, b');
  });

  it('missing template + no fallback => skip (no send, no throw)', async () => {
    const send = vi.fn();
    const logger = spyLogger();
    const adapter = new TemplatedNotificationAdapter({ send, templates: {}, logger });
    await adapter.notify(makeEvent());
    expect(send).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('missing per-event template uses fallbackTemplate', async () => {
    const sent: { subject: string }[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      fallbackTemplate: { subject: 'fallback {type}', body: '' },
    });
    await adapter.notify(makeEvent());
    expect(sent[0]!.subject).toBe('fallback approval:approved');
  });

  it('empty recipients with no defaultRecipients => skip gracefully', async () => {
    const send = vi.fn();
    const logger = spyLogger();
    const adapter = new TemplatedNotificationAdapter({
      send,
      templates: { 'approval:cancelled': { subject: 's', body: 'b' } },
      logger,
    });
    await adapter.notify(makeEvent({ type: 'approval:cancelled', recipients: [] }));
    expect(send).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalled();
  });

  it('empty recipients fall back to defaultRecipients', async () => {
    const sent: { to: string[] }[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      templates: { 'approval:cancelled': { subject: 's', body: 'b' } },
      defaultRecipients: ['ops@x.com'],
    });
    await adapter.notify(makeEvent({ type: 'approval:cancelled', recipients: [] }));
    expect(sent[0]!.to).toEqual(['ops@x.com']);
  });

  it('custom channelFor and recipientsFor are honored', async () => {
    const sent: { channel: string; to: string[] }[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      templates: { 'approval:approved': { subject: 's', body: 'b' } },
      channelFor: () => 'slack',
      recipientsFor: () => ['#approvals'],
    });
    await adapter.notify(makeEvent());
    expect(sent[0]).toMatchObject({ channel: 'slack', to: ['#approvals'] });
  });

  it('a send failure is caught and logged (never throws)', async () => {
    const logger = spyLogger();
    const adapter = new TemplatedNotificationAdapter({
      send: () => {
        throw new Error('send down');
      },
      templates: { 'approval:approved': { subject: 's', body: 'b' } },
      logger,
    });
    await expect(adapter.notify(makeEvent())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('payload field absent on a different event type interpolates safely (no throw)', async () => {
    const sent: { body: string }[] = [];
    const adapter = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      // 'cancelled' payload has no `comment` field.
      templates: { 'approval:cancelled': { subject: 's', body: 'c={comment}' } },
    });
    await adapter.notify(
      makeEvent({
        type: 'approval:cancelled',
        payload: { instanceId: 'i', documentId: 'd', documentType: 't', timestamp: new Date(), cancelledBy: 'u', reason: 'r' } as NotificationEvent['payload'],
      }),
    );
    expect(sent[0]!.body).toBe('c=');
  });
});

describe('Notify adapters compose end-to-end', () => {
  it('Composite over a Templated + Outbox both receive the event', async () => {
    const sent: unknown[] = [];
    const templated = new TemplatedNotificationAdapter({
      send: (m) => {
        sent.push(m);
      },
      templates: { 'approval:approved': { subject: 's', body: 'b' } },
    });
    const clock = new ManualClock(0);
    const outbox = new OutboxNotificationAdapter({ transport: () => {}, clock });
    const composite = new CompositeNotificationAdapter({ children: [templated, outbox] });
    await composite.notify(makeEvent());
    expect(sent).toHaveLength(1);
    expect(await outbox.pending()).toHaveLength(1);
  });
});
