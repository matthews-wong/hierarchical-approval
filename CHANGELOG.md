# Changelog

All notable changes to `hierarchical-approval` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [1.1.0] - 2026-09-04

### Added — approval reminders

- **Levels can nudge their pending approvers before escalating.** Escalation
  reassigns work, which is the wrong instrument for an approval that is merely
  late; the only alternative was an out-of-band cron job reading the database.

  ```ts
  { level: 1, name: 'Manager', ...,
    reminderAfterDays: 2,   // first nudge two days after the level opens
    reminderEveryDays: 1,   // then daily
    maxReminders: 3 }       // default 3
  ```

  Emits `approval:reminder` (`level`, `recipients`, `reminderNumber`), records a
  `reminded` audit entry, and increments `approval.reminded`. Recipients exclude
  anyone who has already voted, so a half-decided quorum level stops pestering
  the approvers who did their part. Reminders stop when the level closes or the
  cap is reached, and never change who can approve or when the level escalates.

  `validateTemplate()` rejects non-positive intervals, a non-integer
  `maxReminders`, and `reminderEveryDays` without `reminderAfterDays` — which
  would configure a repeat for a reminder that never fires.

  New export: `ReminderEvent`. `EscalationSchedulerOpts` gains `onRemind`.

### Fixed — escalation could not reach every branch of a parallel group

- **Only the lowest-numbered branch of a parallel group could escalate.** Both
  the scheduler and `MemoryAdapter.getOverdueInstances` matched levels against
  `instance.currentLevel`, which names just one level of a group. An overdue
  upper branch was never fetched and never escalated — it would wait forever.
  Introduced with parallel groups in 1.0.0.

  Escalation now considers every open branch, and `escalateInternal` takes the
  level to escalate rather than assuming the current one.

  This also settles a pre-existing disagreement between the adapters:
  `PostgresAdapter` already scanned *all* levels for `escalationDueAt` while
  `MemoryAdapter` scanned one, so the same template escalated differently
  depending on which adapter was in use. Both now scan every open branch.

- **`getOverdueInstances` also reports due reminders** in both adapters —
  without which the scheduler would never see a reminder-due instance and no
  reminder would ever be sent.

## [1.0.0] - 2026-09-04

First stable release. The public API is now considered settled: breaking changes
from here get a major version.

### Added — parallel branch groups

- **Levels sharing a `group` name activate together and join before the chain
  advances.** Approvals were strictly sequential, so "Finance and Legal review
  concurrently, then it goes to the CEO" could only be modelled by picking an
  arbitrary order and making one wait on the other — inflating cycle time for no
  business reason. This was the last item on the roadmap in `IMPROVEMENTS.md`.

  ```ts
  levels: [
    { level: 1, name: 'Manager', ... },
    { level: 2, name: 'Finance', group: 'review', ... },
    { level: 3, name: 'Legal',   group: 'review', ... },
    { level: 4, name: 'CEO', ... },
  ]
  ```

  Both branches open at once, decisions arrive in any order, and level 4 stays
  `waiting` until every branch is approved. Rejecting any branch rejects the
  instance, as a rejection always has. A group may also lead the chain, in which
  case it opens at submit.

- **`approve()` and `reject()` take an optional `level`.** Inside a parallel
  group one person can sit on several open branches; recording their decision
  against a guessed branch would be silently wrong, so the engine throws and
  asks which branch is meant. Sequential templates never see this.

- **`getCurrentApprovers()` returns the union across every open branch.**
  `canApprove()` likewise considers any open branch the user is assigned to.

- **`validateTemplate()` rejects a non-contiguous group** — a group's levels must
  occupy consecutive level numbers, so that "advance past the group" and
  "advance past a level" cannot disagree about what comes next.

**Backward compatible.** A level without a `group` is its own group of one, and
all 673 pre-existing tests pass unchanged against the new engine.

## [0.9.0] - 2026-09-04

### Added — `updateData()`: edit a pending document and recompute its chain

- **`engine.updateData(instanceId, opts)` changes an in-flight instance's
  document data and re-evaluates the template's conditions against it.**
  Documents change after submission — a corrected line item, a reclassified
  vendor, a revised amount — and the chain computed at submit time can be wrong
  the moment that happens. The only previous remedy was to cancel and resubmit,
  which discarded every approval already collected along with its audit trail.

  ```ts
  await engine.updateData(instance.id, {
    updatedBy: 'buyer-1',
    data: { amount: 20000 },      // merged by default; mode: 'replace' swaps wholesale
    reason: 'Corrected line items',
  });
  ```

  `recomputeChain: false` applies a data correction without touching the chain.

- **Decided history is frozen.** Only levels after the current one are
  recomputed. A level that is already approved, or is actively collecting
  decisions, is never removed: a `skipLevels` condition that would drop it is
  ignored, because editing data must not retract an approval that was given. A
  condition that would *insert* a level at or before the current level throws
  `ApprovalValidationError` rather than silently dropping an approval step the
  template says is required.

  A future level that survives re-evaluation is preserved object-identical, so a
  delegation already arranged on it survives an unrelated edit elsewhere in the
  document.

- **Wiring:** emits `approval:data_updated` (`changedFields`, `addedLevels`,
  `removedLevels`), records a `data_updated` audit entry carrying the before and
  after data, increments `approval.data_updated`, and adds `updateData` to the
  authorization-policy operation set — so it runs through the same
  authz/middleware/audit/notification pipeline as every other operation.

  New exports: `UpdateDataOptions`, `DataUpdatedEvent`.

## [0.8.0] - 2026-09-04

### Added — boolean condition expressions

- **A rule's `when` now accepts `all`, `any` and `not` groups, nestable to any
  depth.** Conditions previously supported a single test or an array meaning
  AND, so "escalate when the amount is large **or** the vendor is high-risk"
  could not be written as one rule — it took two rules with duplicated
  `addLevels`, and anything involving negation or a mix of AND and OR had no
  expression at all.

  ```ts
  when: {
    any: [
      { all: [
          { field: 'amount', operator: '>', value: 1000 },
          { field: 'dept', operator: '==', value: 'engineering' },
      ] },
      { field: 'override', operator: '==', value: true },
    ],
  }
  ```

  A group sets exactly one combinator. `any` short-circuits on the first child
  that holds. New `ConditionExpression` and `ConditionGroup` types are exported
  from the package root.

  **Fully backward compatible.** A bare condition still works, and an array is
  shorthand for `all` — exactly what `when: [...]` already meant.

- **Condition trees are validated when the template is defined.** `validateTemplate()`
  and `defineTemplate()` now reject an empty `all`/`any`, a group setting more
  than one combinator, a non-array `all`/`any`, and a leaf missing its `field`
  or `operator` — reporting the offending path, e.g.
  `conditions[0].when.any[1].operator`. Previously a malformed condition was
  only discovered at submit time, on a real document.

  Operator *names* are deliberately not checked at definition time, because
  custom operators can be registered after a template is defined; an unknown
  operator still throws when the condition is evaluated.

- **`validateConditionExpression(expression, path)` is exported** for callers
  that build condition trees dynamically and want to check one before handing it
  to a template. It collects every problem rather than throwing on the first.

## [0.7.0] - 2026-09-04

### Fixed — two condition-evaluation bypasses

Both of these let a `ConditionRule` fire when it should not have, and because
conditions decide which levels an instance gets, a spurious match on a
`skipLevels` rule **removes approval levels from a live document**. Anyone using
`skipLevels` — or `addLevels` to *escalate* above a threshold — should upgrade.

- **Numeric operators no longer coerce non-numbers to zero.** `>`, `<`, `>=` and
  `<=` compared with `Number(actual)`, and `Number()` maps `null`, `''`, `'   '`,
  `[]` and `false` all to `0`. So a fast-track rule like
  `{ when: { field: 'amount', operator: '<', value: 5000 }, skipLevels: [2, 3] }`
  matched a purchase order whose `amount` was `null` or blank, silently skipping
  two approval levels on exactly the documents whose value was unknown. `false`
  and `[]` did the same, and `true` compared as `1`.

  A numeric comparison against a non-number is now treated as *undecidable* rather
  than false-y: it reports **no match**, which is the outcome `undefined` has
  always produced. Accepted operands are finite numbers, bigints, `Date`
  (compared as epoch milliseconds), and numeric strings such as `'100'` or
  `' 1e3 '` — ERP payloads routinely arrive as JSON strings, so string comparison
  is retained. Rejected: `null`, `undefined`, booleans, arrays, objects, blank
  strings, `NaN` and `Infinity`.

  **Behaviour change.** A rule that was matching on blank or boolean data stops
  matching. That is the fix, but it does change which levels such an instance
  gets, so re-check any template whose conditions run against optional fields.
  `==` and `!=` are untouched — they were already strict.

- **Dot-path field lookup now reads own properties only.** `getField` tested
  `key in obj`, which walks the prototype chain, so a condition on `isFastTrack`
  was satisfied by an inherited `Object.prototype.isFastTrack` that no document
  ever declared — turning any prototype pollution elsewhere in the dependency
  tree into an approval-level bypass. Resolution now uses
  `Object.prototype.hasOwnProperty`, so a segment that is not an own property
  resolves to `undefined` exactly as an absent field does. This also closes
  `__proto__`, `constructor` and `prototype` as readable paths.

  **Behaviour change.** Context data whose fields live on a prototype (a class
  instance with getters, rather than a plain object) no longer resolves. Plain
  objects, arrays, array indices and `Object.create(null)` objects are
  unaffected, and context data does not survive JSONB round-tripping as a class
  instance in any case.

### Added

- **`toComparableNumber(value)` is exported from the package root.** The same
  strict coercion the built-in numeric operators use, returning `number` or
  `null`, so a custom operator registered with `registerConditionOperator()` can
  inherit the identical semantics instead of re-introducing `Number()`. The
  README's `between` recipe now uses it — the previous version of that snippet
  demonstrated the zero-coercion bug.

### Tests

- Restored the **17 `ConditionEvaluator` unit tests that commit `8d648d8`
  deleted**, having replaced the suite body with a `// ... existing tests ...`
  placeholder and a single test. Coverage of the evaluator had silently dropped
  to 74% of statements and 56% of functions.
- Added 36 tests across the two fixes (per-type non-comparable operand matrix for
  each numeric operator, the `skipLevels` bypass scenario, prototype-pollution
  guards, `toComparableNumber` directly) plus an executable copy of the README's
  custom-operator recipes, so a documented snippet cannot rot or stop compiling.
  All 24 of the pre-existing-bug assertions were confirmed to fail against the
  unfixed source.

## [0.6.0] - 2026-08-21

### Fixed — event delivery, template reads, and the CI lint gate

- **A throwing `engine.on()` listener no longer breaks the operation that emitted
  the event.** `EventBus` delivered events straight through `eventemitter3`, which
  invokes listeners synchronously and does not swallow exceptions — and the engine
  emits *after* persisting but *before* dispatching notifications and running
  after-middleware. So one buggy subscriber would reject `approve()` with its own
  error (while the instance stayed persisted as approved), skip notification
  dispatch entirely, leave a tracing span opened and never ended, and suppress the
  `approval:completed` emit on the following line. Listener failures are now
  isolated per listener and reported via the engine's logger; a rejecting `async`
  listener is caught too, instead of surfacing as a process-level
  `unhandledRejection`. **Behaviour change:** a listener error no longer propagates
  to the caller. Register an `onListenerError` sink by passing a `logger`, or use
  `EventBus.setListenerErrorHandler` directly.
- **`approval:completed` is now delivered to notification adapters.** It was
  emitted on the in-process bus only, so a webhook/email integrator never learned
  a document had been fully approved and had to infer it from `approval:approved`
  plus `isFinal`. Dispatched on both the normal-completion and `override` paths.
- **`PostgresAdapter.getTemplate`/`listTemplates` now return `createdAt` as a real
  `Date`.** They returned the JSONB payload raw, so `createdAt` was an ISO string
  despite `ApprovalTemplate` typing it as a `Date`. `TemplateRegistry.update()`
  threaded that string into the next `saveTemplate()`, which called
  `createdAt.toISOString()` on it — meaning **`engine.updateTemplate()` failed 100%
  of the time against real PostgreSQL** while passing against `MemoryAdapter`,
  which tolerates the string silently. No migration needed.
- **CI enforces lint again.** The workflow ran `npm run lint || true`, so lint could
  never fail a build; an unused import had already accumulated on `main` as a
  result. The `|| true` is gone.

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

### Added — `plugins/scheduler`, and the `schedulerAdapter` option now works

- **`hierarchical-approval/plugins/scheduler`** — ships `InMemorySchedulerAdapter`,
  the first reference implementation of the `ISchedulerAdapter` port, which until
  now was exported from the package root with no implementation anywhere to copy.
- **`ApprovalEngineOptions.schedulerAdapter` was a no-op.** It was declared and
  documented as "Replaces built-in setInterval polling", but `scheduleAt` and
  `cancel` were never called — an injected BullMQ/Temporal/cron scheduler was
  silently ignored while the built-in poller kept running. When supplied it now
  drives the periodic scan via self-rescheduling one-shot calls. Default
  behaviour with no option supplied is unchanged.

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

### Fixed — `MemoryAdapter` and notifications

- **`TemplatedNotificationAdapter`** — now logs fatal events (notification render/send failures) at the `fatal` level instead of `error`.
- **`MemoryAdapter`** — `getInstancesByFilter` now honors `fromDate`/`toDate` (previously the JSON-cloned string dates made the comparison a no-op and both bounds silently matched nothing). `getTemplate`/`listTemplates` now return `createdAt` as a real `Date`, matching the `ApprovalTemplate` contract.

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
