import type { IAuditAdapter } from '../../adapters/IAuditAdapter.js';
import type { AuditEntry, ApprovalInstance } from '../../types/index.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';

/** A child adapter, optionally tagged with a stable identity for diagnostics. */
export interface CompositeChild {
  /** Human-readable identity used in logs when this child rejects (defaults to its index). */
  id?: string;
  adapter: IAuditAdapter;
}

/** Constructor options for {@link CompositeAuditAdapter}. */
export interface CompositeAuditAdapterOptions {
  /**
   * Child adapters to fan out to. Each may be a bare {@link IAuditAdapter} or a
   * {@link CompositeChild} carrying an `id` for clearer log attribution.
   */
  children: ReadonlyArray<IAuditAdapter | CompositeChild>;
  /** Structured logger; defaults to a no-op logger. */
  logger?: Logger;
}

function normalize(
  child: IAuditAdapter | CompositeChild,
  index: number,
): { id: string; adapter: IAuditAdapter } {
  if ('adapter' in child) {
    return { id: child.id ?? `child[${index}]`, adapter: child.adapter };
  }
  return { id: `child[${index}]`, adapter: child };
}

/**
 * An {@link IAuditAdapter} that fans `append` out to N child adapters concurrently.
 * Every child receives the same entry. The call awaits all children
 * ({@link Promise.allSettled}) and never throws: a rejecting child is logged with
 * its index/identity and does not prevent the other children from receiving the
 * entry. A composite with zero children is a no-op that resolves immediately.
 *
 * @example
 * ```ts
 * const audit = new CompositeAuditAdapter({
 *   children: [
 *     { id: 'hash-chain', adapter: new HashChainAuditAdapter() },
 *     { id: 's3-worm', adapter: s3Adapter },
 *   ],
 * });
 * ```
 */
export class CompositeAuditAdapter implements IAuditAdapter {
  private readonly children: ReadonlyArray<{ id: string; adapter: IAuditAdapter }>;
  private readonly logger: Logger;

  constructor(options: CompositeAuditAdapterOptions) {
    this.logger = options.logger ?? noopLogger;
    this.children = options.children.map(normalize);
  }

  /**
   * Fan the entry out to every child concurrently and await all of them. Never
   * throws; each child rejection is caught and logged with the child's identity.
   */
  async append(
    tenantId: string,
    instanceId: string,
    entry: AuditEntry,
    instance: Readonly<ApprovalInstance>,
  ): Promise<void> {
    if (this.children.length === 0) return;

    const results = await Promise.allSettled(
      // Wrap each child in Promise.resolve().then(...) so a child that throws
      // synchronously (rather than returning a rejected promise) is still captured.
      this.children.map((c) =>
        Promise.resolve().then(() => c.adapter.append(tenantId, instanceId, entry, instance)),
      ),
    );

    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === 'rejected') {
        const child = this.children[i]!;
        this.logger.error(
          `CompositeAuditAdapter: child "${child.id}" failed to append`,
          result.reason,
          { tenantId, instanceId, childId: child.id, childIndex: i },
        );
      }
    }
  }
}
