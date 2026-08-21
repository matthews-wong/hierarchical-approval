/**
 * Minimal, dependency-free HTTP port shaped after the WHATWG `fetch` function.
 *
 * The global `fetch` (built into Node.js since v18) is structurally assignable
 * to {@link HttpClient} as-is — no wrapping required, mirroring how a real
 * OpenTelemetry `Tracer` is structurally assignable to this library's
 * {@link import('../tracing/ITracer.js').Tracer} port. This library never adds
 * a dependency on axios/node-fetch/undici: bring your own fetch-shaped function
 * if you need custom behavior (a proxy, request mocking, a different runtime's
 * fetch), or use {@link getDefaultHttpClient}, which forwards to
 * `globalThis.fetch`.
 *
 * The parameter type is intentionally narrower than `fetch`'s own
 * `RequestInfo | URL` (it omits `Request`), which is what makes the global
 * `fetch` assignable here: a function accepting a *wider* input domain is
 * always assignable to a type expecting a *narrower* one.
 */
export type HttpClient = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Resolves the default {@link HttpClient}: `globalThis.fetch`, bound so it can
 * be invoked detached from `globalThis`.
 *
 * @throws {Error} If no global `fetch` exists (Node.js < 18). The message
 *   names both ways to fix it: upgrade Node.js, or pass an explicit
 *   `httpClient` (any fetch-shaped function) via
 *   `WebhookNotificationAdapterOptions`.
 */
export function getDefaultHttpClient(): HttpClient {
  const globalFetch = globalThis.fetch;
  if (typeof globalFetch !== 'function') {
    throw new Error(
      'hierarchical-approval/plugins/webhook: no global `fetch` was found. This is built into ' +
        'Node.js 18+ — on an older runtime, either upgrade Node.js or pass an explicit ' +
        '`httpClient` (any function shaped like `fetch`) via WebhookNotificationAdapterOptions.',
    );
  }
  return globalFetch.bind(globalThis);
}
