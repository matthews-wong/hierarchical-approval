import { describe, it, expect } from 'vitest';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { FakePool } from '../unit/adapters/_fakePg.js';

const buildEngine = async () => {
  const engine = new ApprovalEngine({ adapter: new MemoryAdapter() });
  await engine.defineTemplate({
    name: 'PO',
    documentType: 'purchase_order',
    levels: [
      { level: 1, name: 'Manager', approvers: [{ type: 'user', userId: 'mgr' }], mode: 'any' },
    ],
  });
  return engine;
};

const submit = (engine: ApprovalEngine, id: string, data: Record<string, unknown>) =>
  engine.submit({
    templateName: 'PO',
    documentId: id,
    documentType: 'purchase_order',
    submittedBy: 'buyer',
    data,
  });

describe('filtering instances by document data', () => {
  describe('MemoryAdapter', () => {
    it('matches a top-level field', async () => {
      const engine = await buildEngine();
      await submit(engine, 'a', { vendor: 'acme', amount: 100 });
      await submit(engine, 'b', { vendor: 'globex', amount: 200 });

      const r = await engine.queryInstances({ data: { vendor: 'acme' } });
      expect(r.items.map((i) => i.documentId)).toEqual(['a']);
    });

    it('ANDs multiple pairs', async () => {
      const engine = await buildEngine();
      await submit(engine, 'a', { vendor: 'acme', region: 'EU' });
      await submit(engine, 'b', { vendor: 'acme', region: 'US' });

      const r = await engine.queryInstances({ data: { vendor: 'acme', region: 'US' } });
      expect(r.items.map((i) => i.documentId)).toEqual(['b']);
    });

    it('matches a nested dot-path', async () => {
      const engine = await buildEngine();
      await submit(engine, 'a', { vendor: { id: 'v1', country: 'DE' } });
      await submit(engine, 'b', { vendor: { id: 'v2', country: 'FR' } });

      const r = await engine.queryInstances({ data: { 'vendor.country': 'DE' } });
      expect(r.items.map((i) => i.documentId)).toEqual(['a']);
    });

    it('matches object and array values structurally', async () => {
      const engine = await buildEngine();
      await submit(engine, 'a', { tags: ['x', 'y'], meta: { k: 1 } });
      await submit(engine, 'b', { tags: ['x'], meta: { k: 2 } });

      expect(
        (await engine.queryInstances({ data: { tags: ['x', 'y'] } })).items.map(
          (i) => i.documentId,
        ),
      ).toEqual(['a']);
      expect(
        (await engine.queryInstances({ data: { meta: { k: 2 } } })).items.map((i) => i.documentId),
      ).toEqual(['b']);
    });

    it('distinguishes a missing field from a null one', async () => {
      const engine = await buildEngine();
      await submit(engine, 'a', { amount: null });
      await submit(engine, 'b', { other: 1 });

      const r = await engine.queryInstances({ data: { amount: null } });
      expect(r.items.map((i) => i.documentId)).toEqual(['a']);
    });

    it('does not match through the prototype chain', async () => {
      const engine = await buildEngine();
      await submit(engine, 'a', { amount: 1 });
      (Object.prototype as Record<string, unknown>)['vendor'] = 'acme';
      try {
        const r = await engine.queryInstances({ data: { vendor: 'acme' } });
        expect(r.items).toHaveLength(0);
      } finally {
        delete (Object.prototype as Record<string, unknown>)['vendor'];
      }
    });

    it('combines with the other filters', async () => {
      const engine = await buildEngine();
      const a = await submit(engine, 'a', { vendor: 'acme' });
      await submit(engine, 'b', { vendor: 'acme' });
      await engine.cancel(a.id, { cancelledBy: 'buyer', reason: 'x' });

      const r = await engine.queryInstances({ status: 'pending', data: { vendor: 'acme' } });
      expect(r.items.map((i) => i.documentId)).toEqual(['b']);
    });

    it('is a no-op when no data filter is given', async () => {
      const engine = await buildEngine();
      await submit(engine, 'a', { vendor: 'acme' });
      expect((await engine.queryInstances({})).items).toHaveLength(1);
    });
  });

  describe('PostgresAdapter', () => {
    const freshPg = () => {
      const pool = new FakePool();
      return { pool, adapter: new PostgresAdapter({ pool: pool.asPool() }) };
    };

    it('emits a parameterised JSONB path lookup, never interpolating the path', async () => {
      const { pool, adapter } = freshPg();
      await adapter.getInstancesByFilter('t1', { data: { 'vendor.id': 'v1' } });

      const q = pool.queries.at(-1);
      expect(q?.sql).toContain('data #> $');
      expect(q?.sql).toContain('::text[]');
      expect(q?.sql).toContain('::jsonb');
      // The path travels as a parameter, not inside the SQL string.
      expect(q?.sql).not.toContain('vendor.id');
      expect(q?.params).toContain('{"vendor","id"}');
      expect(q?.params).toContain('"v1"');
    });

    it('adds one condition pair per field', async () => {
      const { pool, adapter } = freshPg();
      await adapter.getInstancesByFilter('t1', { data: { a: 1, b: 2 } });
      const q = pool.queries.at(-1);
      expect((q?.sql.match(/data #> \$/g) ?? []).length).toBe(2);
    });

    it('serialises object values as JSONB so they compare structurally', async () => {
      const { pool, adapter } = freshPg();
      await adapter.getInstancesByFilter('t1', { data: { meta: { k: 1 } } });
      expect(pool.queries.at(-1)?.params).toContain('{"k":1}');
    });

    it('applies the same filter on the cursor-paginated path', async () => {
      const { pool, adapter } = freshPg();
      await adapter.getInstancesByCursor('t1', { data: { vendor: 'acme' } }, { limit: 10 });
      expect(pool.queries.at(-1)?.sql).toContain('data #> $');
    });

    it('escapes a quote in a path segment', async () => {
      const { pool, adapter } = freshPg();
      await adapter.getInstancesByFilter('t1', { data: { 'we"ird': 1 } });
      expect(pool.queries.at(-1)?.params).toContain('{"we\\"ird"}');
    });
  });
});
