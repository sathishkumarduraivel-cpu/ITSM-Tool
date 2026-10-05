// Periodic poll of every workspace's connected mailbox for new mail -- the
// same "actively go ask on a cadence" exception to this app's read-time-
// computation norm that directorySyncScheduler.js already established, for
// the identical reason: nobody "reads" a new email into existence, so
// something has to go check. Deliberately its own interval/module rather
// than folded into the directory scheduler's tick -- unrelated concerns
// that happen to share a shape shouldn't share a timer, since one's cadence
// or failure has no business affecting the other's.
import { db } from '../db.js';
import { processInbox } from './inboundEmail.js';

const TICK_MS = 2 * 60 * 1000; // a support inbox wants shorter latency than a directory, which changes far less often

let timer = null;

async function tick() {
  const due = db.prepare(
    "SELECT workspace_id FROM email_settings WHERE mailbox_provider = 'microsoft' AND inbound_enabled = 1 AND graph_refresh_token IS NOT NULL"
  ).all();
  for (const row of due) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await processInbox(row.workspace_id);
      if (result.checked) console.log(`[inbound-email] workspace ${row.workspace_id}: ${result.checked} checked, ${result.created} tickets created, ${result.commented} replies matched`);
    } catch (e) {
      console.error(`[inbound-email] poll failed for workspace ${row.workspace_id}:`, e.message);
    }
  }
}

export function startInboundEmailScheduler() {
  if (timer) return; // idempotent, same guard as directorySyncScheduler's
  timer = setInterval(() => { tick().catch((e) => console.error('[inbound-email] tick error', e)); }, TICK_MS).unref();
}

export function _runTickNow() {
  return tick();
}
