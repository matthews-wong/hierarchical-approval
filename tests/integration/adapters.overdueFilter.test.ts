import { describe, it, expect, beforeEach } from 'vitest';
import { ApprovalEngine } from '../../src/engine/ApprovalEngine.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import { PostgresAdapter } from '../../src/adapters/PostgresAdapter.js';
import { FakePool } from '../unit/adapters/_fakePg.js';
import type { Clock } from '../../src/utils/Clock.js';

class TestClock implements Clock {
  constructor(private current = new Date('2026-01-01T00:00:00Z')) {}
  now(): Date {
    return new Date(this.current);
  }
  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86_400_000);
  }
}

/**
 * getStatistics() passes its filter straight to getOverdueInstances. Honouring
 * only documentType and submittedBy there meant `overdue` counted instances the
 * other figures had excluded — a dashboard could report more overdue approvals
 * than the filter said existed.
 */
describe('getOverdueInstances honours the whole filter', () => {
  describe('MemoryAdapter', () => {
    let clock: TestClock;
    let adapter: MemoryAdapter;
    let engine: ApprovalEngine;

    beforeEach(async () => {
      clock = new TestClock();
      adapter = new MemoryAdapter();
      engine = new ApprovalEngine({ adapter, clock });
      for (const name of ['A', 'B']) {
        await engine.defineTemplate({
          name,
          documentType: 'doc',
          levels: [
            {
              level: 1,
              name: 'L',
              approvers: [{ type: 'user', userId: 'u' }],
              mode: 'any',
              escalationAfterDays: 1,
            },
          ],
        });
        await engine.submit({
          templateName: name,
          documentId: `d-${name}`,
          documentType: 'doc',
          submittedBy: name === 'A' ? 'alice' : 'bob',
          data: { vendor: name },
        });
      }
      clock.advanceDays(5);
    });

    it('scopes overdue by template', async () => {
      const stats = await engine.getStatistics({ templateName: 'A' });
      expect(stats.total).toBe(1);
      expect(stats.overdue).toBe(1);
    });

    it('scopes overdue by document data', async () => {
      const stats = await engine.getStatistics({ data: { vendor: 'A' } });
      expect(stats.total).toBe(1);
      expect(stats.overdue).toBe(1);
    });

    it('scopes overdue by submitter', async () => {
      expect((await engine.getStatistics({ submittedBy: 'alice' })).overdue).toBe(1);
    });

    it('scopes overdue by date range', async () => {
      const past = { toDate: new Date('2025-01-01T00:00:00Z') };
      expect((await engine.getStatistics(past)).overdue).toBe(0);
    });

    it('still reports everything when unfiltered', async () => {
      const stats = await engine.getStatistics({});
      expect(stats.total).toBe(2);
      expect(stats.overdue).toBe(2);
    });

    it('never reports more overdue than exist under the same filter', async () => {
      for (const filter of [
        {},
        { templateName: 'A' },
        { templateName: 'B' },
        { data: { vendor: 'A' } },
        { submittedBy: 'bob' },
      ]) {
        const stats = await engine.getStatistics(filter);
        expect(stats.overdue, JSON.stringify(filter)).toBeLessThanOrEqual(stats.total);
      }
    });
  });

  describe('PostgresAdapter', () => {
    it('adds every filter clause to the overdue query', async () => {
      const pool = new FakePool();
      const adapter = new PostgresAdapter({ pool: pool.asPool() });

      await adapter.getOverdueInstances('t1', new Date('2026-01-05T00:00:00Z'), {
        documentType: 'doc',
        submittedBy: 'alice',
        templateName: 'A',
        fromDate: new Date('2026-01-01T00:00:00Z'),
        toDate: new Date('2026-02-01T00:00:00Z'),
        data: { 'vendor.id': 'v1' },
      });

      const sql = pool.queries.at(-1)?.sql ?? '';
      expect(sql).toContain('document_type =');
      expect(sql).toContain('submitted_by =');
      expect(sql).toContain('template_name =');
      expect(sql).toContain('created_at >=');
      expect(sql).toContain('created_at <=');
      expect(sql).toContain('data #> $');
      expect(pool.queries.at(-1)?.params).toContain('{"vendor","id"}');
    });

    it('keeps the overdue predicates alongside the filter', async () => {
      const pool = new FakePool();
      const adapter = new PostgresAdapter({ pool: pool.asPool() });
      await adapter.getOverdueInstances('t1', new Date(), { templateName: 'A' });

      const sql = pool.queries.at(-1)?.sql ?? '';
      expect(sql).toContain('escalationDueAt');
      expect(sql).toContain('reminderDueAt');
      expect(sql).toContain('sla_deadline_at');
    });
  });
});
