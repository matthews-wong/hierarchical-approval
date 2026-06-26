import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import type { INotificationAdapter, NotificationEvent } from '../../adapters/INotificationAdapter.js';

/** A child adapter paired with a stable name for diagnostics/logging. */
export interface NamedNotificationChild {
  /** Human-readable identity used when logging this child's failures. */
  name: string;
  adapter: INotificationAdapter;
}

/** Either a bare adapter or a {@link NamedNotificationChild}. */
export type CompositeChild = INotificationAdapter | NamedNotificationChild;

/** Configuration for {@link CompositeNotificationAdapter}. */
export interface CompositeNotificationAdapterOptions {
  /** Child adapters to fan out to. May be empty (resolves as a no-op). */
  children: CompositeChild[];
  /** Structured logger. Defaults to {@link noopLogger}. */
  logger?: Logger;
}

function isNamed(child: CompositeChild): child is NamedNotificationChild {
  // A real bare adapter always exposes its own notify(); never treat it as a
  // NamedNotificationChild even if it happens to also carry an `adapter` property.
  if (typeof (child as INotificationAdapter).notify === 'function') return false;
  // Otherwise it's a NamedNotificationChild only if it wraps a non-null `adapter`
  // object whose own `.notify` is callable.
  const adapter = (child as NamedNotificationChild).adapter as unknown;
  return (
    typeof adapter === 'object' &&
    adapter !== null &&
    typeof (adapter as INotificationAdapter).notify === 'function'
  );
}

/**
 * Fans a single {@link notify} call out to N child {@link INotificationAdapter}s
 * concurrently.
 *
 * Uses `Promise.allSettled` so one failing/slow child never blocks delivery to
 * the others. Never throws: every child rejection is collected and logged with
 * that child's identity. Zero children resolves immediately as a no-op.
 *
 * Drop-in for `ApprovalEngineOptions.notificationAdapter`.
 */
export class CompositeNotificationAdapter implements INotificationAdapter {
  private readonly children: NamedNotificationChild[];
  private readonly logger: Logger;

  constructor(options: CompositeNotificationAdapterOptions) {
    this.children = options.children.map((child, i) =>
      isNamed(child) ? child : { name: `child[${i}]`, adapter: child },
    );
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Deliver the event to every child concurrently. Resolves once all children
   * settle; never rejects.
   */
  async notify(event: NotificationEvent): Promise<void> {
    if (this.children.length === 0) return;

    const results = await Promise.allSettled(
      // Wrap each call so a synchronous throw inside a child's notify is also
      // captured as a rejection rather than escaping the fan-out.
      this.children.map((child) =>
        Promise.resolve().then(() => child.adapter.notify(event)),
      ),
    );

    results.forEach((result, i) => {
      if (result.status === 'rejected') {
        const child = this.children[i]!;
        this.logger.error('CompositeNotificationAdapter: child failed to notify', result.reason, {
          child: child.name,
          type: event.type,
          instanceId: event.instanceId,
          tenantId: event.tenantId,
        });
      }
    });
  }
}
