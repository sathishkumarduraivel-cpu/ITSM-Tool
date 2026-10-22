import pg from 'pg';
import fs from 'node:fs';

const { Pool } = pg;

// Neon provides a pooled DATABASE_URL for application traffic. Keep this
// connection separate from the existing SQLite store while the application's
// SQLite-specific query layer is migrated deliberately.
const connectionString = process.env.DATABASE_URL;

export const neonPool = connectionString
  ? new Pool({
      connectionString,
      max: Number(process.env.NEON_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ssl: { rejectUnauthorized: true },
    })
  : null;

// Preserve the application's established synchronous SQLite API while using
// Neon Postgres as the durable backing store on stateless hosts.
const snapshotEnabled = process.env.NEON_SQLITE_SNAPSHOT === 'true';
const snapshotKey = process.env.NEON_SQLITE_SNAPSHOT_KEY || 'itsm-ai';
let snapshotTimer = null;
let snapshotChain = Promise.resolve();

function requireSnapshotPool() {
  if (!snapshotEnabled || !neonPool) return null;
  return neonPool;
}

async function ensureSnapshotTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS itsm_sqlite_snapshots (
      snapshot_key TEXT PRIMARY KEY,
      payload BYTEA NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export async function restoreNeonSqliteSnapshot(filePath) {
  const pool = requireSnapshotPool();
  if (!pool) return false;
  await ensureSnapshotTable(pool);
  const result = await pool.query(
    'SELECT payload FROM itsm_sqlite_snapshots WHERE snapshot_key = $1',
    [snapshotKey],
  );
  if (!result.rowCount) return false;
  fs.writeFileSync(filePath, result.rows[0].payload);
  return true;
}

async function writeNeonSqliteSnapshot(filePath) {
  const pool = requireSnapshotPool();
  if (!pool || !fs.existsSync(filePath)) return false;
  const payload = fs.readFileSync(filePath);
  await ensureSnapshotTable(pool);
  await pool.query(
    `INSERT INTO itsm_sqlite_snapshots (snapshot_key, payload, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (snapshot_key) DO UPDATE
       SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at`,
    [snapshotKey, payload],
  );
  return true;
}

export function flushNeonSqliteSnapshot(filePath) {
  if (snapshotTimer) {
    clearTimeout(snapshotTimer);
    snapshotTimer = null;
  }
  // Uploads are serialized so a slower earlier upload can never overwrite a
  // newer database snapshot.
  snapshotChain = snapshotChain
    .catch(() => undefined)
    .then(() => writeNeonSqliteSnapshot(filePath));
  return snapshotChain;
}

export function scheduleNeonSqliteSnapshot(filePath) {
  if (!requireSnapshotPool()) return;
  if (snapshotTimer) clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(() => {
    snapshotTimer = null;
    flushNeonSqliteSnapshot(filePath).catch((error) => {
      console.error('[neon] SQLite snapshot failed:', error.message);
    });
  }, 250);
  snapshotTimer.unref();
}

export async function checkNeonConnection() {
  if (!neonPool) return { configured: false, connected: false };

  const result = await neonPool.query('SELECT current_database() AS database, now() AS connected_at');
  return {
    configured: true,
    connected: true,
    database: result.rows[0].database,
    connectedAt: result.rows[0].connected_at,
  };
}
