// This app's first real recurring background job for actual business logic
// -- everywhere else, "automatic" is computed at read/action time instead
// (escalations, SLA breach, lifecycle stage sync all work that way). A
// directory deletion has no request to hang that off of: nobody here ever
// "reads" an AD deletion, so the app has to actively go ask on some cadence.
// Deliberately chosen over doing nothing between manual "Sync now" clicks --
// see the Directory Integration plan for the tradeoff discussion.
import { db } from '../db.js';
import { runSync } from './directorySync.js';

const TICK_MS = 5 * 60 * 1000; // check every 5 minutes which providers are due
let timer = null;

async function tick() {
  const due = db.prepare(
    `SELECT id FROM directory_providers
     WHERE enabled = 1 AND sync_interval_minutes > 0
       AND (last_synced_at IS NULL OR datetime(last_synced_at, '+' || sync_interval_minutes || ' minutes') <= datetime('now'))`
  ).all();
  for (const row of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await runSync(row.id);
    } catch (e) {
      console.error(`[directory-sync] scheduled sync failed for provider ${row.id}:`, e.message);
    }
  }
}

export function startDirectorySyncScheduler() {
  if (timer) return; // idempotent -- a stray second call (e.g. hot-reload in dev) never doubles up the interval
  // .unref() so this never keeps the process alive on its own -- same
  // courtesy every other setInterval in this app already extends (e.g. the
  // SSO CSRF-state sweep in routes/sso.js).
  timer = setInterval(() => { tick().catch((e) => console.error('[directory-sync] tick error', e)); }, TICK_MS).unref();
}

// Exposed for tests -- lets a test shrink the effective cadence without
// waiting on the real 5-minute tick.
export function _runTickNow() {
  return tick();
}
