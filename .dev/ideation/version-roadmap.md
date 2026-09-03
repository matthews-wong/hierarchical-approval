# Release roadmap 0.8.0 → 2.9.0

Working notes for the release series. Each version ships one substantial,
independently useful change, gated on green CI before publish.

## Sequencing principle

Ordered by blast radius, not by appeal. Self-contained additions first; the
deep engine refactors (parallel branches, adapter interface) land on the
major boundaries where a breaking change is expected anyway.

## Planned

| Version | Change | Scope |
|---|---|---|
| 0.8.0 ✅ | Boolean condition expressions — `all` / `any` / `not`, nestable | ConditionEvaluator + validation |
| 0.9.0 ✅ | `updateData()` — re-evaluate the chain when document data changes mid-flight | Engine |
| 1.0.0 ✅ | Parallel branch groups — concurrent levels that join before advancing | Engine (flagship) |
| 1.1.0 ✅ | Approval reminders — recurring nudges before escalation | Scheduler plugin |
| 1.2.0 ✅ | Template inheritance — `extends` with level overrides | TemplateRegistry |
| 1.3.0 ✅ | Out-of-office cover (injected provider) | Resolver |
| 1.4.0 ✅ | Instance filtering by document data | Adapters |
| 1.5.0 ✅ | Request for information (hold, with paused deadlines) | Engine |
| 1.6.0 ✅ | Fix: PostgresAdapter dropped most instance updates | Adapters |
| 1.7.0 ✅ | Attachment references (deferred from 1.6.0) | Types + adapters |

| 1.8.0 ✅ | transferApprovals() + fix delegate/reassign on parallel branches | Engine |
| 2.1.0 ✅ | Sub-workflows — a level that spawns a child instance | Engine |
| 1.9.0 ✅ | getWorkload() — who owes a decision, and how overdue | Engine |
| 2.0.0 ✅ | Adapter interface v2 — required countInstances (breaking) | Adapters |
| 2.2.0 ✅ | Template export/import bundles | Engine |
| 2.3.x+ | To be planned | — |

Versions past 2.0.0 stay deliberately unplanned: the adapter break will
reshape what is cheap to build next, and committing now would be guesswork.

## Amendments

- **1.3.0 was re-planned.** The slot held "withdraw + amend for submitters",
  but `cancel()` already covered withdraw and `updateData()` (0.9.0) covered
  amend, so building it would have been padding. Out-of-office cover was pulled
  forward from 1.7.0 instead, per the no-padding rule below.

## Rules for the series

- Never publish on red CI.
- Every feature ships with tests that fail against the previous version.
- Breaking changes only on major boundaries, called out in CHANGELOG.
- No feature invented purely to fill a version slot — if a slot has no
  worthwhile change, the roadmap gets rethought rather than padded.
