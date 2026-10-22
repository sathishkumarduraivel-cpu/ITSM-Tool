import pg from 'pg';

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
