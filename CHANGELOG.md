# Changelog

All notable changes to `hierarchical-approval` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — cycle-time analytics

- **`getStatistics()` now reports time-to-decision.** The returned
  `ApprovalStatistics` gains `cycleTime: CycleTimeStats` and
  `cycleTimeByTemplate: Record<string, CycleTimeStats>`, each shaped as
  `{ count, averageMs, p50Ms, p95Ms, minMs, maxMs }` (all durations in
  milliseconds; new `CycleTimeStats` interface, exported from the package root).
  - Counts instances in status `approved`, `rejected`, or `cancelled`.
    **`expired` is deliberately excluded** — its terminal timestamp reflects a
    scheduler deadline firing, not a decision, so including it would skew the
    distribution rather than describe it.
  - Elapsed time per instance is `updatedAt - createdAt`; no new fields were
    added to `ApprovalInstance` or either storage adapter.
  - Every field is `0` (never `NaN`) when `count` is `0`. `cycleTimeByTemplate`
    mirrors `byTemplate`'s population rule: a template only appears once it has
    at least one completed instance.
  - Adapter-agnostic — computed from existing `getInstancesByFilter` pages, so
    `MemoryAdapter` and `PostgresAdapter` both support it with no changes.

### Added — `plugins/webhook`

- **`hierarchical-approval/plugins/webhook`** — a sixth built-in plug-in
  subpath: an HTTP `INotificationAdapter` with signing and retry, on its own
  tree-shakeable import path with **zero new dependencies**.
  - `WebhookNotificationAdapter` POSTs each event as JSON to a configured URL.
    `notify()` never throws (per the `INotificationAdapter` contract) — it logs
    and drops the notification once retries are exhausted.
  - **Signing (opt-in via `secret`).** Each request carries an
    `X-Approval-Signature: t=<unix-seconds>,v1=<hex-hmac>` header (Stripe-style),
    the HMAC-SHA256 digest of the signing string `` `<unix-seconds>.<json-body>` ``.
    Unsigned when `secret` is omitted. `DEFAULT_SIGNATURE_HEADER` names the
    default header (`'X-Approval-Signature'`); override via `signatureHeader`.
  - **Retry.** `5xx`, `408`, `429`, and network/timeout errors are retried with
    exponential backoff and full jitter, up to `maxAttempts` (default `3`); a
    `429` honors `Retry-After` (seconds or an HTTP date) in place of the
    computed backoff. Any other `4xx` fails on the first attempt.
  - **Durability.** The public `deliver()` method throws
    `WebhookDeliveryError` (`status?`, `attempts`, `cause?`) on final failure
    instead of swallowing it, so it can be bound as the `transport` of
    `plugins/notify`'s `OutboxNotificationAdapter` for at-least-once delivery
    across process restarts — no adapter shim needed.
  - Ships a new `HttpClient` port (a plain `fetch`-shaped function type) and
    `getDefaultHttpClient()`. **No new dependency** — the port is structurally
    satisfied by the global `fetch` (Node.js 18+); pass a custom `httpClient`
    to use a different implementation.

### Fixed — `PostgresAdapter`

Three defects affecting users on published `0.5.0`. If you use `PostgresAdapter`,
upgrading is recommended.

- **Cursor pagination silently corrupted every page after the first.**
  `getInstancesByCursor`'s cursor decoder split the `updatedAt_iso:id` string on
  the _first_ colon, but an ISO-8601 timestamp (e.g.
  `2026-06-26T09:00:00.000Z`) itself contains colons — so every decoded cursor
  had a truncated timestamp and a corrupted id, breaking every subsequent page
  fetch via `getInstancesByCursor`. Also hardened cursor encoding to normalize
  through `Date.prototype.toISOString()` regardless of the row value's shape.
  No migration needed.
- **`templateId` was silently dropped on every write and always read back as
  `''`.** `PostgresAdapter` had no `template_id` column, so
  `ApprovalInstance.templateId` was permanently lost for any instance persisted
  through this adapter. Fixed by adding a `template_id` column and including it
  in both the insert and read paths.
  **Action required on upgrade:** run the adapter's migration (its
  `CREATE TABLE`/`ALTER TABLE ... ADD COLUMN IF NOT EXISTS` statements, executed
  automatically the next time the adapter initializes) to add the new column —
  existing rows backfill to `''` until rewritten.
- **The `schema` option was interpolated into SQL without the safe-identifier
  validation `tablePrefix` already had**, an inconsistent injection surface at
  construction time. `schema` is now validated against the same
  `/^[a-z][a-z0-9_]*$/` pattern as `tablePrefix`, throwing
  `ApprovalValidationError` on an invalid value. No migration needed; only
  affects adapter construction with an attacker-controlled `schema` value.

## [0.5.0] - 2026-07-23

### Added — NestJS integration

- **`hierarchical-approval/nestjs`** — first-class NestJS support on its own
  tree-shakeable subpath. `@nestjs/common` is an **optional peer dependency**.
  - `HierarchicalApprovalModule.forRoot(options)` and `.forRootAsync(asyncOptions)`
    provide a configured `ApprovalEngine` under the `APPROVAL_ENGINE` token, with
    an `isGlobal` flag and `imports`/`inject`/`useFactory` async wiring.
  - `@InjectApprovalEngine()` decorator for injecting the engine into services.
  - The module stops the engine's escalation scheduler on application shutdown
    via `onModuleDestroy`.

### Added — adoption & discoverability

- `examples/playground/` — a StackBlitz-ready, in-browser runnable demo of a
  purchase-order approval chain, plus "Try it live" (RunKit + StackBlitz) links
  in the README.
- Expanded npm `keywords` for problem-based search (approval-workflow,
  maker-checker, four-eyes, delegation, escalation, …).

### Fixed

- Replaced the non-standard `peerDependenciesOptional` field with the correct
  `peerDependenciesMeta`, so `pg` (and now `@nestjs/common`) are properly marked
  optional and no longer emit install-time peer warnings.

## [0.4.0] - 2026-07-23

### Added — per-template analytics

- **Per-template breakdown in `getStatistics()`** — the returned
  `ApprovalStatistics` now includes a `byTemplate` map keyed by template name,
  each entry carrying `{ total, approved, rejected, pending }`. This lets
  dashboards break down approval volume and approval rate per workflow template
  without callers hand-rolling per-template queries.
  - To support this, `InstanceFilter` gained an optional `templateName` field,
    now honoured by `MemoryAdapter` (`getInstancesByFilter`,
    `getInstancesByCursor`) and `PostgresAdapter` (`getInstancesByFilter`,
    `getInstancesByCursor`). Both adapters remain backward-compatible — existing
    callers that omit the field are unaffected.
  - `byTemplate` is adapter-agnostic: built only from existing
    `getInstancesByFilter` counts plus `TemplateRegistry.list()`, so it works
    with any storage adapter with no new adapter methods. It respects the other
    filters (`documentType`, `submittedBy`, date range) and is empty when no
    templates are defined.

### Added — OpenTelemetry tracing plug-in

- **`hierarchical-approval/plugins/tracing`** — distributed tracing as an
  `IOperationMiddleware`, published on its own tree-shakeable subpath with
  **zero runtime dependencies**.
  - `TracingMiddleware` wraps every engine operation in a span named
    `approval.<operation>` carrying `approval.tenant_id`, `approval.actor_id`,
    and `approval.instance_id` attributes. On success it records
    `approval.result_status`/`approval.result_level` and status `OK`; on failure
    it calls `recordException`, tags `approval.error_code`, sets status `ERROR`,
    and re-throws (tracing never swallows an error). Overlapping same-key
    operations are paired LIFO via a per-correlation-key span stack.
  - `Tracer`/`TraceSpan`/`SpanStatus` ports model the `@opentelemetry/api`
    surface, so a real OpenTelemetry `Tracer` (`trace.getTracer(...)`) is
    structurally assignable and can be passed directly — the library never
    imports `@opentelemetry/api`. `SpanStatusCode` mirrors OTel's numeric codes.
  - `noopTracer` is the default, so adding the middleware without wiring a
    backend is a no-op.

### Added — repository governance & supply chain

- `SECURITY.md` (private vulnerability disclosure policy, supported versions),
  `CONTRIBUTING.md`, and a Contributor Covenant `CODE_OF_CONDUCT.md`.
- GitHub issue forms (bug report, feature request) + `config.yml`, a pull-request
  template, and `CODEOWNERS`.
- Dependabot configuration for weekly npm and GitHub Actions updates.

### Added — API documentation

- TypeDoc API reference generation via `npm run docs` (and `docs:watch`),
  covering the main entry point and every published subpath.
- CI validates that the API reference generates; a `docs.yml` workflow deploys it
  to GitHub Pages on release tags and manual dispatch.

### Changed

- `package.json` `exports` and the build now also expose the `plugins/tracing`
  subpath in ESM, CJS, and `.d.ts`.

### Tests

- Test suite grew from 380 to 397 passing tests covering the tracing span
  lifecycle, creation attributes, LIFO concurrency pairing, configuration, the
  no-op default, the public-export surface, and the per-template statistics
  breakdown (combined filtering and the empty-template case).

## [0.3.1] - 2026-06-26

### Docs

- Replace the README's Mermaid code blocks with pre-rendered PNG diagrams
  referenced by absolute URL, so the status lifecycle, approval flow, and
  architecture diagrams render on npmjs.com (which does not render Mermaid) as
  well as on GitHub.

## [0.3.0] - 2026-06-26

### Added — enterprise plug-in layer

Production-grade implementations of the existing engine extension points, each
published on its own tree-shakeable import subpath with **zero runtime
dependencies** (Node.js built-ins only). The core engine is unchanged.

- **`hierarchical-approval/plugins/audit`**
  - `HashChainAuditAdapter` — SHA-256 hash-chained, tamper-evident audit log.
    `verify()` detects content tampering, deletion, reordering, **and tail
    truncation** (via an in-process high-water mark or an explicit
    `expectedLength` anchor). Pluggable writer/reader; in-memory by default.
  - `RedactingAuditAdapter` — redacts configured PII field paths and free-text
    fields before forwarding to a wrapped adapter; original entries are never
    mutated.
  - `CompositeAuditAdapter` — fan out to multiple audit sinks with per-child
    fault isolation. Never throws.
- **`hierarchical-approval/plugins/metrics`**
  - `PrometheusMetricsAdapter` — accumulates counters/histograms and renders
    `scrape()` in Prometheus text exposition format.
  - `InMemoryMetricsAdapter` — `snapshot()` with count/sum/min/max/avg/p50/p95;
    O(1) ring-buffer sample retention.
  - `CompositeMetricsAdapter` — fan out to multiple metrics backends.
- **`hierarchical-approval/plugins/resilience`**
  - `RbacAuthorizationPolicy` — per-operation role rules with a default-deny
    posture and a pluggable role provider.
  - `CompositeAuthorizationPolicy` — combine policies with AND/OR semantics.
  - `RateLimitMiddleware` — token-bucket throttling keyed per actor + operation,
    with an injectable clock.
  - `LoggingMiddleware` — structured before/after/onError logging with timings.
- **`hierarchical-approval/plugins/notify`**
  - `OutboxNotificationAdapter` — transactional outbox with retry, exponential
    backoff, and a dead-letter queue for at-least-once delivery. Exposes
    `drain()`, `pending()`, and `deadLettered()`.
  - `TemplatedNotificationAdapter` — render a human-readable message per event
    type via a configurable template map.
  - `CompositeNotificationAdapter` — multi-channel fan-out with fault isolation.

### Changed

- `package.json` `exports` and the build now expose the four `plugins/*`
  subpaths in ESM, CJS, and `.d.ts`.

### Tests

- Test suite grew from 196 to 380 passing tests covering the new plug-ins
  (tamper detection, backoff/dead-letter, rate-limit math, RBAC, PII redaction,
  Prometheus exposition, and the public-export surface).

## [0.2.1] - 2026-06-23

- Documentation and tooling fixes; audit-log de-duplication in `MemoryAdapter`.

## [0.2.0] - 2026-06-23

- Advanced decision modes (`quorum`, `weighted`), `reassign()`, `getStatistics()`,
  and an injectable `BusinessCalendar`.

## [0.1.1] - 2026-06-21

- Initial published release line.
