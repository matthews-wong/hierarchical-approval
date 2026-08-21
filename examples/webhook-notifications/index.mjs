/**
 * Signed webhook notifications — end-to-end, runs fully in-memory.
 *
 * Starts a real local HTTP receiver, points the engine's
 * WebhookNotificationAdapter at it, and drives an approval to completion so you
 * can watch each notification arrive and be cryptographically verified.
 *
 * The receiver here is the part you would implement in YOUR service. It shows
 * the three checks a real endpoint must perform:
 *   1. recompute the HMAC over `<timestamp>.<raw body>` — not over the parsed
 *      object, and not over the body alone
 *   2. compare with timingSafeEqual, never `===`
 *   3. reject stale timestamps, or a captured request can be replayed forever
 *
 * Run:  npm run build && node examples/webhook-notifications/index.mjs
 */

import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { ApprovalEngine } from '../../dist/index.js';
import { MemoryAdapter } from '../../dist/adapters/MemoryAdapter.js';
import { WebhookNotificationAdapter } from '../../dist/plugins/webhook.js';

const SECRET = 'whsec_example_do_not_use_in_production';
const SIGNATURE_HEADER = 'x-approval-signature';
const REPLAY_WINDOW_SECONDS = 300;

// ─── The receiver: what you would build on your side ──────────────────────────

/**
 * Verify a signed request exactly the way the adapter signed it.
 *
 * @param {string} rawBody Raw request body, byte-for-byte as received. Re-serialising
 *   the parsed JSON would change key order or spacing and break the signature.
 * @param {string | undefined} header Value of the signature header (`t=<unix>,v1=<hex>`).
 * @param {number} nowSeconds Current unix time, for the replay-window check.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function verifySignature(rawBody, header, nowSeconds) {
  if (!header) return { ok: false, reason: 'signature header missing' };

  const parts = new Map(
    header.split(',').map((piece) => {
      const [key, ...rest] = piece.split('=');
      return [key?.trim(), rest.join('=')];
    }),
  );
  const timestamp = parts.get('t');
  const provided = parts.get('v1');
  if (!timestamp || !provided) return { ok: false, reason: 'malformed signature header' };

  const age = nowSeconds - Number(timestamp);
  if (!Number.isFinite(age) || Math.abs(age) > REPLAY_WINDOW_SECONDS) {
    return { ok: false, reason: `timestamp outside ${REPLAY_WINDOW_SECONDS}s replay window` };
  }

  const expected = createHmac('sha256', SECRET).update(`${timestamp}.${rawBody}`).digest('hex');

  // timingSafeEqual throws on length mismatch, so guard before comparing.
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

/** @type {{ verified: number, rejected: number }} */
const tally = { verified: 0, rejected: 0 };

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks).toString('utf8');
    const nowSeconds = Math.floor(Date.now() / 1000);
    const result = verifySignature(rawBody, req.headers[SIGNATURE_HEADER], nowSeconds);

    if (!result.ok) {
      tally.rejected += 1;
      console.log(`  [receiver] ✗ REJECTED — ${result.reason}`);
      res.writeHead(401).end();
      return;
    }

    tally.verified += 1;
    const event = JSON.parse(rawBody);
    const to = event.recipients?.length ? ` → ${event.recipients.join(', ')}` : '';
    console.log(`  [receiver] ✓ verified  ${event.type}  ${event.documentId}${to}`);
    res.writeHead(200).end();
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const url = `http://127.0.0.1:${port}/hooks/approvals`;
console.log(`Receiver listening on ${url}\n`);

// ─── The engine, wired to deliver signed webhooks ─────────────────────────────

const engine = new ApprovalEngine({
  adapter: new MemoryAdapter(),
  escalationPollIntervalMs: 999_999, // no escalation in this demo
  notificationAdapter: new WebhookNotificationAdapter({
    url,
    secret: SECRET, // omit `secret` to send unsigned requests
    timeoutMs: 5_000,
    maxAttempts: 3, // local retry budget for transient blips
  }),
});

await engine.defineTemplate({
  name: 'Expense Claim',
  documentType: 'expense_claim',
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
});

console.log('──── EXP-001: submit, approve twice, complete ────');
const claim = await engine.submit({
  templateName: 'Expense Claim',
  documentId: 'EXP-001',
  documentType: 'expense_claim',
  submittedBy: 'employee_jane',
  data: { amount: 820, category: 'travel' },
});

await engine.approve(claim.id, { approverId: 'manager_alice', comment: 'Within policy' });
await engine.approve(claim.id, { approverId: 'finance_bob', comment: 'Budget confirmed' });

// ─── Prove the verification actually rejects a forgery ────────────────────────

console.log('\n──── Tampered request (what an attacker would send) ────');
const forged = JSON.stringify({ type: 'approval:completed', documentId: 'EXP-999' });
const forgedResponse = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    // Valid shape, wrong key — this is the case `===` on a string would still
    // reject, but only timingSafeEqual rejects it without leaking timing.
    [SIGNATURE_HEADER]: `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}`,
  },
  body: forged,
});
console.log(`  [sender]   received HTTP ${forgedResponse.status} for the forged request`);

// ─── Teardown ─────────────────────────────────────────────────────────────────

await engine.shutdown();
await new Promise((resolve) => server.close(resolve));

console.log(`\nDelivered and verified: ${tally.verified}   Rejected: ${tally.rejected}`);

if (tally.verified === 0) throw new Error('no webhook was verified — delivery is broken');
if (tally.rejected !== 1) throw new Error(`expected exactly 1 rejection, got ${tally.rejected}`);

console.log('Done.');
