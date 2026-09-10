import type { Pool, QueryResultRow } from 'pg';

/** One SQL statement + its positional parameters, in call order. */
export interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** Row/rowCount payload a queued or default query() call resolves with. */
export interface FakeQueryResult<T extends QueryResultRow = QueryResultRow> {
  rows?: T[];
  rowCount?: number | null;
}

/**
 * Hand-written fake of the `pg` surface PostgresAdapter actually exercises —
 * only `Pool.query()` and `Pool.end()`. PostgresAdapter never calls
 * `pool.connect()` (it has no multi-statement transactions: every write is a
 * single atomic INSERT/UPDATE), so this fake intentionally does not model
 * `PoolClient`/`connect`/`release`.
 *
 * Records every SQL string and parameter array so tests can assert on tenant
 * isolation, parameterization, and SQL shape without a live database, pg-mem,
 * or testcontainers.
 */
export class FakePool {
  readonly queries: RecordedQuery[] = [];
  private readonly resultQueue: FakeQueryResult[] = [];
  private readonly defaultResult: FakeQueryResult = { rows: [], rowCount: 0 };
  endCalls = 0;

  /** Queue the result the next query() call resolves with (FIFO). Unqueued calls get the default empty result. */
  queueResult<T extends QueryResultRow = QueryResultRow>(result: FakeQueryResult<T>): void {
    this.resultQueue.push(result);
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount: number | null }> {
    this.queries.push({ sql, params });
    const next = (this.resultQueue.shift() ?? this.defaultResult) as FakeQueryResult<T>;
    return {
      rows: next.rows ?? [],
      rowCount: next.rowCount ?? next.rows?.length ?? 0,
    };
  }

  async end(): Promise<void> {
    this.endCalls++;
  }

  /** The SQL text of the Nth recorded query (0-indexed) — throws if it wasn't recorded. */
  sqlAt(index: number): string {
    const query = this.queries[index];
    if (!query) {
      throw new Error(`No query recorded at index ${index} (only ${this.queries.length} recorded)`);
    }
    return query.sql;
  }

  /** Cast to the `pg.Pool` shape PostgresAdapterOptions.pool expects. */
  asPool(): Pool {
    return this as unknown as Pool;
  }
}
