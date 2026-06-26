import { createHash } from 'node:crypto';
import type { IAuditAdapter } from '../../adapters/IAuditAdapter.js';
import type { AuditEntry, ApprovalInstance } from '../../types/index.js';
import type { Logger } from '../../utils/Logger.js';
import { noopLogger } from '../../utils/Logger.js';
import { canonicalize, CircularReferenceError } from './canonicalize.js';

/** The fixed sentinel used as the previous-hash of the genesis (first) entry. */
export const GENESIS_PREV_HASH = '0'.repeat(64);

/** A single persisted record in a hash chain. The shape is intentionally exact. */
export interface ChainRecord {
  /** The original audit entry, captured verbatim. */
  readonly entry: AuditEntry;
  /** SHA-256 (hex) over the canonical serialization of `{ seq, prevHash, entry }`. */
  readonly hash: string;
  /** The `hash` of the preceding record, or {@link GENESIS_PREV_HASH} for the first. */
  readonly prevHash: string;
  /** Monotonic sequence number within this (tenant, instance) chain. */
  readonly seq: number;
}

/**
 * Persists a single chain record. Implementations may target any durable sink
 * (Kafka, S3 WORM bucket, append-only table, …). The record's `(tenantId, instanceId)`
 * is supplied alongside it so the sink can partition without inferring identity from
 * the entry. The adapter awaits this writer but tolerates rejection: a failed write
 * is logged and swallowed.
 */
export type ChainRecordWriter = (
  tenantId: string,
  instanceId: string,
  record: ChainRecord,
) => Promise<void>;

/** Reads back the ordered chain for a (tenant, instance). */
export type ChainRecordReader = (
  tenantId: string,
  instanceId: string,
) => Promise<readonly ChainRecord[]>;

/** Result of {@link HashChainAuditAdapter.verify}. */
export interface VerifyResult {
  /** True when every record's hash and linkage recompute correctly. */
  ok: boolean;
  /**
   * The lowest `seq` whose stored hash or `prevHash` linkage failed, or — for a
   * tail truncation — the first missing `seq` (the gap point at the end of the
   * chain). Present only when `ok` is false.
   */
  brokenAt?: number;
}

/** Constructor options for {@link HashChainAuditAdapter}. */
export interface HashChainAuditAdapterOptions {
  /**
   * Async sink for each persisted record. Defaults to an internal in-memory store.
   * If you supply a custom `writer`, also supply a matching {@link reader} so the
   * adapter can recompute the chain during {@link HashChainAuditAdapter.verify}.
   */
  writer?: ChainRecordWriter;
  /** Reads back the ordered chain for verification. Required when a custom `writer` is supplied. */
  reader?: ChainRecordReader;
  /** Structured logger; defaults to a no-op logger. */
  logger?: Logger;
}

/** The composite chain key (tenant + instance) never collides across tenants or instances. */
function chainKey(tenantId: string, instanceId: string): string {
  // Length-prefix the tenant id so that ("a", "b:c") and ("a:b", "c") cannot collide.
  return `${tenantId.length}:${tenantId}:${instanceId}`;
}

/**
 * Tamper-evident {@link IAuditAdapter}. Every appended entry is wrapped in a
 * {@link ChainRecord} whose `hash` is a SHA-256 over a canonical serialization of
 * `{ seq, prevHash, entry }`, with `prevHash` linking to the previous record's hash.
 * Any later mutation, deletion, or reordering of a record breaks the recomputed
 * chain, which {@link verify} detects and pinpoints.
 *
 * Chains are partitioned by `(tenantId, instanceId)`: separate instances or tenants
 * never share a sequence counter or hash linkage. Appends to the same chain are
 * serialized so concurrent calls cannot interleave `seq`/`prevHash`.
 *
 * **Tail-truncation detection.** A pure re-hash of the stored chain cannot, on its
 * own, detect that the *last* record(s) were dropped: a truncated prefix still
 * re-hashes and re-links perfectly. To close this gap the adapter records an
 * in-process **high-water mark** per `(tenantId, instanceId)` — the highest `seq`
 * it has ever appended (advanced before the writer is awaited). {@link verify}
 * compares the stored chain's last `seq` against this high-water mark and reports
 * `{ ok: false, brokenAt: <first missing seq> }` when the tail is short. Callers
 * who hold an external anchor (e.g. a durably persisted length) may also pass
 * `expectedLength` to {@link verify} to assert truncation **across process
 * restarts**, when the in-process high-water mark has been lost.
 *
 * *Limit:* with neither an in-process high-water mark (e.g. a fresh process that
 * never appended to this chain) nor an `expectedLength` argument, truncation of
 * the tail is undetectable — there is no record of how long the chain *should* be.
 *
 * `append` never throws: writer rejections and canonicalization failures are logged
 * and swallowed, honoring the {@link IAuditAdapter} must-not-throw contract.
 *
 * @example
 * ```ts
 * const audit = new HashChainAuditAdapter();
 * // ...wire as ApprovalEngineOptions.auditAdapter...
 * const result = await audit.verify(tenantId, instanceId); // { ok: true }
 * ```
 */
export class HashChainAuditAdapter implements IAuditAdapter {
  private readonly writer: ChainRecordWriter;
  private readonly reader: ChainRecordReader;
  private readonly logger: Logger;

  /** In-memory default store, keyed by composite chain key. Used only when no custom writer/reader. */
  private readonly store = new Map<string, ChainRecord[]>();
  /**
   * Last hash + seq per chain key, tracked in-process so the next append links
   * without re-reading the sink. The `seq` field doubles as the per-chain
   * **high-water mark**: the highest `seq` ever appended in this process, which
   * {@link verify} uses to detect a truncated tail.
   */
  private readonly heads = new Map<string, { prevHash: string; seq: number }>();
  /** Per-chain promise tail used to serialize appends to the same (tenant, instance). */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(options: HashChainAuditAdapterOptions = {}) {
    this.logger = options.logger ?? noopLogger;

    if (options.writer && !options.reader) {
      // A custom sink with no reader cannot be verified; fail fast at construction
      // rather than silently producing a chain that verify() cannot inspect.
      throw new Error(
        'HashChainAuditAdapter: a custom `writer` requires a matching `reader` for verification.',
      );
    }

    this.writer =
      options.writer ??
      (async (tenantId, instanceId, record) => {
        const key = chainKey(tenantId, instanceId);
        const chain = this.store.get(key);
        if (chain) {
          chain.push(record);
        } else {
          this.store.set(key, [record]);
        }
      });

    this.reader =
      options.reader ??
      (async (tenantId, instanceId) => this.store.get(chainKey(tenantId, instanceId)) ?? []);
  }

  /**
   * Append an entry to the (tenant, instance) chain. Computes the next `seq` and
   * `prevHash`, hashes the canonical record, and persists via the injected writer.
   * Never throws.
   */
  async append(
    tenantId: string,
    instanceId: string,
    entry: AuditEntry,
    _instance: Readonly<ApprovalInstance>,
  ): Promise<void> {
    const key = chainKey(tenantId, instanceId);

    // Serialize per-chain: chain the work onto the existing tail so two concurrent
    // appends to the same (tenant, instance) cannot read the same head.
    const prior = this.locks.get(key) ?? Promise.resolve();
    const work = prior.then(() => this.appendLocked(key, tenantId, instanceId, entry));
    // The lock tail must never reject (it would poison every subsequent append).
    this.locks.set(
      key,
      work.then(
        () => undefined,
        () => undefined,
      ),
    );
    await work;
  }

  private async appendLocked(
    key: string,
    tenantId: string,
    instanceId: string,
    entry: AuditEntry,
  ): Promise<void> {
    try {
      const head = this.heads.get(key);
      const seq = head ? head.seq + 1 : 0;
      const prevHash = head ? head.prevHash : GENESIS_PREV_HASH;

      const hash = this.computeHash(seq, prevHash, entry);
      const record: ChainRecord = Object.freeze({ entry, hash, prevHash, seq });

      // Advance the in-process head BEFORE awaiting the writer so a slow or failing
      // writer cannot cause the next append to reuse this seq/prevHash. The chain's
      // logical integrity is independent of whether the sink durably accepted it.
      this.heads.set(key, { prevHash: hash, seq });

      try {
        await this.writer(tenantId, instanceId, record);
      } catch (err) {
        // Writer failure (including on the genesis entry) is logged and swallowed.
        // The in-process head already advanced, so subsequent appends stay linked;
        // if the sink dropped this record, verify() will surface the gap deterministically.
        this.logger.error(
          'HashChainAuditAdapter: writer rejected; entry not durably persisted',
          err,
          { tenantId, instanceId, seq },
        );
      }
    } catch (err) {
      // Canonicalization/hashing failure (e.g. circular reference). Swallow per contract.
      if (err instanceof CircularReferenceError) {
        this.logger.error('HashChainAuditAdapter: entry could not be canonicalized', err, {
          tenantId,
          instanceId,
        });
      } else {
        this.logger.error('HashChainAuditAdapter: unexpected error during append', err, {
          tenantId,
          instanceId,
        });
      }
    }
  }

  /** Compute the SHA-256 (hex) hash for a record's `{ seq, prevHash, entry }`. */
  private computeHash(seq: number, prevHash: string, entry: AuditEntry): string {
    const canonical = canonicalize({ seq, prevHash, entry });
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }

  /**
   * Recompute the entire chain for `(tenantId, instanceId)` from genesis and,
   * additionally, detect a truncated tail.
   *
   * Per-record integrity (tamper, deletion, reorder, broken linkage) is found by
   * re-hashing and re-linking from genesis. Tail truncation — dropping the last
   * record(s) — leaves a perfectly self-consistent prefix, so it is detected by
   * comparing the chain's last `seq` against an **expected high-water mark**:
   *
   * - `expectedLength`, when supplied, is the authoritative expected record count
   *   (so the expected high-water `seq` is `expectedLength - 1`). Use this with an
   *   external anchor to assert truncation even across process restarts.
   * - otherwise the in-process high-water mark recorded by {@link append} is used.
   *
   * When the stored chain is shorter than expected, `brokenAt` is the first
   * missing `seq` (the gap point at the tail). With neither an `expectedLength`
   * argument nor an in-process high-water mark, a truncated tail is undetectable.
   *
   * @param tenantId - Tenant partition.
   * @param instanceId - Instance partition.
   * @param expectedLength - Optional external anchor: the number of records the
   *   chain is expected to contain. When provided it overrides the in-process
   *   high-water mark for the truncation check.
   * @returns `{ ok: true }` for an untouched chain (and an empty chain when no
   *   high-water mark/`expectedLength` says otherwise), otherwise
   *   `{ ok: false, brokenAt }`.
   */
  async verify(
    tenantId: string,
    instanceId: string,
    expectedLength?: number,
  ): Promise<VerifyResult> {
    const key = chainKey(tenantId, instanceId);
    const chain = await this.reader(tenantId, instanceId);

    // Resolve the expected number of records: the explicit anchor wins; otherwise
    // fall back to the in-process high-water mark (highest appended seq + 1).
    let expectedCount: number | undefined;
    if (expectedLength !== undefined) {
      expectedCount = expectedLength;
    } else {
      const head = this.heads.get(key);
      if (head !== undefined) expectedCount = head.seq + 1;
    }

    // Empty chain: only "ok" if nothing was expected. If an anchor/high-water
    // mark says records should exist, the entire tail was truncated.
    if (chain.length === 0) {
      if (expectedCount !== undefined && expectedCount > 0) {
        return { ok: false, brokenAt: 0 };
      }
      return { ok: true };
    }

    let expectedPrev = GENESIS_PREV_HASH;
    for (let i = 0; i < chain.length; i++) {
      const record = chain[i]!;

      // Sequence must start at 0 and increment by exactly 1 (detects deletion/reorder/gap).
      if (record.seq !== i) return { ok: false, brokenAt: Math.min(record.seq, i) };

      // Linkage to the previous record's hash must hold.
      if (record.prevHash !== expectedPrev) return { ok: false, brokenAt: record.seq };

      // The stored hash must equal the recomputed hash of its content (detects tamper).
      let recomputed: string;
      try {
        recomputed = this.computeHash(record.seq, record.prevHash, record.entry);
      } catch {
        return { ok: false, brokenAt: record.seq };
      }
      if (recomputed !== record.hash) return { ok: false, brokenAt: record.seq };

      expectedPrev = record.hash;
    }

    // Tail-truncation check: the per-record loop above cannot see records that are
    // simply absent from the end. Compare the actual length against the expected
    // high-water mark; a short chain means the tail was dropped.
    if (expectedCount !== undefined && chain.length < expectedCount) {
      return { ok: false, brokenAt: chain.length };
    }

    return { ok: true };
  }

  /**
   * Read the ordered chain for `(tenantId, instanceId)`. Returns whatever the
   * configured reader yields (the default in-memory reader returns the live array;
   * callers should treat it as read-only).
   */
  async getChain(tenantId: string, instanceId: string): Promise<readonly ChainRecord[]> {
    return this.reader(tenantId, instanceId);
  }
}
