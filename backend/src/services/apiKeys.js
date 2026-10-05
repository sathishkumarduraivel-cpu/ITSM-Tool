import crypto from 'node:crypto';
import { db } from '../db.js';

// A curated, deliberately small surface -- a real public API exposes a
// reviewed subset of what the internal SPA can do, not everything. Each
// scope maps 1:1 to a resource + read/write, which is also exactly the
// granularity the key-creation UI lets an admin pick.
export const SCOPES = [
  { key: 'tickets:read', label: 'Read tickets' },
  { key: 'tickets:write', label: 'Create & update tickets' },
  { key: 'assets:read', label: 'Read assets (CMDB)' },
  { key: 'kb:read', label: 'Read knowledge base articles' },
  { key: 'users:read', label: 'Look up users' },
];
const VALID_SCOPES = new Set(SCOPES.map((s) => s.key));

export function sanitizeScopes(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((s) => VALID_SCOPES.has(s)))];
}

function hashKey(rawKey) {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

// Stripe/GitHub-style prefixed token -- immediately recognizable as this
// app's key if it ever leaks into a log or a git commit, unlike an opaque
// random string. 32 bytes of entropy (256 bits) is far beyond brute-force
// range for a fast-hash-compared secret like this.
export function generateApiKey() {
  const raw = `itsm_live_${crypto.randomBytes(32).toString('hex')}`;
  return { raw, prefix: raw.slice(0, 18), hash: hashKey(raw) };
}

// Fast SHA-256, not a slow password hash (bcrypt/scrypt) -- deliberate:
// this key is a high-entropy random secret the caller never chooses, not a
// human-memorable password vulnerable to a dictionary/brute-force attack
// against a stolen hash, so there's nothing a slow hash defends against
// here that isn't already covered by the 256 bits of randomness itself.
export function lookupApiKey(rawKey) {
  if (!rawKey || !rawKey.startsWith('itsm_')) return null;
  const hash = hashKey(rawKey);
  const row = db.prepare(
    `SELECT * FROM api_keys WHERE key_hash = ? AND enabled = 1 AND (expires_at IS NULL OR expires_at > datetime('now'))`
  ).get(hash);
  if (!row) return null;
  // Best-effort, never blocks the request this lookup is serving.
  db.prepare("UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?").run(row.id);
  return { ...row, scopes: JSON.parse(row.scopes || '[]') };
}
