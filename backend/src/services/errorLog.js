// Persists unhandled errors so they're visible in Admin Settings -> Error
// Monitoring instead of only ever existing as a console.log line that
// scrolls away -- especially important on this app's Render deployment,
// where the console output of a prior instance is gone the moment it's
// replaced (see db.js's own note on that same ephemeral-disk reality).
// Called from two places: index.js's final Express error handler (a real
// request context exists) and its process-level uncaughtException/
// unhandledRejection listeners (no request at all, `req` is null).
import { db, uid } from '../db.js';

export function logError(err, req) {
  try {
    const path = req?.originalUrl ? req.originalUrl.split('?')[0] : null; // strip query string -- the realtime stream carries its auth token there (see middleware/auth.js), same reason morgan excludes it from the access log
    db.prepare(
      `INSERT INTO error_log (id, workspace_id, method, path, status_code, message, stack, user_id, user_email, ip_address)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      uid('err'),
      req?.workspaceId || null,
      req?.method || null,
      path,
      Number.isInteger(err?.statusCode) ? err.statusCode : 500,
      String(err?.message ?? err ?? 'Unknown error').slice(0, 2000),
      err?.stack ? String(err.stack).slice(0, 8000) : null,
      req?.user?.id || null,
      req?.user?.email || null,
      req?.ip || null
    );
  } catch (e) {
    // Never let error logging itself become a new source of errors -- if
    // the DB write fails, the original error is still on stderr via
    // console.error at the call site.
    console.error('[errorLog] failed to record entry', e);
  }
}
