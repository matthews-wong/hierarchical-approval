/**
 * Conditional chain demo — the approval path changes based on document data.
 * Runs fully in-memory:  node examples/conditional-chain/index.mjs
 *
 * Base chain:  Manager → Finance
 *   + amount > 25k  → adds a CFO level
 *   + amount > 100k → adds a Board level
 *   + trusted vendor → skips the Finance level
 */

import { ApprovalEngine } from '../../dist/index.js';
import { MemoryAdapter } from '../../dist/adapters/MemoryAdapter.js';

const engine = new ApprovalEngine({
  adapter: new MemoryAdapter(),
  escalationPollIntervalMs: 999_999,
});

await engine.defineTemplate({
  name: 'Expense',
  documentType: 'expense',
  levels: [
    { level: 1, name: 'Manager', mode: 'any', approvers: [{ type: 'user', userId: 'manager' }] },
    { level: 2, name: 'Finance', mode: 'any', approvers: [{ type: 'user', userId: 'finance' }] },
  ],
  conditions: [
    {
      when: { field: 'amount', operator: '>', value: 25_000 },
      addLevels: [{ level: 3, name: 'CFO', mode: 'any', approvers: [{ type: 'user', userId: 'cfo' }] }],
    },
    {
      when: { field: 'amount', operator: '>', value: 100_000 },
      addLevels: [{ level: 4, name: 'Board', mode: 'any', approvers: [{ type: 'user', userId: 'board_chair' }] }],
    },
    {
      // Pre-vetted vendors don't need a separate Finance review
      when: { field: 'trustedVendor', operator: '==', value: true },
      skipLevels: [2],
    },
  ],
});

// previewApprovalChain() resolves the chain WITHOUT creating an instance —
// perfect for showing the user "who will need to approve this" up front.
async function preview(label, data) {
  const { levels, conditionsApplied } = await engine.previewApprovalChain('Expense', data, 'employee');
  const chain = levels.map((l) => `${l.level}:${l.name}`).join(' → ');
  console.log(`${label}\n  chain: ${chain}\n  conditions fired: [${conditionsApplied.join(', ')}]\n`);
}

console.log('──── Preview how the chain changes with the data ────\n');
await preview('$5,000 standard expense', { amount: 5_000 });
await preview('$40,000 expense', { amount: 40_000 });
await preview('$250,000 expense', { amount: 250_000 });
await preview('$40,000 from a trusted vendor (skips Finance)', { amount: 40_000, trustedVendor: true });

engine.shutdown();
