// The third and last real background job in this app, alongside
// directorySyncScheduler.js and inboundEmailScheduler.js -- and held to the
// same bar those two document: a timer is only justified when nothing reads
// the event into existence.
//
// Three things here clear that bar, and nothing else in these modules does:
//   1. Internal monitors -- an SLA sliding into breach at 03:00 has no
//      request to hang off, and the whole point is to notice before a human
//      does.
//   2. Unacknowledged-alert escalation -- "nobody responded for 15 minutes"
//      is the absence of an event, which by definition cannot be triggered
//      by one.
//   3. Stale-alert auto-resolve -- a monitoring tool that dies mid-incident
//      never sends its recovery notification, so an alert would otherwise
//      stay open forever.
//
// Separate module and separate interval from the other two schedulers, for
// the reason inboundEmailScheduler.js gives: unrelated concerns that happen
// to share a shape should not share a timer, since one's cadence or failure
// has no business affecting the other's.
import { db } from '../db.js';
import { evaluateAllMonitors } from './internalMonitors.js';
import { escalateUnacknowledged } from './alertRules.js';
import { logAlertEvent } from './alertIngest.js';
import { sweepApprovalSlaBreaches } from './changeApproval.js';

// A minute is the coarsest tick that still feels immediate for paging, and
// the work per tick is a handful of indexed counts -- monitors dedupe on a
// stable key, so a condition that stays true does not accumulate alerts.
const TICK_MS = 60 * 1000;

// An open alert nobody has touched and whose source has gone quiet for this
// long is presumed stale rather than ongoing. Generous on purpose: closing a
// real ongoing incident because its tool is only noisy every few hours would
// be worse than leaving it open.
const STALE_AFTER_HOURS = 24;

let timer = null;

function autoResolveStale() {
  // Compared in SQL: these timestamps are datetime('now') strings, which do
  // not string-compare correctly against a JS ISO string.
  const stale = db.prepare(
    `SELECT id, workspace_id, title FROM alerts
     WHERE status = 'open' AND ticket_id IS NULL
       AND datetime(last_seen_at) < datetime('now', ?)`
  ).all(`-${STALE_AFTER_HOURS} hours`);
  for (const alert of stale) {
    db.prepare("UPDATE alerts SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(alert.id);
    logAlertEvent(alert.id, 'resolved', `Auto-resolved after ${STALE_AFTER_HOURS}h with no further occurrences`);
  }
  return stale.length;
}

function escalateOpenAlerts() {
  // Only alerts that are still strictly 'open' -- acknowledging one is
  // exactly the signal that a human has it, and must stop the paging.
  const open = db.prepare(
    "SELECT * FROM alerts WHERE status = 'open' ORDER BY first_seen_at ASC LIMIT 200"
  ).all();
  let escalated = 0;
  for (const alert of open) {
    try {
      if (escalateUnacknowledged(alert.workspace_id, alert)) escalated += 1;
    } catch (e) {
      console.error(`[alerts] escalation for ${alert.id} failed:`, e.message);
    }
  }
  return escalated;
}

async function tick() {
  try {
    const monitorResults = evaluateAllMonitors();
    const triggered = monitorResults.filter((r) => r.triggered && r.action === 'created').length;
    const escalated = escalateOpenAlerts();
    const resolved = autoResolveStale();
    if (triggered || escalated || resolved) {
      console.log(`[alerts] tick: ${triggered} new internal alert(s), ${escalated} escalation(s), ${resolved} auto-resolved`);
    }
  } catch (e) {
    console.error('[alerts] tick error', e);
  }

  // Change approval SLAs ride this tick rather than getting a timer of their
  // own. A missed approval deadline is the absence of an event, which no
  // request can trigger -- the same justification this module already
  // documents for existing at all -- and its cadence (a minute) is fine for
  // an SLA measured in hours.
  try {
    const breached = sweepApprovalSlaBreaches();
    if (breached) console.log(`[changes] tick: ${breached} approval SLA breach(es) flagged`);
  } catch (e) {
    console.error('[changes] approval SLA sweep error', e);
  }
}

export function startAlertScheduler() {
  if (timer) return; // idempotent, same guard as the other two schedulers
  timer = setInterval(() => { tick().catch((e) => console.error('[alerts] tick error', e)); }, TICK_MS).unref();
}

// Lets the test suite and the admin "run now" action drive a real tick
// instead of waiting for the interval, matching inboundEmailScheduler.js's
// _runTickNow.
export function _runTickNow() {
  return tick();
}
