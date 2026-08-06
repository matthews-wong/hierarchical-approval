import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import type { ApprovalEventName } from '../../types/events.js';
import type { INotificationAdapter, NotificationEvent } from '../../adapters/INotificationAdapter.js';

/** The fully rendered, channel-ready message handed to the send fn. */
export interface RenderedNotification {
  /** Logical delivery channel (e.g. 'email', 'slack', 'sms'). */
  channel: string;
  /** Resolved recipient address(es) for the channel. */
  to: string[];
  /** Short headline / email subject. */
  subject: string;
  /** Human-readable body. */
  body: string;
}

/** The shape a template function returns (channel/to are derived separately). */
export interface RenderedMessage {
  subject: string;
  body: string;
}

/**
 * A template entry for one {@link ApprovalEventName}. Either:
 *  - a function `(event) => { subject, body }`, for full programmatic control, or
 *  - a `{ subject, body }` pair of strings with `{placeholder}` tokens that are
 *    interpolated from the event and its payload.
 */
export type NotificationTemplate =
  | ((event: NotificationEvent) => RenderedMessage)
  | { subject: string; body: string };

/** Map of event name → template. Any subset of events may be configured. */
export type TemplateMap = Partial<Record<ApprovalEventName, NotificationTemplate>>;

/** Side-effecting send function the adapter forwards rendered messages to. */
export type SendFn = (message: RenderedNotification) => void | Promise<void>;

/** Configuration for {@link TemplatedNotificationAdapter}. */
export interface TemplatedNotificationAdapterOptions {
  /** Side-effecting send function. Required. */
  send: SendFn;
  /** Per-event templates. Events without an entry use {@link fallbackTemplate} (if any). */
  templates?: TemplateMap;
  /**
   * Template used when no per-event entry exists. If omitted, events without a
   * template are skipped (logged) rather than throwing. Set to a function or a
   * `{subject, body}` string pair to guarantee a message for every event.
   */
  fallbackTemplate?: NotificationTemplate;
  /**
   * Derive the channel for an event. Defaults to the constant `'default'`.
   */
  channelFor?: (event: NotificationEvent) => string;
  /**
   * Derive recipient address(es). Defaults to `event.recipients`. When this
   * returns an empty array the adapter falls back to {@link defaultRecipients}
   * (if set) and otherwise skips the send gracefully.
   */
  recipientsFor?: (event: NotificationEvent) => string[];
  /**
   * Recipients used when {@link recipientsFor} yields none (e.g. cancelled /
   * expired / sla_breached events carry empty `recipients`). If also empty the
   * send is skipped rather than dispatched to nobody.
   */
  defaultRecipients?: string[];
  /**
   * Token substituted for a `{placeholder}` that resolves to `undefined`/`null`
   * or references a field absent on the payload. Defaults to `''` (empty
   * string). Interpolation never throws on unknown placeholders.
   */
  unknownPlaceholderToken?: string;
  /** Structured logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
}

const PLACEHOLDER = /\{([^{}]+)\}/g;

/**
 * Renders a human-readable message per {@link ApprovalEventName} from a
 * configurable template map and forwards `{ channel, to, subject, body }` to an
 * injected send function.
 *
 * Templates are resolved by event name; a missing template falls back to
 * `fallbackTemplate` or — if none is configured — the event is skipped (logged)
 * rather than throwing. String templates support `{placeholder}` interpolation
 * pulled from top-level event fields and `event.payload` fields; an unknown or
 * absent field renders to `unknownPlaceholderToken` and never throws.
 *
 * `notify()` never throws — send errors and any rendering issues are caught and
 * logged. Drop-in for `ApprovalEngineOptions.notificationAdapter`.
 */
export class TemplatedNotificationAdapter implements INotificationAdapter {
  private readonly send: SendFn;
  private readonly templates: TemplateMap;
  private readonly fallbackTemplate?: NotificationTemplate;
  private readonly channelFor: (event: NotificationEvent) => string;
  private readonly recipientsFor: (event: NotificationEvent) => string[];
  private readonly defaultRecipients: string[];
  private readonly unknownPlaceholderToken: string;
  private readonly logger: Logger;

  constructor(options: TemplatedNotificationAdapterOptions) {
    this.send = options.send;
    this.templates = options.templates ?? {};
    this.fallbackTemplate = options.fallbackTemplate;
    this.channelFor = options.channelFor ?? (() => 'default');
    this.recipientsFor = options.recipientsFor ?? ((event) => event.recipients ?? []);
    this.defaultRecipients = options.defaultRecipients ?? [];
    this.unknownPlaceholderToken = options.unknownPlaceholderToken ?? '';
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Render and dispatch the event. Never throws: missing templates, empty
   * recipients, and send failures are all handled and logged.
   */
  async notify(event: NotificationEvent): Promise<void> {
    try {
      const template = this.templates[event.type] ?? this.fallbackTemplate;
      if (!template) {
        this.logger.debug('TemplatedNotificationAdapter: no template for event, skipping', {
          type: event.type,
          instanceId: event.instanceId,
        });
        return;
      }

      const to = this.resolveRecipients(event);
      if (to.length === 0) {
        this.logger.debug('TemplatedNotificationAdapter: no recipients for event, skipping', {
          type: event.type,
          instanceId: event.instanceId,
        });
        return;
      }

      const rendered = this.render(template, event);
      const message: RenderedNotification = {
        channel: this.channelFor(event),
        to,
        subject: rendered.subject,
        body: rendered.body,
      };

      await this.send(message);
    } catch (err) {
      this.logger.error('TemplatedNotificationAdapter: failed to render/send notification', err, {
        type: event.type,
        instanceId: event.instanceId,
        tenantId: event.tenantId,
      });
    }
  }

  private resolveRecipients(event: NotificationEvent): string[] {
    const derived = this.recipientsFor(event);
    if (derived.length > 0) return derived;
    return this.defaultRecipients;
  }

  private render(template: NotificationTemplate, event: NotificationEvent): RenderedMessage {
    if (typeof template === 'function') {
      return template(event);
    }
    return {
      subject: this.interpolate(template.subject, event),
      body: this.interpolate(template.body, event),
    };
  }

  /**
   * Replace `{token}` occurrences in `text`. A token is resolved against
   * top-level event fields first, then `event.payload`. Dotted paths
   * (`payload.level`, `a.b.c`) are supported. Anything unresolved renders to
   * `unknownPlaceholderToken`. Never throws.
   */
  private interpolate(text: string, event: NotificationEvent): string {
    return text.replace(PLACEHOLDER, (_match, rawKey: string) => {
      const key = rawKey.trim();
      const value = this.lookup(event, key);
      if (value === undefined || value === null) return this.unknownPlaceholderToken;
      return this.stringify(value);
    });
  }

  /** Resolve a (possibly dotted) key against the event then its payload. */
  private lookup(event: NotificationEvent, key: string): unknown {
    const fromEvent = this.dig(event as unknown as Record<string, unknown>, key);
    if (fromEvent !== undefined) return fromEvent;
    return this.dig(event.payload as unknown as Record<string, unknown>, key);
  }

  private dig(root: Record<string, unknown> | undefined, path: string): unknown {
    if (!root) return undefined;
    let current: unknown = root;
    for (const segment of path.split('.')) {
      if (current === null || typeof current !== 'object') return undefined;
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  }

  private stringify(value: unknown): string {
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.map((v) => this.stringify(v)).join(', ');
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value);
      } catch {
        return this.unknownPlaceholderToken;
      }
    }
    return String(value);
  }
}
