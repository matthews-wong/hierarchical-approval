import { createHmac } from 'node:crypto';

import { describe, it, expect, vi } from 'vitest';

import {
  WebhookNotificationAdapter,
  WebhookDeliveryError,
  DEFAULT_SIGNATURE_HEADER,
  getDefaultHttpClient,
} from '../../../src/plugins/webhook/index.js';
import type { HttpClient } from '../../../src/plugins/webhook/index.js';
import { OutboxNotificationAdapter } from '../../../src/plugins/notify/index.js';
import type { NotificationEvent } from '../../../src/adapters/INotificationAdapter.js';
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

/** No-op sleep so retry/backoff tests never actually wait. */
const noSleep = async (_ms: number): Promise<void> => {};

/** Builds a real, runtime `Response` (Node 18+ global) for a fake HttpClient to return. */
function fakeResponse(status: number, headers?: Record<string, string>): Response {
  return new Response(null, { status, headers });
}

describe('WebhookNotificationAdapter — successful delivery', () => {
  it('POSTs the event as JSON with a content-type header and no signature when no secret is set', async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const client: HttpClient = async (url, init) => {
      calls.push([url, init]);
      return fakeResponse(200);
    };
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep: noSleep,
    });
    const event = makeEvent();
    await adapter.deliver(event);

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;
    expect(url).toBe('https://example.com/hook');
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify(event));
    const headers = init?.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(headers[DEFAULT_SIGNATURE_HEADER]).toBeUndefined();
  });

  it('merges configured static headers into every request', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const client: HttpClient = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return fakeResponse(200);
    };
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      headers: { authorization: 'Bearer token-123' },
      httpClient: client,
      sleep: noSleep,
    });
    await adapter.deliver(makeEvent());
    expect(capturedHeaders?.authorization).toBe('Bearer token-123');
  });

  it('constructs successfully without an explicit httpClient when a global fetch exists', () => {
    expect(() => new WebhookNotificationAdapter({ url: 'https://example.com/hook' })).not.toThrow();
  });
});

describe('WebhookNotificationAdapter — signing', () => {
  it('signs with HMAC-SHA256 over `<timestamp>.<body>` in t=,v1= form, verifiable independently', async () => {
    const clock = new ManualClock(1_700_000_000_000);
    let capturedHeaders: Record<string, string> | undefined;
    let capturedBody: string | undefined;
    const client: HttpClient = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      capturedBody = init?.body as string;
      return fakeResponse(200);
    };
    const secret = 'whsec_test_secret';
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      secret,
      clock,
      httpClient: client,
      sleep: noSleep,
    });
    await adapter.deliver(makeEvent());

    const header = capturedHeaders?.[DEFAULT_SIGNATURE_HEADER];
    expect(header).toBeDefined();
    const match = header!.match(/^t=(\d+),v1=([0-9a-f]+)$/);
    expect(match).not.toBeNull();
    const [, tStr, v1] = match!;
    expect(Number(tStr)).toBe(Math.floor(clock.now().getTime() / 1000));

    const independentDigest = createHmac('sha256', secret)
      .update(`${tStr}.${capturedBody}`)
      .digest('hex');
    expect(v1).toBe(independentDigest);
  });

  it('sends unsigned requests (no signature header) when no secret is configured', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const client: HttpClient = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return fakeResponse(200);
    };
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep: noSleep,
    });
    await adapter.deliver(makeEvent());
    expect(Object.keys(capturedHeaders ?? {})).not.toContain(DEFAULT_SIGNATURE_HEADER);
  });

  it('honors a custom signatureHeader name', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const client: HttpClient = async (_url, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return fakeResponse(200);
    };
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      secret: 's3cr3t',
      signatureHeader: 'X-Custom-Sig',
      httpClient: client,
      sleep: noSleep,
    });
    await adapter.deliver(makeEvent());
    expect(capturedHeaders?.['X-Custom-Sig']).toBeDefined();
    expect(capturedHeaders?.[DEFAULT_SIGNATURE_HEADER]).toBeUndefined();
  });
});

describe('WebhookNotificationAdapter — retry on transient failure', () => {
  it('retries a 500 response then succeeds, sleeping between attempts', async () => {
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      return calls < 3 ? fakeResponse(500) : fakeResponse(200);
    };
    const sleep = vi.fn(noSleep);
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep,
      maxAttempts: 5,
    });
    await adapter.deliver(makeEvent());
    expect(calls).toBe(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it('treats a network error the same as a retryable status', async () => {
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      if (calls < 2) throw new Error('ECONNRESET');
      return fakeResponse(200);
    };
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep: noSleep,
      maxAttempts: 3,
    });
    await expect(adapter.deliver(makeEvent())).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });
});

describe('WebhookNotificationAdapter — exhausted retries', () => {
  it('deliver() throws a typed WebhookDeliveryError after maxAttempts of persistent 500s', async () => {
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      return fakeResponse(500);
    };
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep: noSleep,
      maxAttempts: 4,
    });
    await expect(adapter.deliver(makeEvent())).rejects.toMatchObject({
      name: 'WebhookDeliveryError',
      status: 500,
      attempts: 4,
    });
    expect(calls).toBe(4);
  });

  it('notify() never throws: logs and swallows once retries are exhausted', async () => {
    const logger = spyLogger();
    const client: HttpClient = async () => fakeResponse(503);
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep: noSleep,
      maxAttempts: 2,
      logger,
    });
    await expect(adapter.notify(makeEvent())).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledOnce();
  });
});

describe('WebhookNotificationAdapter — non-retryable statuses', () => {
  it.each([400, 401, 403, 404, 422])(
    'status %d fails immediately without retrying',
    async (status) => {
      let calls = 0;
      const client: HttpClient = async () => {
        calls++;
        return fakeResponse(status);
      };
      const adapter = new WebhookNotificationAdapter({
        url: 'https://example.com/hook',
        httpClient: client,
        sleep: noSleep,
        maxAttempts: 5,
      });
      await expect(adapter.deliver(makeEvent())).rejects.toMatchObject({ status, attempts: 1 });
      expect(calls).toBe(1);
    },
  );
});

describe('WebhookNotificationAdapter — 429 Retry-After', () => {
  it('sleeps for the Retry-After seconds value instead of the computed backoff', async () => {
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      return calls === 1 ? fakeResponse(429, { 'Retry-After': '2' }) : fakeResponse(200);
    };
    const sleep = vi.fn(noSleep);
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep,
      maxAttempts: 3,
      // A huge base delay would dwarf 2s if Retry-After were not honored.
      baseDelayMs: 100_000,
    });
    await adapter.deliver(makeEvent());
    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('honors an HTTP-date Retry-After relative to the injected clock', async () => {
    const clock = new ManualClock(Date.parse('2026-01-01T00:00:00.000Z'));
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      return calls === 1
        ? fakeResponse(429, { 'Retry-After': 'Thu, 01 Jan 2026 00:00:05 GMT' })
        : fakeResponse(200);
    };
    const sleep = vi.fn(noSleep);
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep,
      clock,
      maxAttempts: 3,
    });
    await adapter.deliver(makeEvent());
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it('falls back to the computed backoff when a 429 carries no Retry-After', async () => {
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      return calls === 1 ? fakeResponse(429) : fakeResponse(200);
    };
    const sleep = vi.fn(noSleep);
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep,
      maxAttempts: 3,
      random: () => 1, // deterministic upper bound of the jitter window
      baseDelayMs: 50,
      backoffFactor: 2,
      maxDelayMs: 1000,
    });
    await adapter.deliver(makeEvent());
    expect(sleep).toHaveBeenCalledWith(50);
  });
});

describe('WebhookNotificationAdapter — timeout', () => {
  it('aborts a hanging request after timeoutMs and treats it as a retryable failure', async () => {
    let aborts = 0;
    const client: HttpClient = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          aborts++;
          reject(new Error('This operation was aborted'));
        });
      });
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep: noSleep,
      timeoutMs: 5,
      maxAttempts: 2,
    });
    await expect(adapter.deliver(makeEvent())).rejects.toMatchObject({
      name: 'WebhookDeliveryError',
      attempts: 2,
      status: undefined,
    });
    expect(aborts).toBe(2);
  });
});

describe('WebhookNotificationAdapter — secret hygiene', () => {
  it('never includes the secret in a thrown WebhookDeliveryError', async () => {
    const secret = 'super-secret-value-xyz';
    const client: HttpClient = async () => fakeResponse(401);
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      secret,
      httpClient: client,
      sleep: noSleep,
    });

    const err = await adapter.deliver(makeEvent()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WebhookDeliveryError);
    const serialized = JSON.stringify(err, Object.getOwnPropertyNames(err as object));
    expect(serialized).not.toContain(secret);
    expect((err as Error).message).not.toContain(secret);
  });

  it('never logs the secret when notify() swallows the final failure', async () => {
    const secret = 'super-secret-value-xyz';
    const logger = spyLogger();
    const client: HttpClient = async () => fakeResponse(401);
    const adapter = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      secret,
      httpClient: client,
      sleep: noSleep,
      logger,
    });
    await adapter.notify(makeEvent());
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret);
  });
});

describe('WebhookNotificationAdapter — composes with OutboxNotificationAdapter for durability', () => {
  it('deliver, bound, is a valid throwing Outbox transport (typed error drives retry/dead-letter)', async () => {
    const clock = new ManualClock(0);
    let calls = 0;
    const client: HttpClient = async () => {
      calls++;
      return fakeResponse(500);
    };
    const webhook = new WebhookNotificationAdapter({
      url: 'https://example.com/hook',
      httpClient: client,
      sleep: noSleep,
      maxAttempts: 1, // exhaust immediately so each Outbox drain sees exactly one throw
    });
    const outbox = new OutboxNotificationAdapter({
      transport: webhook.deliver.bind(webhook),
      clock,
      maxAttempts: 2,
      baseDelayMs: 1000,
    });

    await outbox.notify(makeEvent());
    expect(await outbox.drain()).toBe(0);
    expect((await outbox.pending())[0]!.attempts).toBe(1);

    clock.set(1000);
    expect(await outbox.drain()).toBe(0);
    expect(await outbox.deadLettered()).toHaveLength(1);
    expect(calls).toBe(2);
  });
});

describe('getDefaultHttpClient', () => {
  it('returns a callable bound to globalThis.fetch when a global fetch exists', () => {
    expect(typeof globalThis.fetch).toBe('function');
    expect(typeof getDefaultHttpClient()).toBe('function');
  });

  it('throws a clear error naming both fixes when no global fetch exists (simulated Node < 18)', () => {
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => getDefaultHttpClient()).toThrow(/no global `fetch`/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
