# Changelog

All notable changes to `hierarchical-approval` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [3.7.0] - 2026-09-04

### Fixed — `override()` and expiry did not end the sub-workflow family

3.0.0 made a finished parent stop its children and report to its own parent,
but wired that into `approve()`, `reject()` and `cancel()` only. `override()`
and deadline expiry are terminal too, and were missed — so the fix was
incomplete in exactly the two paths nobody watches.

- **An expired child left its parent waiting forever.** The child reached
  `cancelled`, but never told the parent, which sat pending on an approval that
  could now never happen. A permanent deadlock, and the more serious of the two.

- **An overridden parent left its children running** — still notifying, still
  escalating, still in `getWorkload()`, for a decision whose outcome nobody
  would read.

Both now run the same post-decision step as every other terminal path.
`override()` continues to bypass the parent's own remaining levels, which is
what an administrative override is for; what changes is that it no longer
strands the work it started.

## [3.6.0] - 2026-09-04

### Fixed — `resubmit()` rebuilt an incomplete chain

- **A resubmitted approval could never finish.** `resubmit()` was a third
  hand-written copy of level construction, after `submit()` and
  `recomputeFutureChain()` (unified in 3.0.0), and the only one that decided
  what to open by **array index** rather than by group. On a template whose
  chain begins with a parallel group, resubmitting opened just the first branch
  and left the rest of the group behind.

  It also dropped `group`, `subWorkflow`, `escalationAfterHours` and every
  reminder field — so a sub-workflow level came back unbound and threw
  "No approvers resolved for this level" the moment the chain reached it,
  leaving the approval permanently stuck.

  All three paths now go through the same `buildLevelInstance()`.

### Changed — the release audit gate distinguishes a flaky endpoint from a real CVE

- `npm audit` exits non-zero both for "found an advisory" and for "could not
  reach the advisory endpoint", and the v3.1.0 publish was blocked by the
  latter. The CI and publish workflows now retry **only** the transient case,
  with backoff.

  A genuine high/critical advisory still fails on the first attempt, and an
  endpoint that stays unreachable still fails the build — refusing to publish
  unaudited, rather than passing silently the way an `|| true` would.

## [3.5.0] - 2026-09-04

### Fixed — an approval could complete with a branch rejected and another never decided

**The most serious defect found in this audit. Upgrade if you use
`returnTo: 'previous'` with parallel branch groups.**

Rejecting one branch of a parallel group with `returnTo: 'previous'` sent the
chain back a level but left the rest of the group as it was — the rejected
branch still `rejected`, its sibling still `pending`. Neither was `waiting`, and
the engine treats "no waiting level" as "nothing left to do". So when the
earlier level was approved again, the instance was marked **`approved`**:

- with one branch **rejected**, and
- with another branch **nobody had ever decided**.

A document could therefore reach fully-approved without Finance ever approving
it and over Legal's explicit rejection.

Two independent fixes, because one of them should never have been needed:

- **Returning to a previous level now resets every level above it** to a clean
  `waiting` state, clearing decisions, approvers and deadlines so the chain
  replays properly. A branch that had already approved must decide again — its
  approval was for a version that was sent back.

- **Completion now requires that every level actually be `approved` or
  `skipped`.** "No next group" alone is not enough. If the two ever disagree the
  engine throws `INCOMPLETE_CHAIN` naming the offending levels, rather than
  recording an approval nobody gave. This is a tripwire that should be
  unreachable — it exists because the state it catches was reachable.

  `override()` is unaffected: bypassing the remaining levels is exactly what an
  administrative override is for.

## [3.4.0] - 2026-09-04

### Fixed — notifications went to the wrong people

`NotificationEvent.recipients` is what an adapter actually delivers to, and it
was read from the single level matching `instance.currentLevel`. That was wrong
in two directions at once.

- **An approver on any branch of a parallel group except the lowest was never
  notified.** They were not told work had arrived, not told the instance
  advanced — nothing. Combined with the inbox bug fixed in 3.3.0, an
  upper-branch approver had no way at all to learn they owed a decision.
  Recipients are now the union across every open level, matching what
  `getCurrentApprovers()` has returned since 1.0.0.

- **An event that already named its own audience had it overwritten.** A comment
  mentioning one person was delivered to the current level's approvers instead
  of the person mentioned; a reminder aimed at those who had not yet voted, and
  a clarification request addressed to the submitter, were redirected the same
  way. An event that names recipients now keeps them.

  This had been latent since mentions were added in 2.8.0: the payload carried
  the right audience and the adapter boundary discarded it.

- **`ApprovalTestKit.fullyApprove()` could not drive a parallel group.** It read
  `instance.currentLevel`, which does not move until the whole group closes, so
  it approved the lowest branch and then re-offered the same decision until the
  engine refused it. It now walks every open level.

## [3.3.0] - 2026-09-04

### Fixed — an approver on an upper parallel branch had an empty inbox

**Affects `MemoryAdapter` only; `PostgresAdapter` was already correct**, so the
same deployment behaved differently depending on which adapter was in use.

- **`getInstancesByApprover` matched only the level equal to
  `instance.currentLevel`.** That names a single level, so inside a parallel
  group it identifies just the lowest branch. An approver assigned to any branch
  above it was invisible:

  - **`getPendingFor()` returned nothing for them** — their own queue was empty
    while they held open work, so they had no way to know it was theirs.
  - **`transferApprovals()` scanned nothing for them**, silently leaving a
    departing colleague's upper-branch approvals behind. That is exactly the
    "missing one leaves an approval that can never complete" failure the sweep
    was built to prevent.

  It now matches any open level, as `PostgresAdapter` always did.

  This is the third place `currentLevel` was used as though it named the whole
  open frontier — after escalation in 1.1.0 and `delegate`/`reassign` in 1.8.0.

## [3.2.0] - 2026-09-04

### Fixed — `getStatistics().overdue` ignored most of its filter

- **A filtered statistics call could report more overdue approvals than it
  reported approvals.** `getStatistics()` passes its filter straight to
  `getOverdueInstances()`, which honoured only `documentType` and `submittedBy`
  — in both adapters. `templateName`, `fromDate`, `toDate` and the `data`
  matching from 1.4.0 were silently dropped, so `overdue` was counted across the
  whole tenant while `total`, `byStatus` and `cycleTime` respected the filter.

  A per-template dashboard would show, say, one pending purchase order and two
  of them overdue.

  Both adapters now apply the whole filter. `MemoryAdapter` reuses the same
  `applyFilter` every other query goes through, rather than keeping a
  hand-picked subset that could drift again; `PostgresAdapter` adds the missing
  clauses, including the parameterised JSONB path lookup, alongside its existing
  overdue predicates.

## [3.1.0] - 2026-09-04

### Fixed — escalation ladders drifted on parallel branches

- **Two identically configured branches of one parallel group escalated on
  different schedules.** Rung delays are documented as measured from when the
  level opened, and the open time was inferred by scanning the audit trail for
  that level's `level_advanced` or `submitted` entry. But a `level_advanced`
  entry carries only the group's *lowest* level number, so an upper branch never
  found one, fell back to "now", and measured each rung from the previous
  escalation instead.

  With a `[2 days, 4 days]` ladder, the lower branch scheduled its second rung
  for day 4 as documented while the upper branch scheduled it for day 6.

### Added — `ApprovalLevelInstance.openedAt`

- **A level now records when it started collecting decisions**, and escalation
  reads that instead of reconstructing it. Recording the fact beats inferring it:
  the audit trail was never designed to identify one branch of a group, and the
  inference failed silently when it could not.

  Instances submitted before 3.1.0 and still in flight have no `openedAt`, so
  the audit scan is kept as a fallback for them. New instances never use it.

## [3.0.0] - 2026-09-04

Three defects found by auditing the interactions between features added across
2.x, rather than by adding anything new.

### Fixed — `updateData()` built condition-added levels wrong

- **A level a condition added during `updateData()` silently lost its `group`,
  `subWorkflow`, `escalationAfterHours` and reminder configuration.** Levels
  were constructed in two places — `submit()` and `recomputeFutureChain()` —
  and the second copy had never been updated as fields were added across 1.0.0
  to 2.6.0. The consequences were quiet and serious:

  - a condition-added **parallel group ran sequentially**, one branch at a time,
    because the levels came back without their `group`;
  - a condition-added **sub-workflow level lost its binding**, then failed with
    "No approvers resolved for this level" when reached — leaving an approval
    that could never advance;
  - hour-based escalation and reminders simply never fired.

  A level whose configuration was unchanged was carried over intact, so this
  only bit templates whose conditions *add* levels — and it bit them silently.

  Both paths now go through one `buildLevelInstance()`, so a field cannot be
  added to a level in one place and forgotten in the other. This is the same
  failure the 1.6.0 Postgres column list had, in a different file.

### BREAKING — a finished parent no longer leaves its sub-workflow children running

- **Cancelling or rejecting a parent left its child approval pending forever.**
  The child kept notifying, kept escalating, and kept appearing in
  `getWorkload()` — asking people to decide something whose outcome nobody would
  ever read, since `propagateToParent()` ignores a parent that is no longer
  pending. Children of a terminal parent are now cancelled, with the reason
  naming the parent, and the child's own audit trail is left intact rather than
  deleted.

  **Behaviour change:** a child that used to stay open now reaches `cancelled`.
  Anything counting open approvals, or waiting on a child whose parent has
  ended, will see different numbers — correct ones.

- **`purgeInstances()` orphaned sub-workflow children.** It removed the parent
  and left the child behind, holding a `parentInstanceId` pointing at a row that
  no longer existed — unreachable, and invisible to a purge scoped by document
  type, since a child usually has a different one. A purge now takes the whole
  sub-workflow family together, parents first, deduplicated so a parent and
  child sharing a terminal status are each reported once.

## [2.9.0] - 2026-09-04

### Added — `simulate()`

- **Dry-runs a document through a template against scripted decisions.**
  `explainChain()` (2.7.0) says what the chain will be; nothing said what
  happens *to* it. Answering "if the CFO rejects at level 3, does it go back to
  the submitter or die?" meant submitting a real approval into real storage and
  cleaning it up afterwards, or reasoning about the state machine by hand.

  ```ts
  await engine.simulate({
    templateName: 'purchase-order',
    data: { amount: 20000 },
    submittedBy: 'buyer-1',
    decisions: [{ approve: 'mgr-1' }, { reject: 'cfo', reason: 'over budget' }],
  });
  // { finalStatus, levels, transcript, unreachedLevels, incomplete }
  ```

- **Nothing escapes the simulation.** It runs against a private in-memory store
  seeded with a copy of the template, with the notification, audit and metrics
  adapters and the authorization policy detached — so a dry run cannot page an
  approver, write somebody's audit log, or move a counter.

- **Custom resolvers and approver types are copied across.** A simulation that
  could not resolve the caller's own `dynamic` approvers would answer a
  different question from the one asked.

- **A refused decision stops the run and is reported, not thrown** — wrong
  approver, wrong level, already acted. The refusal is usually the answer the
  caller was looking for, and throwing would discard the transcript that
  explains how the run got there.

  New exports: `SimulationResult`, `SimulationStep`, `SimulatedDecision`.

## [2.8.0] - 2026-09-04

### Added — comment threads

- **Comments are addressable objects rather than audit entries alone.** There
  was no id to point at, so no way to reply to a comment, and no way to tell
  somebody a remark was aimed at them — discussion moved to email, where the
  approval record could not see it.

  ```ts
  await engine.addComment(id, { actorId: 'mgr-1', comment: 'Need the quote.' });
  const [question] = await engine.getComments(id);
  await engine.addComment(id, {
    actorId: 'buyer-1',
    comment: 'Attached now.',
    parentCommentId: question.id,
    mentions: ['mgr-1'],
  });
  ```

- **`approval:commented` is addressed to the people the comment mentions**, not
  to the current approvers. A remark aimed at somebody should reach them, and
  one aimed at nobody should not page the whole level.

- **`getComments()` returns a flat list carrying `parentCommentId`**, oldest
  first, rather than a nested tree: a UI that wants threads can build them, and
  one that wants a chronological feed does not have to flatten a structure it
  never wanted. Replying to a comment that is not on the approval is rejected.

  Comments are still written to the audit trail — the record of who said what
  belongs there. `addComment()` keeps its `Promise<void>` signature, so nothing
  calling it needs to change.

  New exports: `Comment`, `CommentedEvent`. `ApprovalInstance` gains `comments`.

### Fixed — MemoryAdapter left some timestamps as strings

- **`attachments[].addedAt`, `infoRequest.askedAt` and `levels[].reminderDueAt`
  read back as strings, not `Date`s.** `MemoryAdapter` clones through JSON and
  revives date fields by an explicit list, which these were missing from —
  while `PostgresAdapter` revived them correctly. The two adapters therefore
  disagreed, and any code trusting the declared `Date` type broke under one of
  them only. Affected `addedAt` since 1.7.0 and `askedAt` since 1.5.0.

## [2.7.0] - 2026-09-04

### Added — `explainChain()`

- **Explains why a chain resolves the way it does.** `previewApprovalChain()`
  answers *what* the chain will be; nothing answered *why*, so "why does this
  purchase order have a CFO level?" meant reading the template and
  re-evaluating its conditions by hand — the most common support question about
  an approval engine, and the one it was worst at answering.

  ```ts
  await engine.explainChain('purchase-order', data, 'buyer-1');
  // levels:  [{ level: 3, name: 'CFO', source: 'condition', addedByRule: 0, … }]
  // skipped: [{ level: 2, name: 'Finance', skippedByRule: 1 }]
  // rules:   [{ index: 0, matched: true, addsLevels: [3], skipsLevels: [] }, …]
  ```

- **Every rule is reported, matched or not**, along with what it *would* add or
  skip — which is how you find the rule that was supposed to fire and didn't,
  not just the ones that did.

- **Failures are described rather than thrown.** A level whose approvers cannot
  be resolved is still listed, carrying `resolutionError`; a rule that throws —
  an unregistered operator, a malformed group — is reported against that rule
  and the rest of the explanation still returns. A diagnostic is least useful at
  exactly the moment a broken rule would make it throw.

- Reads nothing and writes nothing, so it is safe to expose to a support UI.
  Sub-workflow levels are marked with their child template and skip approver
  resolution, since nobody approves them directly.

  New exports: `ChainExplanation`, `ExplainedLevel`, `ExplainedSkip`,
  `ExplainedRule`.

## [2.6.0] - 2026-09-04

### Added — escalation ladders

- **`escalationSteps` escalates repeatedly, up a chain.** A single `escalation`
  could only ever fire once, so a request that stalled past its second deadline
  had nowhere further to go — the usual "chase the manager, then the director,
  then the VP" pattern had to be built outside the engine, on top of the events.

  ```ts
  escalationSteps: [
    { afterDays: 2, escalateTo: { type: 'user', userId: 'director' } },
    { afterDays: 4, escalateTo: { type: 'user', userId: 'vp' } },
    { afterDays: 7, escalateTo: { type: 'role', role: 'exec' } },
  ]
  ```

  Rungs are sorted by delay and fire in order, each **adding** an approver rather
  than replacing one: escalation widens the pool, it does not hand the work over.

- **Delays are measured from when the level opened, not from the previous
  escalation**, so a ladder reads the way it is written. The level's opening
  time is recovered from its `submitted` / `level_advanced` audit entry.

- Rungs accept `afterHours` as well as `afterDays`, counted through the
  working-hours calendar from 2.5.0 when one is configured. A per-level
  `escalationAfterDays`/`escalationAfterHours` still decides *when* the first
  rung fires — it is the more specific statement about that level — while the
  ladder supplies *who*.

- Templates carrying only the single-step `escalation` behave exactly as before;
  the ladder takes precedence when both are set. Levels track progress in
  `escalationStep`, and the ladder is captured in the template snapshot, so an
  in-flight approval keeps the ladder it was submitted under.

  New exports: `EscalationStep`. `ApprovalTemplateConfig` gains
  `escalationSteps`; levels gain `escalationStep`.

## [2.5.0] - 2026-09-04

### Added — deadlines in working hours

- **`escalationAfterHours` on a level and `slaDeadlineHours` on a template.**
  Deadlines were whole days, but ERP SLAs are quoted in hours far more often —
  "respond within four working hours" — and approximating that as a fraction of
  a day counted evenings and weekends, so a request submitted at 16:00 on a
  Friday was overdue before anybody could have looked at it.

- **`businessHoursCalendar({ workdayStartHour, workdayEndHour, weekendDays,
  holidays })`** advances the clock only through the configured working window.
  A `from` outside working hours is first moved to the next working moment, so a
  deadline never starts counting from a time nobody was at work.

  ```ts
  const engine = new ApprovalEngine({
    adapter,
    calendar: businessHoursCalendar({ workdayStartHour: 9, workdayEndHour: 17 }),
  });
  // Friday 16:00 + 4 working hours -> Monday 12:00
  ```

- **`BusinessCalendar.addBusinessHours` is optional.** `weekendCalendar` knows
  whole days only; given an hour-based deadline the engine falls back to elapsed
  clock time rather than quietly pretending the calendar was applied. A custom
  calendar opts in by implementing the method.

- `validateTemplate()` rejects setting both units on the same level or template,
  and non-positive hour values.

  New exports: `businessHoursCalendar`, `BusinessHoursCalendarOptions`.

## [2.4.0] - 2026-09-04

### Added — `DigestNotificationAdapter`

- **Batches notifications per recipient instead of sending one per event.** An
  approver on twenty documents received twenty separate messages a day, which is
  how approval email ends up filtered into a folder nobody reads — the
  notifications defeat themselves.

  ```ts
  import { DigestNotificationAdapter } from 'hierarchical-approval/plugins/notify';

  const digest = new DigestNotificationAdapter({
    intervalMs: 15 * 60_000,
    send: async ({ recipient, events }) => mailer.send(recipient, summarise(events)),
  });
  ```

- **Urgent events still go straight through.** Batching a rejection or a
  completed approval behind a digest window would make the library's own
  notifications the reason a decision was late, so `approval:rejected`,
  `approval:completed`, `approval:sla_breached` and `approval:expired` bypass
  the buffer by default — configurable via `passthrough`.

- **`maxBatchSize`** (default 50) flushes a recipient early under a burst so the
  buffer stays bounded, and flushes only *that* recipient: a burst aimed at one
  person must not force everybody else's digest out early. Omit `intervalMs` to
  disable the timer and drive `flush()` from a cron job or queue worker instead.

- A failed `send` is logged and swallowed, as the notification-adapter contract
  requires, and the buffer is cleared before sending so a failure cannot replay
  the same events into every subsequent digest.

- Buffers are in memory: a restart drops what has not been flushed. That is the
  right trade for a convenience digest but not for delivery guarantees — put
  `OutboxNotificationAdapter` underneath when an event must not be lost.

  New exports from `hierarchical-approval/plugins/notify`:
  `DigestNotificationAdapter`, `DigestNotificationAdapterOptions`, `Digest`,
  `DigestSendFn`.

## [2.3.0] - 2026-09-04

### Added — retention

- **`purgeInstances()` removes finished approvals older than a cut-off.**
  Approval tables only grow, and data-minimisation rules eventually require old
  records to go. There was no way to remove one, so operators reached around the
  library and deleted rows directly — which is exactly where orphaned audit rows
  and half-deleted instances come from.

  ```ts
  await engine.purgeInstances({
    olderThan: new Date('2024-01-01'),
    statuses: ['approved', 'rejected'],
    dryRun: true,
  });
  ```

- **Only terminal instances are eligible.** A pending approval is live work, and
  deleting one would strand a document with no way to finish and no record of
  why. A non-terminal status is rejected rather than quietly ignored, because a
  caller who asked to purge pending work has misunderstood something and should
  hear about it. The engine re-checks each instance's status and age before
  deleting, so a custom adapter with a loose filter still cannot remove live
  work.

- **`IStorageAdapter.deleteInstance` is optional.** For many deployments the
  approval trail *is* the compliance record and the right answer is that nothing
  is ever deleted — an adapter expresses that by not implementing the method,
  and `purgeInstances()` then throws rather than reporting a successful purge of
  nothing. Both bundled adapters implement it; `PostgresAdapter` removes audit
  rows before the instance row, since orphaned audit rows are a better failure
  mode than audit rows outliving nothing.

  New export: `PurgeResult`.

## [2.2.0] - 2026-09-04

### Added — template export / import

- **`exportTemplates()` and `importTemplates()` move approval configuration
  between environments.** Templates are authored in a sandbox, reviewed, then
  promoted — but the only way to carry them across was to read `listTemplates()`
  and re-post the rows, which dragged each environment's own `id`, `tenantId`
  and version lineage along. Those either collided on arrival or silently
  claimed a history the target never had.

  ```ts
  const bundle = await sandbox.exportTemplates(['PO', 'INV']);
  await production.importTemplates(bundle, { mode: 'upsert', dryRun: true });
  ```

  A bundle is plain JSON, version-stamped, and carries no environment-specific
  fields — they are stripped, not blanked, so a round trip cannot reintroduce a
  stale id. The target assigns its own identity.

- **`mode: 'create'`** (default) skips templates that already exist;
  **`'upsert'`** updates them, bumping the version and recording
  `previousVersionId` exactly as `updateTemplate()` does. `dryRun` reports
  without writing.

- **Every template is validated before any is written.** A half-applied bundle
  is worse than one rejected outright: the tenant ends up matching neither
  environment and the operator cannot tell which half landed. Validation
  failures reject the whole bundle and name the offending template; storage
  errors during the write phase are still reported per template, since those can
  occur after validation passes.

  Import also rejects an unsupported `bundleVersion`, an empty bundle, and
  duplicate names within one bundle.

  New exports: `TemplateBundle`, `ImportResult`, `TEMPLATE_BUNDLE_VERSION`.

## [2.1.0] - 2026-09-04

### Added — sub-workflows

- **A level can delegate to a whole separate approval.** "A capital request over
  1M needs its own board approval before this purchase order can proceed" could
  only be modelled by flattening the board's chain into the purchase order's —
  duplicating it in every template that needed it, and losing the board approval
  as a thing with its own identity, audit trail and lifecycle.

  ```ts
  { level: 2, name: 'Board approval', mode: 'any', approvers: [],
    subWorkflow: { templateName: 'BOARD' } }
  ```

  When the level opens, a child instance is submitted against the named
  template, carrying the parent's document data so the child's own conditions
  see the same document. The parent level stays open, with no approvers of its
  own, until the child finishes.

- **An approved child advances the parent; any other terminal outcome rejects
  it.** Rejected, cancelled and expired all collapse into one rejection
  deliberately: a parent that treated a cancelled child as "carry on" would
  advance past a gate nobody cleared.

- **Children are spawned outside the parent's optimistic write.** The child's own
  `submit()` reads and writes; nesting that inside the parent's compare-and-set
  would turn a slow child template into spurious version conflicts on the
  decision the user just made. The same applies in reverse when a child returns
  its outcome.

- **Nesting is capped at five levels**, and `validateTemplate()` rejects a
  template that would spawn itself, sets both `approvers` and `subWorkflow`
  (whose approvers would never be asked), or names no child template. A
  sub-workflow level is exempt from the "must have at least one approver" rule,
  since its child decides it.

  New exports: `SubWorkflowConfig`, `SubWorkflowEvent`. `ApprovalInstance` gains
  `parentLevel` and `subWorkflowDepth`; levels gain `childInstanceId` and
  `subWorkflowTemplate`.

## [2.0.0] - 2026-09-04

### BREAKING — `IStorageAdapter` requires `countInstances`

**Only affects custom storage adapters.** The bundled `MemoryAdapter` and
`PostgresAdapter` implement it; if you use those, upgrading needs no code
change (run `migrate()` if you have not since 1.7.0).

Reporting needs counts far more often than rows. `getStatistics()` alone issued
`4N + 5` count queries for a tenant with N templates, and every one of them went
through `getInstancesByFilter(…, { limit: 1 })` — making the database compute the
count *and* serialise a complete instance row, JSONB levels and document data
included, only to discard it. `healthCheck()` did the same.

```ts
countInstances(tenantId: string, filter: InstanceFilter): Promise<number>;
```

`PostgresAdapter` answers it with a bare `SELECT COUNT(*)`: no row payload, no
`COUNT(*) OVER()` window, and the planner is free to satisfy it from an index
rather than touching the JSONB columns at all. Every filter — including the
`data` dot-path matching from 1.4.0 — is supported and parameterised.

**Migrating a custom adapter.** One line restores the previous behaviour, and
you can replace it with a real count query whenever it suits:

```ts
countInstances = (tenantId, filter) =>
  this.getInstancesByFilter(tenantId, filter, { limit: 1, offset: 0 }).then((r) => r.total);
```

No behaviour changes for callers: `getStatistics()` and `healthCheck()` return
exactly what they did, computed without fetching rows nobody reads. The
cycle-time sweep still reads rows, because it needs their timestamps.

## [1.9.0] - 2026-09-04

### Added — `getWorkload()`

- **Reports who currently owes a decision, and how overdue they are.**
  `getStatistics()` answers how the tenant is doing; nothing answered who is
  holding it up — the question behind rebalancing a queue, spotting the approver
  who has been on leave for a week, or deciding whom to `transferApprovals()` a
  departing colleague's work to.

  ```ts
  await engine.getWorkload({ documentType: 'purchase_order' });
  // [{ approverId: 'alice', pending: 12, instances: 11, overdue: 3, onHold: 1,
  //    oldestPendingAt: …, oldestAgeMs: 604800000 }, …]
  ```

  Sorted busiest first. `pending` counts open **levels** while `instances`
  counts distinct documents — they differ when one person holds several branches
  of a parallel group. `overdue` measures against each level's escalation
  deadline, and `onHold` counts work paused by a clarification request.

- **An approver who has already voted is not counted**, even while the level
  stays open collecting other votes: they owe nothing more, and counting them
  would overstate the queue of every quorum and weighted level.

- Computed from pending instances rather than a dedicated index, so it works on
  any storage adapter with no new adapter methods. That means it reads every
  pending instance in the tenant — fine for the volumes an approval queue
  reaches, but it is a reporting call, not something for a hot path.

  New export: `ApproverWorkload`.

## [1.8.0] - 2026-09-04

### Added — `transferApprovals()`

- **Move every pending approval assigned to one person over to another.**
  Someone leaves, changes team, or goes on long-term leave, and their queue has
  to go somewhere. Doing it by hand meant finding every open instance first —
  across parallel branches, where one person can hold several open levels on the
  same document — and missing one left an approval that could never complete.

  ```ts
  await engine.transferApprovals({
    fromApprover: 'alice',
    toApprover: 'bob',
    transferredBy: 'workflow-admin',
    reason: 'Alice left the company',
    documentType: 'purchase_order',   // optional
    dryRun: true,                     // see what would move first
  });
  ```

  Each move goes through `reassign()`, so every guard, audit entry, event and
  authorization check that applies to a single reassignment applies here too.
  The sweep is deliberately **not atomic**: it reports per-instance failures
  rather than rolling back, because a partial transfer is the useful outcome —
  what can move should move, and what cannot is named for a human to look at.

  New exports: `TransferResult`, `TransferApprovalsOptions`.

### Fixed — `delegate()` and `reassign()` could not reach an upper parallel branch

- **Both resolved the level via `currentLevelInstance`**, which names only the
  lowest-numbered open level. Inside a parallel group they therefore always
  acted on the lowest branch: an approver could not hand off their own
  upper-branch work, and an administrator reassigning a departing user silently
  moved the wrong branch — or failed, because that person was not an approver on
  the branch being targeted. Introduced with parallel groups in 1.0.0; sequential
  templates were never affected.

  Both now resolve against the approver actually being moved, and take an
  optional `level` to disambiguate when one person holds more than one open
  branch — matching what `approve()` and `reject()` already did.

## [1.7.0] - 2026-09-04

### Added — attachment references

- **`addAttachment()` / `removeAttachment()` attach supporting evidence to an
  approval** — a quote PDF, a signed contract, a screenshot of a system of
  record. Approvers had nowhere to put the document their decision rested on, so
  it lived in an email thread the audit trail never saw.

  ```ts
  await engine.addAttachment(id, {
    actorId: 'buyer-1',
    name: 'quote.pdf',
    uri: 's3://procurement/quotes/q-1.pdf',
    contentType: 'application/pdf',
    sizeBytes: 48_120,
  });
  ```

- **References only, never bytes.** Approval documents belong in the object
  store or DMS the organisation already runs, which handles retention, virus
  scanning and access control far better than an approval table could; copying
  them here would make the audit database the largest and least governed copy of
  them. Removing detaches the reference and never deletes from the underlying
  store.

- **The audit trail keeps what was removed** — name and URI are recorded on the
  `attachment_removed` entry, so the record still shows an approver saw evidence
  that is no longer listed. Dropping that would let the trail imply a decision
  was made on less than it was.

- Persisted across all four PostgreSQL sites (schema, `migrate()`,
  insert, update, and read-back), with `addedAt` revived as a `Date`. An
  instance with no attachments reads back as `undefined` rather than `[]`,
  keeping the round-trip shape identical to `MemoryAdapter`.

  New exports: `Attachment`, `AttachmentEvent`, `AddAttachmentOptions`,
  `RemoveAttachmentOptions`. `ApprovalInstance` gains `attachments`.

## [1.6.0] - 2026-09-04

### Fixed — PostgresAdapter silently dropped most instance updates

**Anyone running the PostgreSQL adapter should upgrade and run `migrate()`.**
`MemoryAdapter` stores whole objects and was always correct, so this reproduced
only against a real database — which is exactly where it mattered.

`updateInstance` wrote just six columns (`status`, `current_level`, `version`,
`levels`, `sla_breached_at`, `updated_at`). Every other field an operation
mutates was computed, logged, emitted as an event, and then thrown away on
write:

- **`updateData()` (0.9.0) did not change the stored document.** The engine
  recomputed the chain and emitted `approval:data_updated`, but `data` was never
  written, so the next read returned the old values — and any later
  re-evaluation ran against them.
- **`requestInfo()` (1.5.0) lost the hold entirely.** `info_request` had no
  column at all, so a held instance came back unheld: `provideInfo()` then threw
  "No clarification request is open", and the scheduler escalated and expired an
  approval that was supposed to be paused.
- **`provideInfo()`'s deadline give-back never landed** — `expires_at` and
  `sla_deadline_at` were not written, so the time an instance spent on hold was
  silently forfeited.
- `metadata`, `deadline_action` and `template_snapshot` were likewise never
  updated after insert.

`updateInstance` now writes every mutable column, `saveInstance` and
`rowToInstance` carry `info_request` (reviving `askedAt` as a `Date`), and
`migrate()` adds the column to existing deployments via
`ADD COLUMN IF NOT EXISTS`. Optimistic concurrency is unchanged — the update
still guards on `version`.

Regression tests assert the generated SQL and parameters for each field, so a
future column cannot be added to the type and forgotten in the writer.

### Note on the roadmap

Attachment references were the planned 1.6.0. They are deferred: shipping a new
feature ahead of a data-loss fix in an already-published release would have been
the wrong order.

## [1.5.0] - 2026-09-04

### Added — request for information

- **`requestInfo()` / `provideInfo()` let an approver ask the submitter a
  question without rejecting.** Approvers routinely need one fact before they
  can decide, and there was no way to say so: rejecting throws away every
  approval already collected and forces a resubmit, while chasing the question
  by email leaves the request sitting and quietly burns the SLA the approver is
  measured on.

  ```ts
  await engine.requestInfo(id, { approverId: 'mgr-1', question: 'Which cost centre?' });
  await engine.provideInfo(id, { respondedBy: 'buyer-1', response: 'CC-42' });
  ```

  The instance stays `pending` and keeps its approvers — this is a question, not
  a decision.

- **Deadlines are paused for the duration of the hold.** The scheduler skips a
  held instance entirely, so escalation, reminders, SLA breach and expiry cannot
  fire while the submitter owes an answer; on answer, every deadline that was
  set is pushed out by exactly how long the question was open. An approver gets
  back the time they had before asking rather than being penalised for asking.
  A deadline that was never configured is not invented by being held.

- **Wiring:** emits `approval:info_requested` (addressed to the submitter) and
  `approval:info_provided` (addressed to the waiting approvers, carrying
  `heldForMs`); records `info_requested` / `info_provided` audit entries;
  increments `approval.info_requested` / `approval.info_provided`; and adds both
  operations to the authorization-policy set. Only one question may be open at a
  time.

  New exports: `InfoRequest`, `InfoRequestedEvent`, `InfoProvidedEvent`,
  `RequestInfoOptions`, `ProvideInfoOptions`. `ApprovalInstance` gains
  `infoRequest`.

## [1.4.0] - 2026-09-04

### Added — filter instances by document data

- **`InstanceFilter` gains `data`.** Filters covered status, document type,
  submitter, template and date, but nothing about the document itself, so
  "every pending purchase order for vendor ACME" meant paging the whole tenant
  and filtering in application code — which scales badly and pushes the same
  logic into every caller.

  ```ts
  await engine.queryInstances({
    status: 'pending',
    data: { 'vendor.id': 'v-1', region: 'EU' },
  });
  ```

  Keys are dot-paths, values compare by deep equality (so object and array
  values match structurally), and all pairs must match. Available on
  `queryInstances()`, `queryInstancesByCursor()` and `getStatistics()`.

- **Paths resolve over own properties only**, mirroring how conditions read
  field paths — a filter and a condition written against the same path agree on
  what it means, and an inherited prototype member can never make an instance
  match a query.

- **On PostgreSQL this compiles to a parameterised JSONB path lookup**
  (`data #> $n::text[] = $n+1::jsonb`). Path segments travel as a parameter and
  are never interpolated into SQL. Comparison is against JSONB rather than
  serialised text, so structural matching holds on both adapters. Index hot
  paths with `CREATE INDEX ON approval_instances ((data #> '{vendor,id}'))`.

## [1.3.0] - 2026-09-04

### Added — out-of-office cover

- **`outOfOfficeProvider` swaps absent approvers for their stand-in.** An
  approver on leave stalled the chain until somebody noticed and reassigned by
  hand; `delegate()` needed the absent person to initiate it, and `reassign()`
  needed an administrator to spot the problem first.

  ```ts
  new ApprovalEngine({
    adapter,
    outOfOfficeProvider: {
      getDelegateFor: async (userId, at) => hr.coverFor(userId, at), // null when available
    },
  });
  ```

  Applied wherever approvers are resolved — at submit, when a level activates,
  on escalation, and in `previewApprovalChain()`, so a preview cannot disagree
  with what `submit()` goes on to do.

  Kept as an injected provider rather than engine-owned state because absence
  lives in the HR or directory system that already tracks leave; storing it here
  too would guarantee the two disagree. The resolution time is passed to the
  provider, so cover can be date-bound.

- **Substitution is transitive but bounded.** An A→B→C chain of absences lands
  on whoever is actually present, up to five hops. A cover *cycle* (A covers B
  while B covers A) stops and leaves the original approver assigned — visible and
  fixable, unlike a hang. A provider that throws is treated as "no cover known",
  because an HR lookup failing must not stop an approval being routed at all.

  New export: `OutOfOfficeProvider`.

## [1.2.0] - 2026-09-04

### Added — template inheritance

- **`extends` derives one template from another.** ERP tenants run many
  near-identical workflows — one per region, legal entity or document class —
  that share a spine and differ in a level or two. Each had to be written out in
  full, so a change to the shared part meant editing every copy and hoping none
  were missed.

  ```ts
  await engine.defineTemplate({
    name: 'PO-EU',
    extends: 'PO-base',
    documentType: 'purchase_order',
    removeLevels: [2],
    levels: [{ level: 3, approvers: [{ type: 'user', userId: 'eu-fin' }] }],
  });
  ```

  Levels are keyed by number: a child level overrides the base level *field by
  field* (so a derived template can swap just the approvers and inherit name,
  mode and deadlines), child-only levels are appended, and `removeLevels` drops
  inherited ones. `conditions` are replaced wholesale when supplied — merging
  two rule lists would produce a chain neither author intended. `escalation`,
  `slaDeadlineDays` and `allowOverride` are inherited unless the child sets them.

- **Resolution happens once, at define time, and the flattened result is what
  gets stored.** Resolving lazily on read would mean editing a base silently
  reshapes every derived template — and every in-flight instance running against
  one — which is exactly the surprise `templateSnapshot` exists to prevent
  elsewhere in the engine. A base that itself extends something is already
  flattened, so chains resolve naturally and cycles cannot form.

- **Validation runs on the flattened template**, not the fragment: a derived
  config carrying no levels of its own is valid (it inherits the chain), while
  one whose `removeLevels` strips the chain entirely is rejected at definition
  time. `extends` and `removeLevels` are directives for the call and are not
  persisted.

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
