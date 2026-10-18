/**
 * `pg` is an optional peer dependency, so a consumer who builds a
 * PostgresAdapter from a connection string without installing it must get
 * an actionable error rather than a bare module-resolution failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

describe('PostgresAdapter without the pg peer dependency', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.resetModules();
  });

  it('tells the caller to install pg when the driver cannot be loaded', async () => {
    vi.resetModules();
    vi.doMock('pg', () => {
      throw new Error("Cannot find package 'pg'");
    });
    const { PostgresAdapter } = await import('../../../src/adapters/PostgresAdapter.js');
    const adapter = new PostgresAdapter({ connectionString: 'postgres://localhost/db' });

    await expect(adapter.migrate()).rejects.toThrow(/npm install pg/);
  });
});
