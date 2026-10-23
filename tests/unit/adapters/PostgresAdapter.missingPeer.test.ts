/**
 * `pg` is an optional peer dependency, so a consumer who builds a
 * PostgresAdapter from a connection string without installing it must get
 * an actionable error rather than a bare module-resolution failure.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ApprovalValidationError } from '../../../src/errors.js';
import type { PostgresAdapter } from '../../../src/adapters/PostgresAdapter.js';

// vitest rewraps errors thrown by a mock factory, so fail on property access instead.
function failingModule(cause: unknown): object {
  return Object.defineProperty({}, 'default', {
    get() {
      throw cause;
    },
  });
}

async function adapterWhosePgFails(thrown: unknown): Promise<PostgresAdapter> {
  vi.resetModules();
  vi.doMock('pg', () => failingModule(thrown));
  const { PostgresAdapter } = await import('../../../src/adapters/PostgresAdapter.js');
  return new PostgresAdapter({ connectionString: 'postgres://localhost/db' });
}

function resolutionError(code: string): Error {
  return Object.assign(new Error("Cannot find package 'pg'"), { code });
}

describe('PostgresAdapter without the pg peer dependency', () => {
  afterEach(() => {
    vi.doUnmock('pg');
    vi.resetModules();
  });

  it.each(['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'])(
    'tells the caller to install pg when resolution fails with %s',
    async (code) => {
      const cause = resolutionError(code);
      const adapter = await adapterWhosePgFails(cause);

      const error = await adapter.migrate().catch((e: unknown) => e);

      // resetModules gives the adapter its own copy of the error class, so match on name.
      expect((error as ApprovalValidationError).name).toBe('ApprovalValidationError');
      expect((error as ApprovalValidationError).message).toMatch(/npm install pg/);
      expect((error as ApprovalValidationError).cause).toBe(cause);
    },
  );

  it('rethrows a load failure that is not a missing module unchanged', async () => {
    const cause = new Error('boom while evaluating pg');
    const adapter = await adapterWhosePgFails(cause);

    await expect(adapter.migrate()).rejects.toBe(cause);
  });

  it('rethrows a missing transitive dependency of pg instead of asking for pg', async () => {
    const cause = Object.assign(new Error("Cannot find package 'pg-pool' imported from pg"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const adapter = await adapterWhosePgFails(cause);

    await expect(adapter.migrate()).rejects.toBe(cause);
  });

  it('rethrows a pg-pool failure reported through the CommonJS resolver', async () => {
    const cause = Object.assign(
      new Error(
        "Cannot find module 'pg-pool'\nRequire stack:\n- /app/node_modules/pg/lib/index.js",
      ),
      { code: 'MODULE_NOT_FOUND' },
    );
    const adapter = await adapterWhosePgFails(cause);

    await expect(adapter.migrate()).rejects.toBe(cause);
  });

  it.each([
    ['without a message', { code: 'ERR_MODULE_NOT_FOUND' }],
    ['with a non-string message', { code: 'ERR_MODULE_NOT_FOUND', message: 42 }],
  ])('rethrows a not-found failure %s unchanged', async (_label, thrown) => {
    const adapter = await adapterWhosePgFails(thrown);

    await expect(adapter.migrate()).rejects.toBe(thrown);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'boom'],
  ])('rethrows %s unchanged', async (_label, thrown) => {
    const adapter = await adapterWhosePgFails(thrown);

    await expect(adapter.migrate()).rejects.toBe(thrown);
  });

  it('never loads pg when an existing pool is supplied', async () => {
    const factory = vi.fn(() => failingModule(resolutionError('ERR_MODULE_NOT_FOUND')));
    vi.resetModules();
    vi.doMock('pg', factory);
    const { PostgresAdapter } = await import('../../../src/adapters/PostgresAdapter.js');
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const adapter = new PostgresAdapter({ pool: pool as never });

    await adapter.migrate();

    expect(pool.query).toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});
