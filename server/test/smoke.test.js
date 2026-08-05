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

test('ticket numbering increments sequentially per type, globally', () => {
  const before = nextTicketNumber('incident');
  const beforeSeq = parseInt(before.split('-')[1], 10);
  const next = nextTicketNumber('incident');
  const nextSeq = parseInt(next.split('-')[1], 10);
  assert.ok(before.startsWith('INC-'));
  assert.equal(nextSeq, beforeSeq + 1);

  const reqNumber = nextTicketNumber('request');
  assert.ok(reqNumber.startsWith('REQ-'));
});

test('there is no workspace isolation — tickets are visible regardless of their workspace label', () => {
  const wsA = `ws_test_${Date.now()}_a`;
  const wsB = `ws_test_${Date.now()}_b`;
  const ticketId = `tkt_test_${Date.now()}`;
  db.prepare(
    'INSERT INTO tickets (id, workspace_id, number, type, title) VALUES (?,?,?,?,?)'
  ).run(ticketId, wsA, 'INC-9001', 'incident', 'isolation test');

  // The application no longer filters ticket reads by workspace_id, so a plain
  // lookup by id succeeds regardless of which workspace label is "current".
  const found = db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  assert.ok(found, 'ticket should be readable without any workspace filter');
  assert.equal(found.workspace_id, wsA);
  assert.notEqual(found.workspace_id, wsB);

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
