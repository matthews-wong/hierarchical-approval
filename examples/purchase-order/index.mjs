/**
 * Purchase Order approval demo — runs fully in-memory, no database needed.
 *
 * Scenario:
 *   PO-001  $4,000 → needs Line Manager + Finance (2 levels)
 *   PO-002  $15,000 → needs Line Manager + Finance + CFO (3 levels, added by condition)
 */

import { ApprovalEngine } from '../../dist/index.js';
import { MemoryAdapter } from '../../dist/adapters/MemoryAdapter.js';

const engine = new ApprovalEngine({
  adapter: new MemoryAdapter(),
  escalationPollIntervalMs: 999_999, // disable escalation for demo
});

// Emit every event to the console
engine
  .on('approval:submitted',    (e) => console.log(`[submitted]      ${e.documentId} → approvers: ${e.currentApprovers.join(', ')}`))
  .on('approval:level_advanced', (e) => console.log(`[level_advanced] ${e.documentId} → level ${e.fromLevel}→${e.toLevel}, new approvers: ${e.newApprovers.join(', ')}`))
  .on('approval:approved',     (e) => console.log(`[approved]       ${e.documentId} by ${e.approverId} (level ${e.level}, final=${e.isFinal})`))
  .on('approval:completed',    (e) => console.log(`[completed]      ${e.documentId} ✓ FULLY APPROVED`))
  .on('approval:rejected',     (e) => console.log(`[rejected]       ${e.documentId} by ${e.approverId}: "${e.reason}"`))
  .on('approval:delegated',    (e) => console.log(`[delegated]      ${e.documentId} from ${e.fromApprover} → ${e.toApprover}`));

// Define the template once at application startup
await engine.defineTemplate({
  name: 'Purchase Order',
  documentType: 'purchase_order',
  levels: [
    {
      level: 1,
      name: 'Line Manager',
      approvers: [{ type: 'user', userId: 'manager_alice' }],
      mode: 'any',
      escalationAfterDays: 3,
    },
    {
      level: 2,
      name: 'Finance',
      approvers: [{ type: 'user', userId: 'finance_bob' }],
      mode: 'any',
      escalationAfterDays: 5,
    },
  ],
  conditions: [
    {
      // Orders over $10,000 require CFO approval as a third level
      when: { field: 'amount', operator: '>', value: 10_000 },
      addLevels: [
        {
          level: 3,
          name: 'CFO',
          approvers: [{ type: 'user', userId: 'cfo_carol' }],
          mode: 'any',
        },
      ],
    },
  ],
  escalation: {
    afterDays: 7,
    escalateTo: { type: 'user', userId: 'vp_dave' },
  },
});

console.log('\n──── PO-001: $4,000 (standard 2-level approval) ────');
const po1 = await engine.submit({
  templateName: 'Purchase Order',
  documentId: 'PO-001',
  documentType: 'purchase_order',
  submittedBy: 'employee_jane',
  data: { amount: 4_000, vendor: 'Acme Corp' },
});
await engine.approve(po1.id, { approverId: 'manager_alice', comment: 'Budget available' });
await engine.approve(po1.id, { approverId: 'finance_bob' });

console.log('\n──── PO-002: $15,000 (3-level with CFO condition) ────');
const po2 = await engine.submit({
  templateName: 'Purchase Order',
  documentId: 'PO-002',
  documentType: 'purchase_order',
  submittedBy: 'employee_jane',
  data: { amount: 15_000, vendor: 'Big Supplies Inc' },
});
await engine.approve(po2.id, { approverId: 'manager_alice' });
// Finance delegates to a colleague before approving
await engine.delegate(po2.id, { fromApprover: 'finance_bob', toApprover: 'finance_charlie', reason: 'On leave' });
await engine.approve(po2.id, { approverId: 'finance_charlie' });
await engine.approve(po2.id, { approverId: 'cfo_carol', comment: 'Strategic spend approved' });

console.log('\n──── PO-003: $8,000 (rejected by manager) ────');
const po3 = await engine.submit({
  templateName: 'Purchase Order',
  documentId: 'PO-003',
  documentType: 'purchase_order',
  submittedBy: 'employee_mike',
  data: { amount: 8_000, vendor: 'Vendor X' },
});
await engine.reject(po3.id, { approverId: 'manager_alice', reason: 'Not in this quarter budget' });

console.log('\n──── Pending approvals for finance_bob ────');
const pending = await engine.getPendingFor('finance_bob');
console.log(`finance_bob has ${pending.total} pending approval(s)`);

engine.shutdown();
