import { describe, it, expect, vi } from 'vitest';
import { ApprovalTestKit } from '../../src/testing/ApprovalTestKit.js';
import { EventBus } from '../../src/utils/EventBus.js';
import type {
  INotificationAdapter,
  NotificationEvent,
} from '../../src/adapters/INotificationAdapter.js';
import type { IOperationMiddleware } from '../../src/engine/IOperationMiddleware.js';
import type { ApprovalTemplateConfig } from '../../src/types/index.js';

const singleLevelTemplate: ApprovalTemplateConfig = {
  name: 'single-level',
  documentType: 'doc',
  levels: [
    {
      level: 1,
      name: 'Only',
      approvers: [{ type: 'user', userId: 'appr1' }],
      mode: 'any',
    },
  ],
};

function collectingNotifier(): { adapter: INotificationAdapter; events: NotificationEvent[] } {
  const events: NotificationEvent[] = [];
  return {
    events,
    adapter: {
      notify: async (e) => {
        events.push(e);
      },
    },
  };
}

describe('EventBus — listener failure isolation', () => {
  it('contains a throwing listener and still runs the ones registered after it', () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.setListenerErrorHandler((err) => errors.push(err));

    const boom = new Error('listener-boom');
    const later = vi.fn();
    bus.on('approval:completed', () => {
      throw boom;
    });
    bus.on('approval:completed', later);

    // Previously this threw out of emit() into the caller mid-operation.
    expect(() => bus.emit('approval:completed', {} as never)).not.toThrow();
    expect(later).toHaveBeenCalledTimes(1);
    expect(errors).toEqual([boom]);
  });

  it('reports a rejecting async listener instead of leaking an unhandled rejection', async () => {
    const bus = new EventBus();
    const errors: unknown[] = [];
    bus.setListenerErrorHandler((err) => errors.push(err));

    const boom = new Error('async-boom');
    bus.on('approval:completed', () => Promise.reject(boom) as unknown as void);
    bus.emit('approval:completed', {} as never);

    await new Promise((resolve) => setImmediate(resolve));
    expect(errors).toEqual([boom]);
  });

  it('still supports off() and once() through the wrapper', () => {
    const bus = new EventBus();
    const listener = vi.fn();

    bus.on('approval:completed', listener);
    bus.off('approval:completed', listener);
    bus.emit('approval:completed', {} as never);
    expect(listener).not.toHaveBeenCalled();

    const onceListener = vi.fn();
    bus.once('approval:completed', onceListener);
    bus.emit('approval:completed', {} as never);
    bus.emit('approval:completed', {} as never);
    expect(onceListener).toHaveBeenCalledTimes(1);
  });

  it('swallows a listener error when no handler is registered', () => {
    const bus = new EventBus();
    bus.on('approval:completed', () => {
      throw new Error('nobody-listening');
    });
    expect(() => bus.emit('approval:completed', {} as never)).not.toThrow();
  });
});

describe('engine — a throwing engine.on() listener no longer breaks the operation', () => {
  it('completes approve(), still dispatches notifications, and still runs after-middleware', async () => {
    const { adapter: notificationAdapter, events } = collectingNotifier();
    const afterCalls: string[] = [];
    const middleware: IOperationMiddleware = {
      after: async (ctx) => {
        afterCalls.push(ctx.operation);
      },
    };

    const { engine } = ApprovalTestKit.create({ notificationAdapter, middleware: [middleware] });
    await engine.defineTemplate(singleLevelTemplate);
    const instance = await engine.submit({
      templateName: 'single-level',
      documentId: 'doc-1',
      documentType: 'doc',
      submittedBy: 'submitter1',
      data: {},
    });

    events.length = 0;
    afterCalls.length = 0;

    engine.on('approval:approved', () => {
      throw new Error('listener-boom');
    });

    // Previously this rejected with the consumer's own error.
    await expect(engine.approve(instance.id, { approverId: 'appr1' })).resolves.toBeDefined();

    const persisted = await engine.getInstance(instance.id);
    expect(persisted.status).toBe('approved');
    // Notification dispatch is no longer skipped by the listener's failure.
    expect(events.length).toBeGreaterThan(0);
    // After-middleware is no longer skipped either.
    expect(afterCalls).toContain('approve');
  });

  it('dispatches approval:completed to notification adapters', async () => {
    const { adapter: notificationAdapter, events } = collectingNotifier();
    const { engine } = ApprovalTestKit.create({ notificationAdapter });
    await engine.defineTemplate(singleLevelTemplate);
    const instance = await engine.submit({
      templateName: 'single-level',
      documentId: 'doc-2',
      documentType: 'doc',
      submittedBy: 'submitter1',
      data: {},
    });

    events.length = 0;
    await engine.approve(instance.id, { approverId: 'appr1' });

    // Previously `approval:completed` was emitted on the in-process bus only,
    // so a webhook/email integrator never learned a document was fully approved.
    expect(events.map((e) => e.type)).toContain('approval:completed');
  });
});
