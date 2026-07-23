/**
 * hierarchical-approval — interactive playground.
 *
 * Runs fully in-memory (no database). Edit the amounts, approvers, or the
 * condition threshold below and hit run to see the approval chain react.
 *
 * Scenario: a purchase-order workflow that needs Line Manager + Finance,
 * and automatically inserts a CFO level for orders over $10,000.
 */

import { ApprovalEngine } from 'hierarchical-approval';
import { MemoryAdapter } from 'hierarchical-approval/adapters/memory';

const engine = new ApprovalEngine({
  adapter: new MemoryAdapter(),
  escalationPollIntervalMs: 999_999, // disable the escalation timer for the demo
});

engine
  .on('approval:submitted', (e) =>
    console.log(`[submitted]      ${e.documentId} → approvers: ${e.currentApprovers.join(', ')}`),
  )
  .on('approval:level_advanced', (e) =>
    console.log(
      `[level_advanced] ${e.documentId} → level ${e.fromLevel}→${e.toLevel}, next: ${e.newApprovers.join(', ')}`,
    ),
  )
  .on('approval:approved', (e) =>
    console.log(
      `[approved]       ${e.documentId} by ${e.approverId} (level ${e.level}, final=${e.isFinal})`,
    ),
  )
  .on('approval:completed', (e) => console.log(`[completed]      ${e.documentId} ✓ FULLY APPROVED`))
  .on('approval:rejected', (e) =>
    console.log(`[rejected]       ${e.documentId} by ${e.approverId}: "${e.reason}"`),
  );

await engine.defineTemplate({
  name: 'Purchase Order',
  documentType: 'purchase_order',
  levels: [
    {
      level: 1,
      name: 'Line Manager',
      approvers: [{ type: 'user', userId: 'manager_alice' }],
      mode: 'any',
    },
    {
      level: 2,
      name: 'Finance',
      approvers: [{ type: 'user', userId: 'finance_bob' }],
      mode: 'any',
    },
  ],
  conditions: [
    {
      // 👇 try changing this threshold, or the amounts below
      when: { field: 'amount', operator: '>', value: 10_000 },
      addLevels: [
        { level: 3, name: 'CFO', approvers: [{ type: 'user', userId: 'cfo_carol' }], mode: 'any' },
      ],
    },
  ],
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

console.log('\n──── PO-002: $15,000 (CFO level added by condition) ────');
const po2 = await engine.submit({
  templateName: 'Purchase Order',
  documentId: 'PO-002',
  documentType: 'purchase_order',
  submittedBy: 'employee_jane',
  data: { amount: 15_000, vendor: 'Big Supplies Inc' },
});
await engine.approve(po2.id, { approverId: 'manager_alice' });
await engine.approve(po2.id, { approverId: 'finance_bob' });
await engine.approve(po2.id, { approverId: 'cfo_carol', comment: 'Strategic spend approved' });

console.log('\nDone. Inspect the full audit trail:');
console.log(JSON.stringify(await engine.getHistory(po2.id), null, 2));

engine.shutdown();
