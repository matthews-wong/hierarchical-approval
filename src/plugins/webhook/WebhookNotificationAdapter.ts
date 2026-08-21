import { createHmac } from 'node:crypto';

import type { Clock } from '../../utils/Clock.js';
import { systemClock } from '../../utils/Clock.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import type {
  INotificationAdapter,
  NotificationEvent,
} from '../../adapters/INotificationAdapter.js';
import type { HttpClient } from './IHttpClient.js';
import { getDefaultHttpClient } from './IHttpClient.js';

/** Default header carrying the HMAC signature when `secret` is configured. */
export const DEFAULT_SIGNATURE_HEADER = 'X-Approval-Signature';

/** Default per-request timeout, in milliseconds, before the request is aborted. */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Default cap on delivery attempts inside a single {@link WebhookNotificationAdapter.deliver} call. */
const DEFAULT_MAX_ATTEMPTS = 3;

/** Default base backoff delay, in milliseconds, for the first retry. */
const DEFAULT_BASE_DELAY_MS = 300;

/** Default multiplier applied per attempt (exponential backoff). */
const DEFAULT_BACKOFF_FACTOR = 2;

/** Default cap on a single computed backoff delay, in milliseconds. */
const DEFAULT_MAX_DELAY_MS = 10_000;

/** HTTP status codes worth retrying: request timeout, rate-limited, and any server error. */
const RETRYABLE_STATUSES = new Set([408, 429]);

/** Sleeps for `ms` milliseconds using the real timer. Overridable via `options.sleep` in tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown by {@link WebhookNotificationAdapter.deliver} when delivery could not
 * be completed — either a non-retryable HTTP response (e.g. `4xx` other than
 * `408`/`429`) was received, or all retry attempts were exhausted.
 *
 * Never carries the signing secret: the message is built only from the HTTP
 * status and/or the underlying transport error's own message.
 */
export class WebhookDeliveryError extends Error {
  /** HTTP status of the last response received, if any (absent on a pure network/timeout failure). */
  readonly status?: number;
  /** Number of delivery attempts made before giving up. */
  readonly attempts: number;
  /**
   * The underlying network/timeout error that caused the final attempt to
   * fail, if delivery failed without ever receiving a response. Declared
   * explicitly (rather than relying on the ES2022 `Error.cause` option) since
   * this package targets ES2020.
   */
  readonly cause?: unknown;

  constructor(message: string, options: { status?: number; attempts: number; cause?: unknown }) {
    super(message);
    this.name = 'WebhookDeliveryError';
    this.status = options.status;
    this.attempts = options.attempts;
    this.cause = options.cause;
  }
}

/** Configuration for {@link WebhookNotificationAdapter}. */
export interface WebhookNotificationAdapterOptions {
  /** Destination URL every notification event is POSTed to as JSON. Required. */
  url: string;
  /** Extra static headers merged into every request (e.g. `Authorization`). */
  headers?: Record<string, string>;
  /**
   * Shared secret used to HMAC-SHA256-sign each request body. When omitted,
   * requests are sent unsigned. Never logged and never echoed in a thrown
   * error's message.
   */
  secret?: string;
  /** Header name the signature is emitted under. Defaults to {@link DEFAULT_SIGNATURE_HEADER}. */
  signatureHeader?: string;
  /** Per-request timeout in milliseconds before the request is aborted. Defaults to `10_000`. */
  timeoutMs?: number;
  /**
   * Maximum delivery attempts made by a single {@link deliver} call before
   * throwing {@link WebhookDeliveryError}. Must be >= 1. Defaults to `3`.
   *
   * This is a short, local retry budget for transient blips — it is not a
   * substitute for durable retry across process restarts. Compose with
   * {@link import('../notify/OutboxNotificationAdapter.js').OutboxNotificationAdapter}
   * for that (see the class doc).
   */
  maxAttempts?: number;
  /** Base backoff in milliseconds for the first retry. Defaults to `300`. */
  baseDelayMs?: number;
  /** Multiplier applied per attempt (exponential). Defaults to `2`. */
  backoffFactor?: number;
  /** Upper bound on a single computed backoff delay, in milliseconds. Defaults to `10_000`. */
  maxDelayMs?: number;
  /** Time source used for the signature timestamp and for resolving a `Retry-After` date. Defaults to {@link systemClock}. */
  clock?: Clock;
  /** Structured logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
  /** Fetch-shaped HTTP port. Defaults to {@link getDefaultHttpClient}. */
  httpClient?: HttpClient;
  /** Delay function used between retries. Defaults to a real `setTimeout`-based sleep; inject a no-op/fake in tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Source of randomness in `[0, 1)` used for jitter. Defaults to `Math.random`.
   * Inject a deterministic function in tests to assert exact backoff delays.
   */
  random?: () => number;
}

/**
 * {@link INotificationAdapter} that delivers each approval event as a signed,
 * JSON HTTP POST to a configured webhook URL.
 *
 * **Signing.** When `secret` is configured, every request carries a
 * `{signatureHeader}: t=<unix-seconds>,v1=<hex-hmac>` header (Stripe-style),
 * where the HMAC-SHA256 digest is computed over the signing string
 * `"<timestamp>.<body>"`. Folding the timestamp into the signed payload lets a
 * receiver reject stale/replayed requests by checking `t` against its own
 * clock before trusting `v1`. Signing is opt-in — omit `secret` to send
 * unsigned requests.
 *
 * **Retry.** `5xx` responses, `408`, `429`, and network/timeout errors are
 * retried with exponential backoff and full jitter, up to `maxAttempts`. A
 * `429` response honors a `Retry-After` header (seconds or an HTTP date) in
 * place of the computed backoff. Any other non-2xx status (e.g. `400`, `401`,
 * `404`) is treated as permanent and is not retried.
 *
 * **Durability.** `notify()` — the {@link INotificationAdapter} method — never
 * throws, per that port's contract: on exhausting `maxAttempts` it logs and
 * drops the notification. That makes this adapter, used alone, *at-most-once*
 * and blocking (it awaits the full retry sequence inline). For at-least-once
 * delivery that survives a process restart, do not reimplement dead-lettering
 * here — instead compose with
 * {@link import('../notify/OutboxNotificationAdapter.js').OutboxNotificationAdapter},
 * passing this adapter's throwing {@link deliver} method (bound) as its
 * `transport`:
 *
 * ```ts
 * const webhook = new WebhookNotificationAdapter({ url, secret });
 * const durable = new OutboxNotificationAdapter({ transport: webhook.deliver.bind(webhook) });
 * ```
 *
 * `deliver` and `NotificationTransport` (`(event) => void | Promise<void>`)
 * are structurally compatible, so this composition type-checks with no
 * adapter shim.
 *
 * **Security.** The signing secret is never included in a log message or in a
 * {@link WebhookDeliveryError}'s message/fields — only the HTTP status and/or
 * the underlying transport error's own message are surfaced.
 */
export class WebhookNotificationAdapter implements INotificationAdapter {
  private readonly url: string;
  private readonly staticHeaders: Record<string, string>;
  private readonly secret?: string;
  private readonly signatureHeader: string;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly backoffFactor: number;
  private readonly maxDelayMs: number;
  private readonly clock: Clock;
  private readonly logger: Logger;
  private readonly httpClient: HttpClient;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(options: WebhookNotificationAdapterOptions) {
    this.url = options.url;
    this.staticHeaders = options.headers ?? {};
    this.secret = options.secret;
    this.signatureHeader = options.signatureHeader ?? DEFAULT_SIGNATURE_HEADER;
    this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.baseDelayMs = Math.max(0, options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    this.backoffFactor = options.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
    this.maxDelayMs = Math.max(0, options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    this.clock = options.clock ?? systemClock;
    this.logger = options.logger ?? noopLogger;
    this.httpClient = options.httpClient ?? getDefaultHttpClient();
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /**
   * Deliver the event, retrying transient failures. Never throws per the
   * {@link INotificationAdapter} contract: on final failure the error is
   * logged (never with the secret) and swallowed.
   */
  async notify(event: NotificationEvent): Promise<void> {
    try {
      await this.deliver(event);
    } catch (err) {
      this.logger.error(
        'WebhookNotificationAdapter: giving up on delivery, dropping notification',
        err,
        {
          type: event.type,
          instanceId: event.instanceId,
          tenantId: event.tenantId,
          url: this.url,
        },
      );
    }
  }

  /**
   * POST `event` as JSON to the configured URL, retrying retryable failures
   * with exponential backoff + full jitter (honoring `Retry-After` on `429`)
   * up to `maxAttempts`.
   *
   * Unlike {@link notify}, this throws {@link WebhookDeliveryError} on final
   * failure rather than swallowing it — intentionally, so it can be composed
   * as a throwing `transport` for
   * {@link import('../notify/OutboxNotificationAdapter.js').OutboxNotificationAdapter}
   * (see the class doc).
   *
   * @throws {WebhookDeliveryError} If a non-retryable status is returned, or
   *   `maxAttempts` is exhausted.
   */
  async deliver(event: NotificationEvent): Promise<void> {
    const body = JSON.stringify(event);
    const headers = this.buildHeaders(body);

    let attempt = 0;
    for (;;) {
      attempt++;
      let response: Response | undefined;
      let networkError: unknown;

      try {
        response = await this.performRequest(body, headers);
      } catch (err) {
        networkError = err;
      }

      if (response && this.isSuccessStatus(response.status)) {
        return;
      }

      const retryable = response ? this.isRetryableStatus(response.status) : true;
      const exhausted = attempt >= this.maxAttempts;

      if (!retryable || exhausted) {
        throw this.buildError(attempt, response, networkError);
      }

      const delayMs = response
        ? this.retryDelayForResponse(response, attempt)
        : this.computeBackoff(attempt);
      await this.sleep(delayMs);
    }
  }

  /** Issues one POST attempt with an `AbortController`-backed timeout. */
  private async performRequest(body: string, headers: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.httpClient(this.url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** Builds request headers: content-type, static headers, then the signature (always wins). */
  private buildHeaders(body: string): Record<string, string> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.staticHeaders,
    };
    if (this.secret) {
      const timestampSeconds = Math.floor(this.clock.now().getTime() / 1000);
      const signingString = `${timestampSeconds}.${body}`;
      const signature = createHmac('sha256', this.secret).update(signingString).digest('hex');
      headers[this.signatureHeader] = `t=${timestampSeconds},v1=${signature}`;
    }
    return headers;
  }

  /** `2xx` is success. */
  private isSuccessStatus(status: number): boolean {
    return status >= 200 && status < 300;
  }

  /** `5xx`, `408` (request timeout), and `429` (rate limited) are worth retrying; other `4xx` are not. */
  private isRetryableStatus(status: number): boolean {
    return status >= 500 || RETRYABLE_STATUSES.has(status);
  }

  /** Delay before the next attempt for a retryable response: `Retry-After` on 429, else computed backoff. */
  private retryDelayForResponse(response: Response, attempt: number): number {
    if (response.status === 429) {
      const retryAfterMs = this.parseRetryAfterMs(response);
      if (retryAfterMs !== undefined) return retryAfterMs;
    }
    return this.computeBackoff(attempt);
  }

  /**
   * Parses a `Retry-After` header (delay-seconds or an HTTP date) into a
   * millisecond delay measured from the injected {@link Clock}. Returns
   * `undefined` when absent or unparseable.
   */
  private parseRetryAfterMs(response: Response): number | undefined {
    const header = response.headers.get('retry-after');
    if (!header) return undefined;

    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

    const dateMs = Date.parse(header);
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - this.clock.now().getTime());

    return undefined;
  }

  /**
   * Exponential backoff for the Nth attempt (1-based) with full jitter —
   * uniformly random in `[0, cap]` — capped at `maxDelayMs`. A non-finite or
   * negative intermediate value (extreme attempt counts) collapses to the cap
   * rather than overflowing to `Infinity`/`NaN`.
   */
  private computeBackoff(attempt: number): number {
    const raw = this.baseDelayMs * Math.pow(this.backoffFactor, attempt - 1);
    const cap = !Number.isFinite(raw) || raw < 0 ? this.maxDelayMs : Math.min(raw, this.maxDelayMs);
    return Math.floor(this.random() * cap);
  }

  /** Builds the final {@link WebhookDeliveryError} — never includes the secret. */
  private buildError(
    attempt: number,
    response: Response | undefined,
    networkError: unknown,
  ): WebhookDeliveryError {
    if (response) {
      return new WebhookDeliveryError(
        `WebhookNotificationAdapter: delivery failed after ${attempt} attempt(s) with status ${response.status}`,
        { status: response.status, attempts: attempt },
      );
    }
    const message = networkError instanceof Error ? networkError.message : String(networkError);
    return new WebhookDeliveryError(
      `WebhookNotificationAdapter: delivery failed after ${attempt} attempt(s): ${message}`,
      {
        attempts: attempt,
        cause: networkError,
      },
    );
  }
}
