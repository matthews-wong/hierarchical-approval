# Contributing to hierarchical-approval

Thanks for your interest in improving `hierarchical-approval`. This document
explains how to set up the project, the standards we hold code to, and how to get
a change merged.

By participating you agree to abide by our [Code of Conduct](./CODE_OF_CONDUCT.md).

## Table of contents

- [Ways to contribute](#ways-to-contribute)
- [Development setup](#development-setup)
- [Project layout](#project-layout)
- [Coding standards](#coding-standards)
- [Testing](#testing)
- [Commit conventions](#commit-conventions)
- [Pull request process](#pull-request-process)
- [Extending the library](#extending-the-library)
- [Reporting security issues](#reporting-security-issues)

## Ways to contribute

- **Report a bug** — open an issue using the _Bug report_ template. Include a
  minimal reproduction.
- **Request a feature** — open an issue using the _Feature request_ template and
  describe the ERP workflow you're trying to model.
- **Improve docs** — README, examples, and TSDoc fixes are always welcome.
- **Submit code** — see the [pull request process](#pull-request-process) below.

For anything larger than a bug fix, please open an issue first so we can agree on
the approach before you invest time.

## Development setup

Requires **Node.js 20 or 22** and npm.

```bash
git clone https://github.com/matthews-wong/hierarchical-approval.git
cd hierarchical-approval
npm ci
```

Common scripts:

| Command                 | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `npm test`              | Run the full Vitest suite once                  |
| `npm run test:watch`    | Watch mode for TDD                              |
| `npm run test:coverage` | Run tests with a V8 coverage report             |
| `npm run typecheck`     | `tsc --noEmit` — no type errors allowed         |
| `npm run lint`          | ESLint over `src` and `tests`                   |
| `npm run format`        | Prettier write over `src` and `tests`           |
| `npm run build`         | Produce the dual CJS+ESM+`.d.ts` bundle (tsup)  |
| `npm run docs`          | Generate the TypeDoc API reference into `docs/` |

## Project layout

```
src/
├── engine/       # ApprovalEngine + state machine, condition eval, escalation
├── adapters/     # Storage ports + Memory/Postgres implementations
├── plugins/      # Optional enterprise layers, each a published subpath:
│   ├── audit/        # hash-chain + redacting audit adapters
│   ├── metrics/      # Prometheus / in-memory metrics adapters
│   ├── notify/       # outbox notification adapter (retry + dead-letter)
│   ├── resilience/   # rate-limit, logging, RBAC middleware/policies
│   └── tracing/      # OpenTelemetry-compatible tracing middleware
├── testing/      # ApprovalTestKit harness
├── types/        # Shared domain types
└── utils/        # Clock, Logger, BusinessCalendar, IdGenerator, EventBus
```

## Coding standards

- **TypeScript strict mode** is non-negotiable (`strict` + `noUncheckedIndexedAccess`).
- **No `any`.** Use `unknown` with a type guard.
- **Explicit return types** on all exported functions and methods.
- **`import type { … }`** for type-only imports.
- **Prettier** owns formatting (single quotes, trailing commas, 2-space indent).
  Run `npm run format` before committing.
- **Named constants, not magic values.** Follow the patterns in the surrounding
  file.
- **Document the "why".** Public APIs carry TSDoc; comments explain rationale, not
  restate code.

New code must pass `npm run typecheck`, `npm run lint`, and `npm test` locally
before you open a PR.

## Testing

- We use **Vitest**. Tests live in `tests/unit` and `tests/integration`.
- Follow the existing **AAA** (Arrange–Act–Assert) style and keep each test
  focused on one behavior.
- Use the injectable `Clock` (`ManualClock` in `tests/unit/plugins/_helpers.ts`)
  instead of real time — tests must be deterministic, never `sleep`-based.
- New behavior needs tests: happy path, edge cases, and error conditions.
- Every published subpath is guarded by `tests/integration/plugin-exports.test.ts`
  — if you add or remove an export, update that guard.

## Commit conventions

We use [Conventional Commits](https://www.conventionalcommits.org). The subject is
imperative and under 50 characters; the body (when present) explains _why_:

```
<type>(<optional scope>): <description>
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `chore`, `ci`, `perf`.

Examples from this repository:

```
feat(engine): add quorum and weighted approval modes
fix(memory-adapter): stop duplicating audit log entries
docs(examples): add conditional-chain, decision-modes, delegation-escalation
```

Keep commits atomic — one logical change per commit.

## Pull request process

1. Fork and create a feature branch off `main`
   (`git checkout -b feature/short-description`).
2. Make your change with tests and docs.
3. Ensure `npm run typecheck && npm run lint && npm test && npm run build` all
   pass.
4. Update `CHANGELOG.md` under an _Unreleased_ heading if the change is
   user-facing.
5. Open a PR against `main` (keep it focused and under ~500 lines where
   possible), fill out the PR template, and link any related issue.
6. A maintainer will review. Address feedback by pushing follow-up commits; we
   squash-merge, so you don't need to rebase away review history. Wait for CI to
   pass before requesting the merge.

Please do **not** bump the package version or publish — releases are cut by the
maintainer.

## Extending the library

The engine is designed to be extended **without editing the engine**:

- **New storage backend** → implement `IStorageAdapter` (see `MemoryAdapter`).
- **New cross-cutting concern** (audit sink, metrics backend, notifications,
  authz, tracing) → add a `src/plugins/<area>/` module implementing the relevant
  port (`IAuditAdapter`, `IMetricsAdapter`, `INotificationAdapter`,
  `IAuthorizationPolicy`, `IOperationMiddleware`). Wire the new subpath into both
  `tsup.config.ts` `entry` and `package.json` `exports`, and add it to the
  `plugin-exports` guard test.

This keeps the core small and each concern independently testable and
tree-shakeable.

## Reporting security issues

Please do **not** open a public issue for vulnerabilities. Follow the process in
[SECURITY.md](./SECURITY.md).
