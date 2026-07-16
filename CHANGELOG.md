# Changelog

All notable changes to `hierarchical-approval` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — richer statistics surface

`engine.getStatistics()` now aggregates beyond status counts:

- **`byTemplate`** — a `Record<templateName, count>` breakdown of matching
  instances, so dashboards can show volume per workflow without hand-rolled
  queries.
- **`avgCycleTimeMs`** — average time-to-resolution (`updatedAt - createdAt`)
  across resolved instances (approved, rejected, cancelled, expired). `0` when
  nothing has been resolved.
- **`medianCycleTimeMs`** — median time-to-resolution across resolved instances.
  `0` when nothing has been resolved.

Both cycle-time metrics exclude still-pending instances (whose resolution time
is unknown). The method stays adapter-agnostic — it reuses the existing
`getInstancesByFilter` (paginated, page size capped at `maxBulkItems`) and
`getOverdueInstances`, so it works with any storage adapter with no new adapter
methods.

### Tests

- `tests/integration/engine.statistics.test.ts` — per-template breakdown,
  average + median cycle time over resolved instances (with a controllable clock),
  and zero-valued cycle-time metrics when nothing is resolved.

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
