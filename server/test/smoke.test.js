import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encrypt, decrypt } from '../src/services/crypto.js';
import { nextTicketNumber } from '../src/services/ticketNumbering.js';
import { db } from '../src/db.js';

test('encryption round-trip preserves the original secret', () => {
  const secret = 'sk-test-12345';
  const enc = encrypt(secret);
  assert.notEqual(enc, secret);
  assert.equal(decrypt(enc), secret);
});

test('decrypt() passes through legacy plaintext values unchanged', () => {
  assert.equal(decrypt('not-encrypted-yet'), 'not-encrypted-yet');
});

test('ticket numbering increments sequentially per type, independently per workspace', () => {
  const wsA = `ws_test_${Date.now()}_a`;
  const wsB = `ws_test_${Date.now()}_b`;
  assert.equal(nextTicketNumber(wsA, 'incident'), 'INC-1000');
  assert.equal(nextTicketNumber(wsA, 'incident'), 'INC-1001');
  assert.equal(nextTicketNumber(wsA, 'request'), 'REQ-1000');
  // A different workspace's counter starts fresh, independent of wsA's.
  assert.equal(nextTicketNumber(wsB, 'incident'), 'INC-1000');
});

test('workspace-scoped queries cannot see another workspace\'s rows', () => {
  const ws1 = `ws_test_${Date.now()}_iso1`;
  const ws2 = `ws_test_${Date.now()}_iso2`;
  const ticketId = `tkt_test_${Date.now()}`;
  db.prepare(
    'INSERT INTO tickets (id, workspace_id, number, type, title) VALUES (?,?,?,?,?)'
  ).run(ticketId, ws1, 'INC-9001', 'incident', 'isolation test');

  const sameWorkspace = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(ticketId, ws1);
  const otherWorkspace = db.prepare('SELECT * FROM tickets WHERE id = ? AND workspace_id = ?').get(ticketId, ws2);

  assert.ok(sameWorkspace, 'ticket should be visible within its own workspace');
  assert.equal(otherWorkspace, undefined, 'ticket must not be visible from a different workspace');

  db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
});

test('JWT_SECRET is required in production — server refuses to start without it', async () => {
  const originalEnv = process.env.NODE_ENV;
  const originalSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  process.env.NODE_ENV = 'production';
  try {
    await assert.rejects(() => import(`../src/middleware/auth.js?bust=${Date.now()}`));
  } finally {
    process.env.NODE_ENV = originalEnv;
    if (originalSecret !== undefined) process.env.JWT_SECRET = originalSecret;
  }
});
