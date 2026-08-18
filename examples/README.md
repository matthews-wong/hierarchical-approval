# Examples

Runnable, dependency-free demos. Each runs fully in-memory (no database) against
the built `dist/`, so build once first:

```sh
npm install
npm run build
```

Then run any example with Node:

| Example | What it shows | Run |
|---|---|---|
| **purchase-order** | The end-to-end basics: multi-level chain, an amount condition adding a CFO level, delegation, rejection, and pending-work queries. | `node examples/purchase-order/index.mjs` |
| **conditional-chain** | How the chain reshapes from document data — `addLevels` by amount and `skipLevels` for trusted vendors — previewed without creating an instance. | `node examples/conditional-chain/index.mjs` |
| **decision-modes** | `quorum` (any 2 of 3 directors) and `weighted` voting (CFO's vote clears the threshold alone). | `node examples/decision-modes/index.mjs` |
| **delegation-escalation** | `delegate()` (by the approver), `reassign()` (by an admin), and `escalate()` to a higher authority, with the resulting audit trail. | `node examples/delegation-escalation/index.mjs` |

> Tip: for time-dependent behaviour (auto-escalation, SLA breaches, expiry) without real timers, see the **Testing** section of the [main README](../README.md) — `ApprovalTestKit` + `ManualClock`.
