import type { IOutboxStore, OutboxRecord } from './IOutboxStore.js';

/**
 * Default, dependency-free {@link IOutboxStore} backed by an in-process Map.
 *
 * Ordering: {@link due} and {@link pending} return records sorted by
 * `enqueuedAt` (then by id as a tiebreaker), giving FIFO best-effort within a
 * single `(tenant, instance)` partition. There is no cross-partition ordering
 * guarantee.
 *
 * Records are stored by reference; the adapter mutates and writes them back via
 * {@link update}, so reads reflect the latest state. This is intentional for the
 * in-memory case — a remote store would serialize instead.
 */
export class InMemoryOutboxStore implements IOutboxStore {
  private readonly records = new Map<string, OutboxRecord>();

  async enqueue(record: OutboxRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async due(now: number): Promise<OutboxRecord[]> {
    return this.sorted().filter((r) => r.status === 'pending' && r.nextAttemptAt <= now);
  }

  async update(record: OutboxRecord): Promise<void> {
    // Only persist if the record is still tracked (not removed concurrently).
    if (this.records.has(record.id)) {
      this.records.set(record.id, record);
    }
  }

  async remove(id: string): Promise<void> {
    this.records.delete(id);
  }

  async pending(): Promise<OutboxRecord[]> {
    return this.sorted().filter((r) => r.status === 'pending');
  }

  async deadLettered(): Promise<OutboxRecord[]> {
    return this.sorted().filter((r) => r.status === 'dead');
  }

  /** Test/ops helper — total records currently retained (pending + dead). */
  get size(): number {
    return this.records.size;
  }

  private sorted(): OutboxRecord[] {
    return [...this.records.values()].sort((a, b) =>
      a.enqueuedAt !== b.enqueuedAt ? a.enqueuedAt - b.enqueuedAt : a.id.localeCompare(b.id),
    );
  }
}
