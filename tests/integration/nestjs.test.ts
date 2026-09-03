import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import { Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ApprovalEngine } from '../../src/index.js';
import { MemoryAdapter } from '../../src/adapters/MemoryAdapter.js';
import type { ApprovalEngineOptions } from '../../src/index.js';
import {
  HierarchicalApprovalModule,
  APPROVAL_ENGINE,
  InjectApprovalEngine,
} from '../../src/nestjs/index.js';

/** Engine options with the escalation poller effectively disabled for tests. */
function opts(): ApprovalEngineOptions {
  return { adapter: new MemoryAdapter(), escalationPollIntervalMs: 999_999 };
}

/** Register a one-level template and drive a submit→approve so we know the engine is live. */
async function runApproval(engine: ApprovalEngine): Promise<string> {
  await engine.defineTemplate({
    name: 'T',
    documentType: 'doc',
    levels: [{ level: 1, name: 'L1', approvers: [{ type: 'user', userId: 'u1' }], mode: 'any' }],
  });
  const inst = await engine.submit({
    templateName: 'T',
    documentId: 'D1',
    documentType: 'doc',
    submittedBy: 'sub',
    data: {},
  });
  const approved = await engine.approve(inst.id, { approverId: 'u1' });
  return approved.status;
}

describe('HierarchicalApprovalModule.forRoot', () => {
  it('provides a working ApprovalEngine under APPROVAL_ENGINE', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HierarchicalApprovalModule.forRoot(opts())],
    }).compile();

    const engine = moduleRef.get<ApprovalEngine>(APPROVAL_ENGINE);
    expect(engine).toBeInstanceOf(ApprovalEngine);
    expect(await runApproval(engine)).toBe('approved');

    await moduleRef.close();
  });

  it('calls engine.shutdown() on module destroy', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [HierarchicalApprovalModule.forRoot(opts())],
    }).compile();

    const engine = moduleRef.get<ApprovalEngine>(APPROVAL_ENGINE);
    const spy = vi.spyOn(engine, 'shutdown');

    await moduleRef.close();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('honors isGlobal and exports the token', async () => {
    const dyn = HierarchicalApprovalModule.forRoot({ ...opts(), isGlobal: true });
    expect(dyn.global).toBe(true);
    expect(dyn.exports).toContain(APPROVAL_ENGINE);

    // Compile + close so the eagerly-constructed engine's scheduler is cleaned up.
    const moduleRef = await Test.createTestingModule({ imports: [dyn] }).compile();
    await moduleRef.close();
  });
});

describe('HierarchicalApprovalModule.forRootAsync', () => {
  it('builds the engine from an async factory with config injected via imports', async () => {
    const CONFIG = Symbol('CONFIG');
    // A config module that provides + exports the token, applied programmatically
    // to avoid decorator syntax (vitest's esbuild has no experimentalDecorators).
    class ConfigTestModule {}
    Module({ providers: [{ provide: CONFIG, useValue: opts() }], exports: [CONFIG] })(
      ConfigTestModule,
    );

    const moduleRef = await Test.createTestingModule({
      imports: [
        HierarchicalApprovalModule.forRootAsync({
          imports: [ConfigTestModule],
          inject: [CONFIG],
          useFactory: (config) => config as ApprovalEngineOptions,
        }),
      ],
    }).compile();

    const engine = moduleRef.get<ApprovalEngine>(APPROVAL_ENGINE);
    expect(engine).toBeInstanceOf(ApprovalEngine);
    expect(await runApproval(engine)).toBe('approved');

    await moduleRef.close();
  });

  it('defaults imports and inject to empty arrays when omitted', async () => {
    const dyn = HierarchicalApprovalModule.forRootAsync({
      useFactory: () => opts(),
    });
    expect(dyn.imports).toEqual([]);

    const moduleRef = await Test.createTestingModule({ imports: [dyn] }).compile();
    const engine = moduleRef.get<ApprovalEngine>(APPROVAL_ENGINE);
    expect(await runApproval(engine)).toBe('approved');

    await moduleRef.close();
  });
});

describe('APPROVAL_ENGINE injection', () => {
  it('is injectable into other providers via the token', async () => {
    const CONSUMER = Symbol('CONSUMER');
    const moduleRef = await Test.createTestingModule({
      imports: [HierarchicalApprovalModule.forRoot({ ...opts(), isGlobal: true })],
      providers: [{ provide: CONSUMER, useFactory: (engine) => engine, inject: [APPROVAL_ENGINE] }],
    }).compile();

    expect(moduleRef.get(CONSUMER)).toBeInstanceOf(ApprovalEngine);
    await moduleRef.close();
  });

  it('InjectApprovalEngine() returns a decorator', () => {
    expect(typeof InjectApprovalEngine()).toBe('function');
  });
});
