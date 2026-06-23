/**
 * Decision modes demo — quorum (N-of-M) and weighted voting.
 * Runs fully in-memory, no database needed:  node examples/decision-modes/index.mjs
 */

import { ApprovalEngine } from '../../dist/index.js';
import { MemoryAdapter } from '../../dist/adapters/MemoryAdapter.js';

const engine = new ApprovalEngine({
  adapter: new MemoryAdapter(),
  escalationPollIntervalMs: 999_999,
});

engine
  .on('approval:approved', (e) => console.log(`[approved]  ${e.documentId} by ${e.approverId} (final=${e.isFinal})`))
  .on('approval:completed', (e) => console.log(`[completed] ${e.documentId} ✓ APPROVED`))
  .on('approval:rejected', (e) => console.log(`[rejected]  ${e.documentId} by ${e.approverId}`));

// ── Quorum: any 2 of 3 directors must approve ──────────────────────────────
await engine.defineTemplate({
  name: 'Board Resolution',
  documentType: 'resolution',
  levels: [
    {
      level: 1,
      name: 'Board',
      mode: 'quorum',
      minApprovals: 2,
      approvers: [
        { type: 'user', userId: 'director_1' },
        { type: 'user', userId: 'director_2' },
        { type: 'user', userId: 'director_3' },
      ],
    },
  ],
});

console.log('\n──── Board Resolution: quorum 2-of-3 ────');
const r1 = await engine.submit({
  templateName: 'Board Resolution',
  documentId: 'RES-001',
  documentType: 'resolution',
  submittedBy: 'secretary',
});
await engine.approve(r1.id, { approverId: 'director_1' }); // 1/2 — still pending
await engine.approve(r1.id, { approverId: 'director_2' }); // 2/2 — quorum reached → approved

// ── Weighted: the CFO's vote (weight 3) clears the threshold alone ─────────
await engine.defineTemplate({
  name: 'Capital Spend',
  documentType: 'capex',
  levels: [
    {
      level: 1,
      name: 'Exec Committee',
      mode: 'weighted',
      threshold: 3,
      weights: { cfo: 3 }, // unlisted approvers default to weight 1
      approvers: [
        { type: 'user', userId: 'cfo' },
        { type: 'user', userId: 'manager' },
      ],
    },
  ],
});

console.log('\n──── Capital Spend: weighted (CFO=3, threshold=3) ────');
const c1 = await engine.submit({
  templateName: 'Capital Spend',
  documentId: 'CAPEX-001',
  documentType: 'capex',
  submittedBy: 'requester',
});
await engine.approve(c1.id, { approverId: 'cfo', comment: 'Approved' }); // weight 3 ≥ 3 → approved

engine.shutdown();
