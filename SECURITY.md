# Security Policy

## Supported versions

`hierarchical-approval` follows [Semantic Versioning](https://semver.org). Security
fixes are released against the latest minor line; older lines are patched at the
maintainer's discretion.

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

The library targets **Node.js 20 and 22** (the versions exercised in CI). Running
on end-of-life Node releases is unsupported.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, use one of the following private channels:

1. **GitHub Security Advisories** (preferred) — open a private report via the
   repository's **Security → Report a vulnerability** tab. This keeps the report
   confidential until a fix is published.
2. **Email** — `matthews.wong@commsult.id` with the subject line
   `SECURITY: hierarchical-approval`.

Please include as much of the following as you can:

- A description of the vulnerability and its impact.
- The affected version(s) and, ideally, the affected file(s)/function(s).
- A minimal reproduction (code snippet, failing test, or steps).
- Any known mitigations or workarounds.

## What to expect

- **Acknowledgement** within **3 business days**.
- An initial assessment and severity rating within **10 business days**.
- Coordinated disclosure: we will agree on a disclosure timeline with you and
  credit you in the release notes and advisory unless you prefer to remain
  anonymous.

## Scope

This is a **storage-agnostic library**, not a hosted service. Reports are in scope
when they concern the library's own code, for example:

- Integrity of the tamper-evident audit chain (`plugins/audit`).
- Authorization bypasses in `RbacAuthorizationPolicy` / the authorization port.
- Injection reachable through the bundled `PostgresAdapter` (parameterization).
- Denial of service reachable through untrusted template/condition input.
- Leakage of PII that the `RedactingAuditAdapter` is documented to redact.

The security of the **host application** — how you authenticate actors, protect
your database, and manage secrets — is your responsibility. Misconfiguration of a
downstream system is out of scope.

## Supply chain

- Releases are published to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements)
  attestations enabled.
- Dependencies are kept current via automated Dependabot updates.
- CI fails the build on `npm audit` findings rated **high** or **critical**.
