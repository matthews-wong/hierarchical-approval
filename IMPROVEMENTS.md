# Improvements Log

This document summarizes the enhancements made to **hierarchical-approval** on top
of its initial feature set. Each section maps to one focused, independently
committed iteration, with rationale, the public API it adds, and how it is tested.

> **Status:** 195 tests passing · clean dual ESM/CJS build (`.d.ts` included) · `src` type-checks and lints clean.

---

## 0. Repository initialization

The project was placed under version control with a curated, logical history
rather than a single bulk commit:

- `git init` on `master`.
- Added the two files the repo was missing for publication: a root `.gitignore`
  (ignores `node_modules/`, `dist/`, `coverage/`) and an MIT `LICENSE`.
- Reconstructed development as **20 Conventional-Commit commits** following the
  natural build order — tooling → types → errors → utils → adapters → engine
  pieces → public entry → Postgres adapter → testing kit → tests → docs → CI.

The feature iterations below were then layered on top as additional commits.

---

## 1. Advanced decision modes — `quorum` & `weighted`

**Commit:** `feat(engine): add quorum and weighted approval modes`

### Why
Level completion previously supported only `any | all | majority`. Real ERP and
board approvals routinely need *thresholds* — "any 2 of 5 directors" — and
*weighted voting* — where a CFO's vote carries more weight than a manager's.

### What was added
Two new values for a level's `mode`:

| Mode | Passes when | Extra config |
|---|---|---|
| `quorum` | A fixed **N-of-M** number of approvals is reached | `minApprovals` |
| `weighted` | Cumulative approver **weight** meets a threshold | `threshold`, optional `weights` |

Both fail *fast and correctly*: a level is **rejected the moment its target
becomes mathematically unreachable** — e.g. a 2-of-3 quorum is rejected after the
second rejection (only one approver remains), and a weighted level is rejected
once the weight still achievable drops below `threshold`.

```ts
// Quorum: any 2 of 3 directors
{ level: 1, name: 'Board', mode: 'quorum', minApprovals: 2,
  approvers: [
    { type: 'user', userId: 'd1' },
    { type: 'user', userId: 'd2' },
    { type: 'user', userId: 'd3' },
  ] }

// Weighted: the CFO (weight 3) clears the threshold alone
{ level: 1, name: 'Exec', mode: 'weighted', threshold: 3,
  weights: { cfo: 3 },               // unlisted approvers default to weight 1
  approvers: [
    { type: 'user', userId: 'cfo' },
    { type: 'user', userId: 'mgr' },
  ] }
```

### Implementation notes
- Decision logic lives in `StateMachine.isLevelApproved` / `isLevelRejected`.
- `defineTemplate()` statically validates both modes (e.g. `minApprovals` is a
  positive integer; for all-static-user levels it must not exceed the approver
  count) so misconfiguration fails at definition time.
- Runtime guards throw clear errors if a resolved level can never satisfy its
  configured threshold.
- `minApprovals`, `threshold`, and `weights` are copied onto each level instance
  at submit/resubmit time so in-flight instances are insulated from template edits.

### Tests
Unit coverage in `tests/unit/StateMachine.test.ts` and end-to-end flows in
`tests/integration/engine.decisionModes.test.ts`.

---

## 2. Administrative `reassign()`

**Commit:** `feat(engine): add administrative reassign() operation`

### Why
`delegate()` is *voluntary* — the assigned approver initiates it. When an
approver is unavailable (on leave, left the company), an administrator needs to
**hand the task to someone else** without the original approver's involvement.

### What was added
```ts
await engine.reassign(instanceId, {
  reassignedBy: 'workflow-admin',
  fromApprover: 'mgr-1',
  toApprover: 'mgr-2',
  reason: 'Approver left the company',
});
```

Hard-swaps a still-pending approver on the current level. Guards reject
reassigning someone who has already acted, a non-approver, a duplicate, or
self; any active time-limited delegation on the slot is cleared.

### Wiring
Emits the new `approval:reassigned` event, records a `reassigned` audit action,
increments the `approval.reassigned` metric, and adds `reassign` to the
authorization-policy operation set — so it participates in the same
authz/middleware/audit/notification pipeline as every other operation.

### Tests
`tests/integration/engine.reassign.test.ts` (happy path + four guard cases).

---

## 3. Statistics aggregation — `getStatistics()`

**Commit:** `feat(engine): add statistics aggregation and business-day deadlines`

### Why
Dashboards and operational reporting need at-a-glance counts without callers
hand-rolling queries.

### What was added
```ts
const stats = await engine.getStatistics({ documentType: 'purchase_order' });
// {
//   total: number,
//   byStatus: { pending, approved, rejected, cancelled, expired },
//   overdue: number,        // pending past an escalation/expiry deadline
//   approvalRate: number,   // approved / (approved + rejected); 0 when none resolved
// }
```

Accepts an optional filter (`documentType`, `submittedBy`, `fromDate`/`toDate`).
It is **adapter-agnostic** — implemented purely with the existing
`getInstancesByFilter` count and `getOverdueInstances`, so it works with any
storage adapter (Memory, Postgres, custom) with no new adapter methods.

### Tests
`tests/integration/engine.statistics.test.ts` (empty tenant, status counts +
approval rate, documentType filter).

---

## 4. Business-day deadlines — injectable `BusinessCalendar`

**Commit:** `feat(engine): add statistics aggregation and business-day deadlines`

### Why
`escalationAfterDays` and `slaDeadlineDays` counted plain calendar days, so a
deadline set on a Friday could fall on a weekend. Enterprises expect SLAs in
**business days**.

### What was added
```ts
import { ApprovalEngine, weekendCalendar } from 'hierarchical-approval';

const engine = new ApprovalEngine({
  adapter,
  calendar: weekendCalendar({
    holidays: [new Date('2026-12-25'), new Date('2027-01-01')],
    // weekendDays: [5, 6],  // optional — e.g. Fri/Sat weekend
  }),
});
```

When a `calendar` is configured, all escalation/SLA day offsets are interpreted
as business days — skipping weekends and configured holidays. With the default
weekend calendar, `escalationAfterDays: 2` submitted on a Friday becomes due the
following Tuesday rather than Sunday.

### Implementation notes
- New `src/utils/BusinessCalendar.ts` exports the `BusinessCalendar` interface
  and a `weekendCalendar()` factory (configurable holidays and weekend days).
  Custom implementations can encode any regional rule.
- All date arithmetic in `submit`, `approve`, and `resubmit` now flows through a
  single private `deadlineFrom(from, days)` helper, which uses the calendar when
  present and falls back to calendar-day math otherwise. Behavior is unchanged
  for callers who don't configure a calendar.

### Tests
`tests/unit/BusinessCalendar.test.ts` (weekend/holiday/custom-weekend math) and
`tests/integration/engine.calendar.test.ts` (business-day vs calendar-day
deadlines, verified with a fixed injectable clock).

---

## Public API additions at a glance

| Symbol | Kind | Iteration |
|---|---|---|
| `ApprovalMode` += `'quorum' \| 'weighted'` | type | 1 |
| `ApprovalLevelConfig.minApprovals / threshold / weights` | fields | 1 |
| `engine.reassign(id, opts)` | method | 2 |
| `ReassignOptions`, `ReassignedEvent`, `'approval:reassigned'` | types/event | 2 |
| `engine.getStatistics(filter?)` | method | 3 |
| `ApprovalStatistics` | type | 3 |
| `BusinessCalendar`, `WeekendCalendarOptions`, `weekendCalendar()` | type/factory | 4 |
| `ApprovalEngineOptions.calendar` | option | 4 |

## Possible future iterations
- **Parallel branch groups** — true concurrent branches (e.g. Finance *and*
  Legal) that join before a downstream level.
- **Per-template / per-status analytics** breakdowns in `getStatistics`.
- **Cycle-time metrics** (average time-to-decision) in the statistics surface.
