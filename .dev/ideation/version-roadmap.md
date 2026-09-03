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
| 0.8.0 | Boolean condition expressions — `all` / `any` / `not`, nestable | ConditionEvaluator + validation |
| 0.9.0 | `updateData()` — re-evaluate the chain when document data changes mid-flight | Engine |
| 1.0.0 | Parallel branch groups — concurrent levels that join before advancing | Engine (flagship) |
| 1.1.0 | Approval reminders — recurring nudges before escalation | Scheduler plugin |
| 1.2.0 | Template inheritance — `extends` with level overrides | TemplateRegistry |
| 1.3.0 | Withdraw + amend flow for submitters | Engine |
| 1.4.0 | Approval policies as reusable named rule sets | Engine |
| 1.5.0 | Instance search — full filter grammar over data fields | Adapters |
| 1.6.0 | Attachment references on instances and decisions | Types + adapters |
| 1.7.0 | Out-of-office / auto-delegation windows | Engine |
| 1.8.0 | Sub-workflows — a level that spawns a child instance | Engine |
| 1.9.0 | Approval simulation / dry-run against historical data | Engine |
| 2.0.0 | Adapter interface v2 (breaking) | Adapters |
| 2.1.x+ | To be planned once 2.0.0 lands | — |

Versions past 2.0.0 stay deliberately unplanned: the adapter break will
reshape what is cheap to build next, and committing now would be guesswork.

## Rules for the series

- Never publish on red CI.
- Every feature ships with tests that fail against the previous version.
- Breaking changes only on major boundaries, called out in CHANGELOG.
- No feature invented purely to fill a version slot — if a slot has no
  worthwhile change, the roadmap gets rethought rather than padded.
