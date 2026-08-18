import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalize,
  CircularReferenceError,
  HashChainAuditAdapter,
  GENESIS_PREV_HASH,
  RedactingAuditAdapter,
  DEFAULT_REDACTION_MASK,
  CompositeAuditAdapter,
  type ChainRecord,
} from '../../../src/plugins/audit/index.js';
import type { IAuditAdapter } from '../../../src/adapters/IAuditAdapter.js';
import type { AuditEntry } from '../../../src/types/index.js';
import { spyLogger, makeEntry, makeInstance } from './_helpers.js';

const INST = makeInstance();

describe('canonicalize', () => {
  it('sorts object keys lexicographically and is order-independent', () => {
    const a = canonicalize({ b: 1, a: 2, c: 3 });
    const b = canonicalize({ c: 3, a: 2, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":2,"b":1,"c":3}');
  });

  it('sorts keys recursively in nested objects', () => {
    const s = canonicalize({ outer: { z: 1, a: 2 } });
    expect(s).toBe('{"outer":{"a":2,"z":1}}');
  });

  it('serializes Date to its ISO string', () => {
    const d = new Date('2026-06-26T10:00:00.000Z');
    expect(canonicalize({ d })).toBe('{"d":"2026-06-26T10:00:00.000Z"}');
  });

  it('encodes top-level undefined and null as null', () => {
    expect(canonicalize(undefined)).toBe('null');
    expect(canonicalize(null)).toBe('null');
  });

  it('drops undefined object properties (mirrors JSON.stringify)', () => {
    expect(canonicalize({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('encodes undefined array elements as null (preserving position)', () => {
    expect(canonicalize([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('encodes bigint as a decimal string', () => {
    expect(canonicalize({ n: 10n })).toBe('{"n":"10"}');
  });

  it('encodes functions and symbols as null', () => {
    expect(canonicalize({ f: () => 1, s: Symbol('x'), keep: 2 })).toBe('{"f":null,"keep":2,"s":null}');
  });

  it('encodes non-finite numbers as null', () => {
    expect(canonicalize({ a: Infinity, b: NaN, c: -Infinity })).toBe('{"a":null,"b":null,"c":null}');
  });

  it('throws CircularReferenceError on a cyclic object', () => {
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(() => canonicalize(o)).toThrow(CircularReferenceError);
  });

  it('throws CircularReferenceError on a cyclic array', () => {
    const arr: unknown[] = [1];
    arr.push(arr);
    expect(() => canonicalize(arr)).toThrow(CircularReferenceError);
  });

  it('does not treat the same object appearing twice (non-cyclic) as a cycle', () => {
    const shared = { x: 1 };
    expect(() => canonicalize({ a: shared, b: shared })).not.toThrow();
  });
});

describe('HashChainAuditAdapter — basic chaining', () => {
  it('genesis entry uses GENESIS_PREV_HASH and seq 0', async () => {
    const adapter = new HashChainAuditAdapter();
    await adapter.append('t', 'i', makeEntry(), INST);
    const chain = await adapter.getChain('t', 'i');
    expect(chain).toHaveLength(1);
    expect(chain[0]!.seq).toBe(0);
    expect(chain[0]!.prevHash).toBe(GENESIS_PREV_HASH);
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
  });

  it('computes SHA-256 over canonicalize({seq, prevHash, entry}) using node:crypto', async () => {
    const adapter = new HashChainAuditAdapter();
    const entry = makeEntry();
    await adapter.append('t', 'i', entry, INST);
    const chain = await adapter.getChain('t', 'i');
    const expected = createHash('sha256')
      .update(canonicalize({ seq: 0, prevHash: GENESIS_PREV_HASH, entry }), 'utf8')
      .digest('hex');
    expect(chain[0]!.hash).toBe(expected);
  });

  it('increments seq by exactly 1 and links prevHash to the prior hash', async () => {
    const adapter = new HashChainAuditAdapter();
    await adapter.append('t', 'i', makeEntry({ actorId: 'a' }), INST);
    await adapter.append('t', 'i', makeEntry({ actorId: 'b' }), INST);
    await adapter.append('t', 'i', makeEntry({ actorId: 'c' }), INST);
    const chain = await adapter.getChain('t', 'i');
    expect(chain.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(chain[1]!.prevHash).toBe(chain[0]!.hash);
    expect(chain[2]!.prevHash).toBe(chain[1]!.hash);
  });

  it('each persisted record is exactly { entry, hash, prevHash, seq }', async () => {
    const adapter = new HashChainAuditAdapter();
    await adapter.append('t', 'i', makeEntry(), INST);
    const chain = await adapter.getChain('t', 'i');
    expect(Object.keys(chain[0]!).sort()).toEqual(['entry', 'hash', 'prevHash', 'seq']);
  });
});

describe('HashChainAuditAdapter — verify', () => {
  it('returns ok:true for an untouched chain', async () => {
    const adapter = new HashChainAuditAdapter();
    await adapter.append('t', 'i', makeEntry({ actorId: 'a' }), INST);
    await adapter.append('t', 'i', makeEntry({ actorId: 'b' }), INST);
    expect(await adapter.verify('t', 'i')).toEqual({ ok: true });
  });

  it('returns ok:true (vacuously) for an empty chain', async () => {
    const adapter = new HashChainAuditAdapter();
    expect(await adapter.verify('t', 'never-appended')).toEqual({ ok: true });
  });

  it('detects content tampering and reports the lowest broken seq', async () => {
    const store = new Map<string, ChainRecord[]>();
    const adapter = new HashChainAuditAdapter({
      writer: async (t, i, r) => {
        const k = `${t}:${i}`;
        (store.get(k) ?? store.set(k, []).get(k)!).push(r);
      },
      reader: async (t, i) => store.get(`${t}:${i}`) ?? [],
    });
    await adapter.append('t', 'i', makeEntry({ actorId: 'a' }), INST);
    await adapter.append('t', 'i', makeEntry({ actorId: 'b' }), INST);
    await adapter.append('t', 'i', makeEntry({ actorId: 'c' }), INST);

    // Mutate the stored entry content at seq 1 (hash no longer matches).
    const chain = store.get('t:i')!;
    (chain[1]!.entry as { actorId: string }).actorId = 'EVIL';

    const res = await adapter.verify('t', 'i');
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });

  it('detects a deleted entry (seq gap) and reports it', async () => {
    const store = new Map<string, ChainRecord[]>();
    const adapter = new HashChainAuditAdapter({
      writer: async (t, i, r) => {
        const k = `${t}:${i}`;
        (store.get(k) ?? store.set(k, []).get(k)!).push(r);
      },
      reader: async (t, i) => store.get(`${t}:${i}`) ?? [],
    });
    for (const a of ['a', 'b', 'c']) await adapter.append('t', 'i', makeEntry({ actorId: a }), INST);

    // Delete the middle record -> remaining seqs are [0, 2]; index 1 has seq 2.
    const chain = store.get('t:i')!;
    chain.splice(1, 1);

    const res = await adapter.verify('t', 'i');
    expect(res.ok).toBe(false);
    // At index 1 the record's seq is 2 but expected 1 -> min(2,1) = 1.
    expect(res.brokenAt).toBe(1);
  });

  it('detects a reordered chain', async () => {
    const store = new Map<string, ChainRecord[]>();
    const adapter = new HashChainAuditAdapter({
      writer: async (t, i, r) => {
        const k = `${t}:${i}`;
        (store.get(k) ?? store.set(k, []).get(k)!).push(r);
      },
      reader: async (t, i) => store.get(`${t}:${i}`) ?? [],
    });
    for (const a of ['a', 'b', 'c']) await adapter.append('t', 'i', makeEntry({ actorId: a }), INST);
    const chain = store.get('t:i')!;
    [chain[0], chain[1]] = [chain[1]!, chain[0]!];

    const res = await adapter.verify('t', 'i');
    expect(res.ok).toBe(false);
    // index 0 now holds seq 1 -> min(1, 0) = 0.
    expect(res.brokenAt).toBe(0);
  });

  it('detects broken prevHash linkage', async () => {
    const store = new Map<string, ChainRecord[]>();
    const adapter = new HashChainAuditAdapter({
      writer: async (t, i, r) => {
        const k = `${t}:${i}`;
        (store.get(k) ?? store.set(k, []).get(k)!).push(r);
      },
      reader: async (t, i) => store.get(`${t}:${i}`) ?? [],
    });
    await adapter.append('t', 'i', makeEntry({ actorId: 'a' }), INST);
    await adapter.append('t', 'i', makeEntry({ actorId: 'b' }), INST);
    const chain = store.get('t:i')!;
    // Records are frozen; replace the second record with a linkage-corrupted copy.
    chain[1] = { ...chain[1]!, prevHash: 'f'.repeat(64) };

    const res = await adapter.verify('t', 'i');
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(1);
  });
});

describe('HashChainAuditAdapter — tail truncation', () => {
  function withExternalStore() {
    const store = new Map<string, ChainRecord[]>();
    const adapter = new HashChainAuditAdapter({
      writer: async (t, i, r) => {
        const k = `${t}:${i}`;
        (store.get(k) ?? store.set(k, []).get(k)!).push(r);
      },
      reader: async (t, i) => store.get(`${t}:${i}`) ?? [],
    });
    return { adapter, store };
  }

  it('detects a dropped last record via the in-process high-water mark', async () => {
    const { adapter, store } = withExternalStore();
    for (const a of ['a', 'b', 'c']) await adapter.append('t', 'i', makeEntry({ actorId: a }), INST);

    // Truncate the tail: drop the last record. The remaining prefix [0,1]
    // re-hashes and re-links perfectly, but the high-water mark expects seq 2.
    store.get('t:i')!.pop();

    const res = await adapter.verify('t', 'i');
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(2); // first missing seq
  });

  it('detects dropping multiple trailing records', async () => {
    const { adapter, store } = withExternalStore();
    for (let n = 0; n < 5; n++) await adapter.append('t', 'i', makeEntry({ actorId: `a${n}` }), INST);

    store.get('t:i')!.splice(2); // keep [0, 1]; drop 2,3,4

    const res = await adapter.verify('t', 'i');
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(2);
  });

  it('detects truncation of the ENTIRE chain to empty via the high-water mark', async () => {
    const { adapter, store } = withExternalStore();
    await adapter.append('t', 'i', makeEntry(), INST);
    await adapter.append('t', 'i', makeEntry(), INST);

    store.set('t:i', []); // wipe the whole tail

    const res = await adapter.verify('t', 'i');
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(0);
  });

  it('does NOT false-positive an untouched chain against its high-water mark', async () => {
    const { adapter } = withExternalStore();
    for (const a of ['a', 'b', 'c']) await adapter.append('t', 'i', makeEntry({ actorId: a }), INST);
    expect(await adapter.verify('t', 'i')).toEqual({ ok: true });
  });

  it('detects truncation via an explicit expectedLength anchor (simulating a fresh process)', async () => {
    // A separate adapter shares the same store but has NO in-process high-water
    // mark for this chain (mirrors a process restart where the head was lost).
    const store = new Map<string, ChainRecord[]>();
    const writer = async (t: string, i: string, r: ChainRecord) => {
      const k = `${t}:${i}`;
      (store.get(k) ?? store.set(k, []).get(k)!).push(r);
    };
    const reader = async (t: string, i: string) => store.get(`${t}:${i}`) ?? [];

    const producer = new HashChainAuditAdapter({ writer, reader });
    for (const a of ['a', 'b', 'c']) await producer.append('t', 'i', makeEntry({ actorId: a }), INST);

    // Truncate the tail at the store level.
    store.get('t:i')!.pop(); // now length 2

    const verifier = new HashChainAuditAdapter({ writer, reader });
    // Without an anchor a fresh verifier cannot know the chain was truncated.
    expect(await verifier.verify('t', 'i')).toEqual({ ok: true });
    // With the external anchor (expected 3 records) it surfaces the truncation.
    const res = await verifier.verify('t', 'i', 3);
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(2);
  });

  it('expectedLength matching the actual length verifies ok', async () => {
    const { adapter } = withExternalStore();
    for (const a of ['a', 'b', 'c']) await adapter.append('t', 'i', makeEntry({ actorId: a }), INST);
    expect(await adapter.verify('t', 'i', 3)).toEqual({ ok: true });
  });

  it('expectedLength of 0 against an empty never-appended chain verifies ok', async () => {
    const { adapter } = withExternalStore();
    expect(await adapter.verify('t', 'never', 0)).toEqual({ ok: true });
  });
});

describe('HashChainAuditAdapter — partitioning by (tenant, instance)', () => {
  it('two instances under the same tenant get independent chains', async () => {
    const adapter = new HashChainAuditAdapter();
    await adapter.append('t', 'i1', makeEntry(), INST);
    await adapter.append('t', 'i1', makeEntry(), INST);
    await adapter.append('t', 'i2', makeEntry(), INST);
    expect((await adapter.getChain('t', 'i1')).map((r) => r.seq)).toEqual([0, 1]);
    expect((await adapter.getChain('t', 'i2')).map((r) => r.seq)).toEqual([0]);
  });

  it('two tenants with the SAME instanceId do not collide', async () => {
    const adapter = new HashChainAuditAdapter();
    await adapter.append('tenantA', 'shared', makeEntry(), INST);
    await adapter.append('tenantB', 'shared', makeEntry(), INST);
    await adapter.append('tenantB', 'shared', makeEntry(), INST);
    expect((await adapter.getChain('tenantA', 'shared')).map((r) => r.seq)).toEqual([0]);
    expect((await adapter.getChain('tenantB', 'shared')).map((r) => r.seq)).toEqual([0, 1]);
  });

  it('composite chain key length-prefixes the tenant so ("a","b:c") != ("a:b","c")', async () => {
    const adapter = new HashChainAuditAdapter();
    await adapter.append('a', 'b:c', makeEntry(), INST);
    await adapter.append('a:b', 'c', makeEntry(), INST);
    expect(await adapter.getChain('a', 'b:c')).toHaveLength(1);
    expect(await adapter.getChain('a:b', 'c')).toHaveLength(1);
  });
});

describe('HashChainAuditAdapter — concurrency', () => {
  it('Promise.all appends to the same chain produce a contiguous correctly-linked chain', async () => {
    const adapter = new HashChainAuditAdapter();
    await Promise.all(
      Array.from({ length: 25 }, (_, n) => adapter.append('t', 'i', makeEntry({ actorId: `a${n}` }), INST)),
    );
    const chain = await adapter.getChain('t', 'i');
    expect(chain.map((r) => r.seq)).toEqual(Array.from({ length: 25 }, (_, n) => n));
    expect(await adapter.verify('t', 'i')).toEqual({ ok: true });
  });

  it('rapid sequential appends stay correctly linked', async () => {
    const adapter = new HashChainAuditAdapter();
    for (let n = 0; n < 10; n++) await adapter.append('t', 'i', makeEntry({ actorId: `a${n}` }), INST);
    expect(await adapter.verify('t', 'i')).toEqual({ ok: true });
  });
});

describe('HashChainAuditAdapter — never throws', () => {
  it('ctor requires a reader when a custom writer is supplied', () => {
    expect(() => new HashChainAuditAdapter({ writer: async () => {} })).toThrow(/reader/);
  });

  it('writer rejection is logged and swallowed; append resolves', async () => {
    const logger = spyLogger();
    const adapter = new HashChainAuditAdapter({
      writer: async () => {
        throw new Error('sink down');
      },
      reader: async () => [],
      logger,
    });
    await expect(adapter.append('t', 'i', makeEntry(), INST)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
  });

  it('writer rejection on the genesis entry keeps the in-process head advanced (next seq is 1)', async () => {
    const persisted: ChainRecord[] = [];
    let calls = 0;
    const adapter = new HashChainAuditAdapter({
      writer: async (_t, _i, r) => {
        calls++;
        if (calls === 1) throw new Error('genesis sink failed');
        persisted.push(r);
      },
      reader: async () => persisted,
    });
    await adapter.append('t', 'i', makeEntry({ actorId: 'a' }), INST);
    await adapter.append('t', 'i', makeEntry({ actorId: 'b' }), INST);
    // genesis dropped at sink; second record has seq 1 (head advanced past 0).
    expect(persisted.map((r) => r.seq)).toEqual([1]);
    // verify surfaces the gap deterministically (first record's seq is 1, expected 0).
    const res = await adapter.verify('t', 'i');
    expect(res.ok).toBe(false);
    expect(res.brokenAt).toBe(0);
  });

  it('circular-reference entry is caught (logged) and append still resolves', async () => {
    const logger = spyLogger();
    const adapter = new HashChainAuditAdapter({ logger });
    const cyclic = makeEntry() as unknown as Record<string, unknown>;
    cyclic.newValue = {};
    (cyclic.newValue as Record<string, unknown>).back = cyclic;
    await expect(
      adapter.append('t', 'i', cyclic as never, INST),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();
    // Nothing persisted for the circular entry.
    expect(await adapter.getChain('t', 'i')).toHaveLength(0);
  });

  it('handles Date / nested objects in the entry without throwing', async () => {
    const adapter = new HashChainAuditAdapter();
    await adapter.append(
      't',
      'i',
      makeEntry({ newValue: { when: new Date('2026-01-01T00:00:00Z'), nested: { a: [1, 2] } } }),
      INST,
    );
    expect(await adapter.verify('t', 'i')).toEqual({ ok: true });
  });
});

describe('RedactingAuditAdapter', () => {
  function capturingInner() {
    const seen: { entry: AuditEntry }[] = [];
    const inner: IAuditAdapter = {
      append: async (_t, _i, entry) => {
        seen.push({ entry });
      },
    };
    return { inner, seen };
  }

  it('does not mutate the caller original entry (reference + deep equality)', async () => {
    const { inner } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, freeTextFields: ['comment'], fieldPaths: ['newValue.ssn'] });
    const original = makeEntry({ comment: 'secret note', newValue: { ssn: '123-45-6789', keep: 'ok' } });
    const snapshot = structuredClone(original);
    await adapter.append('t', 'i', original, INST);
    expect(original).toEqual(snapshot);
  });

  it('redacts free-text fields (comment, reason) wholesale', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, freeTextFields: ['comment', 'reason'] });
    await adapter.append('t', 'i', makeEntry({ comment: 'hi', reason: 'because' }), INST);
    expect(seen[0]!.entry.comment).toBe(DEFAULT_REDACTION_MASK);
    expect(seen[0]!.entry.reason).toBe(DEFAULT_REDACTION_MASK);
  });

  it('does not add a free-text field that was absent', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, freeTextFields: ['comment'] });
    await adapter.append('t', 'i', makeEntry(), INST);
    expect(seen[0]!.entry.comment).toBeUndefined();
  });

  it('redacts a nested dotted path scoped to newValue, preserving siblings', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, fieldPaths: ['newValue.applicant.ssn'] });
    await adapter.append(
      't',
      'i',
      makeEntry({ newValue: { applicant: { ssn: '111', name: 'Jane' } } }),
      INST,
    );
    const nv = seen[0]!.entry.newValue as { applicant: { ssn: string; name: string } };
    expect(nv.applicant.ssn).toBe(DEFAULT_REDACTION_MASK);
    expect(nv.applicant.name).toBe('Jane');
  });

  it('an unscoped path applies to BOTH oldValue and newValue', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, fieldPaths: ['ssn'] });
    await adapter.append('t', 'i', makeEntry({ oldValue: { ssn: 'A' }, newValue: { ssn: 'B' } }), INST);
    expect((seen[0]!.entry.oldValue as { ssn: string }).ssn).toBe(DEFAULT_REDACTION_MASK);
    expect((seen[0]!.entry.newValue as { ssn: string }).ssn).toBe(DEFAULT_REDACTION_MASK);
  });

  it('trailing .* wildcard masks every direct child of an object', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, fieldPaths: ['newValue.card.*'] });
    await adapter.append(
      't',
      'i',
      makeEntry({ newValue: { card: { number: '4', cvv: '999' }, other: 'keep' } }),
      INST,
    );
    const nv = seen[0]!.entry.newValue as { card: Record<string, string>; other: string };
    expect(nv.card.number).toBe(DEFAULT_REDACTION_MASK);
    expect(nv.card.cvv).toBe(DEFAULT_REDACTION_MASK);
    expect(nv.other).toBe('keep');
  });

  it('a non-resolving path is a no-op (entry unchanged)', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, fieldPaths: ['newValue.does.not.exist'] });
    await adapter.append('t', 'i', makeEntry({ newValue: { keep: 'ok' } }), INST);
    expect(seen[0]!.entry.newValue).toEqual({ keep: 'ok' });
  });

  it('a path into a primitive/array/null is a no-op', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, fieldPaths: ['newValue.a.b'] });
    await adapter.append('t', 'i', makeEntry({ newValue: { a: 'primitive' } }), INST);
    expect(seen[0]!.entry.newValue).toEqual({ a: 'primitive' });
  });

  it('uses a configurable mask token', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner, mask: '***', freeTextFields: ['comment'] });
    await adapter.append('t', 'i', makeEntry({ comment: 'x' }), INST);
    expect(seen[0]!.entry.comment).toBe('***');
  });

  it('preserves Date instances through the deep clone', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner });
    const when = new Date('2026-03-03T03:03:03.000Z');
    await adapter.append('t', 'i', makeEntry({ newValue: { when } }), INST);
    expect((seen[0]!.entry.newValue as { when: Date }).when).toBeInstanceOf(Date);
    expect((seen[0]!.entry.newValue as { when: Date }).when.getTime()).toBe(when.getTime());
  });

  it('forwards a clone, not the same reference', async () => {
    const { inner, seen } = capturingInner();
    const adapter = new RedactingAuditAdapter({ inner });
    const original = makeEntry({ newValue: { a: 1 } });
    await adapter.append('t', 'i', original, INST);
    expect(seen[0]!.entry).not.toBe(original);
  });
});

describe('CompositeAuditAdapter', () => {
  it('fans the entry out to every child', async () => {
    const a = { append: vi.fn(async () => {}) };
    const b = { append: vi.fn(async () => {}) };
    const composite = new CompositeAuditAdapter({ children: [a, b] });
    const entry = makeEntry();
    await composite.append('t', 'i', entry, INST);
    expect(a.append).toHaveBeenCalledWith('t', 'i', entry, INST);
    expect(b.append).toHaveBeenCalledWith('t', 'i', entry, INST);
  });

  it('zero children is a no-op that resolves', async () => {
    const composite = new CompositeAuditAdapter({ children: [] });
    await expect(composite.append('t', 'i', makeEntry(), INST)).resolves.toBeUndefined();
  });

  it('a rejecting child does not stop the others and is logged with identity', async () => {
    const logger = spyLogger();
    const good = { append: vi.fn(async () => {}) };
    const bad: IAuditAdapter = {
      append: async () => {
        throw new Error('boom');
      },
    };
    const composite = new CompositeAuditAdapter({
      children: [{ id: 'bad-sink', adapter: bad }, good],
      logger,
    });
    await expect(composite.append('t', 'i', makeEntry(), INST)).resolves.toBeUndefined();
    expect(good.append).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0]![0]).toContain('bad-sink');
  });

  it('captures a child that throws synchronously', async () => {
    const logger = spyLogger();
    const sync: IAuditAdapter = {
      append: () => {
        throw new Error('sync boom');
      },
    };
    const good = { append: vi.fn(async () => {}) };
    const composite = new CompositeAuditAdapter({ children: [sync, good], logger });
    await expect(composite.append('t', 'i', makeEntry(), INST)).resolves.toBeUndefined();
    expect(good.append).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledOnce();
  });

  it('every child throwing still resolves and logs all errors', async () => {
    const logger = spyLogger();
    const mk = (): IAuditAdapter => ({
      append: async () => {
        throw new Error('x');
      },
    });
    const composite = new CompositeAuditAdapter({ children: [mk(), mk(), mk()], logger });
    await expect(composite.append('t', 'i', makeEntry(), INST)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(3);
  });

  it('uses child[index] identity for bare adapters', async () => {
    const logger = spyLogger();
    const bad: IAuditAdapter = {
      append: async () => {
        throw new Error('boom');
      },
    };
    const composite = new CompositeAuditAdapter({ children: [bad], logger });
    await composite.append('t', 'i', makeEntry(), INST);
    expect(logger.error.mock.calls[0]![0]).toContain('child[0]');
  });
});

// Integration of decorator + chain (drop-in composition).
describe('Audit adapters compose', () => {
  it('RedactingAuditAdapter wrapping a HashChainAuditAdapter still verifies', async () => {
    const chain = new HashChainAuditAdapter();
    const redacting = new RedactingAuditAdapter({ inner: chain, freeTextFields: ['comment'] });
    await redacting.append('t', 'i', makeEntry({ comment: 'secret' }), INST);
    await redacting.append('t', 'i', makeEntry({ comment: 'secret2' }), INST);
    expect(await chain.verify('t', 'i')).toEqual({ ok: true });
    const stored = await chain.getChain('t', 'i');
    expect(stored[0]!.entry.comment).toBe(DEFAULT_REDACTION_MASK);
  });
});
