import { vi } from 'vitest';
import type { Clock } from '../../../src/utils/Clock.js';
import type { Logger } from '../../../src/utils/Logger.js';
import type { AuditEntry, ApprovalInstance } from '../../../src/types/index.js';

/** A deterministic, injectable clock for reproducible tests (no real wall-clock). */
export class ManualClock implements Clock {
  private ms: number;
  constructor(startMs = 0) {
    this.ms = startMs;
  }
  now(): Date {
    return new Date(this.ms);
  }
  /** Advance the clock forward by `deltaMs` (may be negative to simulate skew). */
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  /** Set the clock to an absolute epoch-ms value. */
  set(absoluteMs: number): void {
    this.ms = absoluteMs;
  }
}

/** A Logger whose four methods are vitest spies for assertions. */
export function spyLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/** Minimal but valid AuditEntry; override any field via `over`. */
export function makeEntry(over: Partial<AuditEntry> = {}): AuditEntry {
  return {
    action: 'approved',
    actorId: 'user-1',
    level: 1,
    timestamp: new Date('2026-06-26T10:00:00.000Z'),
    ...over,
  };
}

/** A throwaway ApprovalInstance — only identity fields matter for these adapters. */
export function makeInstance(over: Partial<ApprovalInstance> = {}): ApprovalInstance {
  return {
    id: 'inst-1',
    tenantId: 'tenant-1',
    templateId: 'tpl-1',
    templateName: 'tpl',
    documentId: 'doc-1',
    documentType: 'invoice',
    submittedBy: 'user-1',
    status: 'pending',
    currentLevel: 0,
    version: 1,
    levels: [],
    auditLog: [],
    data: {},
    metadata: {},
    createdAt: new Date('2026-06-26T09:00:00.000Z'),
    updatedAt: new Date('2026-06-26T09:00:00.000Z'),
    ...over,
  };
}
