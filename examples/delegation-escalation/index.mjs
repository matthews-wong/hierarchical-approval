/**
 * Delegation, reassignment and escalation demo.
 * Runs fully in-memory:  node examples/delegation-escalation/index.mjs
 *
 * - delegate():  the approver themselves hands the task to a deputy.
 * - reassign():  an admin swaps out an unavailable approver.
 * - escalate():  pull in a higher authority (e.g. when an approver is unresponsive).
 */

import { ApprovalEngine } from '../../dist/index.js';
import { MemoryAdapter } from '../../dist/adapters/MemoryAdapter.js';

const engine = new ApprovalEngine({
  adapter: new MemoryAdapter(),
  escalationPollIntervalMs: 999_999,
});

engine
  .on('approval:delegated', (e) => console.log(`[delegated]  ${e.documentId}: ${e.fromApprover} → ${e.toApprover}`))
  .on('approval:reassigned', (e) => console.log(`[reassigned] ${e.documentId}: ${e.fromApprover} → ${e.toApprover} (by ${e.reassignedBy})`))
  .on('approval:escalated', (e) => console.log(`[escalated]  ${e.documentId}: added ${e.escalatedTo} at level ${e.level}`))
  .on('approval:approved', (e) => console.log(`[approved]   ${e.documentId} by ${e.approverId}`))
  .on('approval:completed', (e) => console.log(`[completed]  ${e.documentId} ✓ APPROVED`));

await engine.defineTemplate({
  name: 'Travel Request',
  documentType: 'travel',
  levels: [
    { level: 1, name: 'Manager', mode: 'any', approvers: [{ type: 'user', userId: 'manager' }] },
    { level: 2, name: 'Department Head', mode: 'any', approvers: [{ type: 'user', userId: 'dept_head' }] },
  ],
  escalation: { afterDays: 3, escalateTo: { type: 'user', userId: 'vp' } },
});

// 1) Manager delegates to their deputy, who approves
console.log('\n──── TRV-001: manager delegates ────');
const t1 = await engine.submit({ templateName: 'Travel Request', documentId: 'TRV-001', documentType: 'travel', submittedBy: 'alice' });
await engine.delegate(t1.id, { fromApprover: 'manager', toApprover: 'deputy_manager', reason: 'On leave' });
await engine.approve(t1.id, { approverId: 'deputy_manager' });

// 2) Admin reassigns the department head (who left the company), escalation pulls in the VP
console.log('\n──── TRV-001 (level 2): admin reassign + escalate ────');
await engine.reassign(t1.id, { reassignedBy: 'workflow_admin', fromApprover: 'dept_head', toApprover: 'dept_head_new', reason: 'Left the company' });
await engine.escalate(t1.id, { escalatedBy: 'workflow_admin' }); // adds the VP alongside the new dept head
await engine.approve(t1.id, { approverId: 'vp', comment: 'Approved on escalation' });

console.log('\n──── Audit trail for TRV-001 ────');
for (const entry of await engine.getHistory(t1.id)) {
  console.log(`  ${entry.action.padEnd(11)} by ${entry.actorId} @ level ${entry.level}`);
}

engine.shutdown();
