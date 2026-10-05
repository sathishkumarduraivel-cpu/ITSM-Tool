import { db, uid } from '../db.js';

// Fire-and-forget, same pattern as evaluateEscalationsSafely -- an audit
// write must never break the request it's recording. `req` only needs
// .user/.workspaceId/.ip, so a plain object with those three keys works too
// (used at login, before requireAuth/requireWorkspace have populated a real
// req). Never pass secret/credential values in `details`.
export function logAudit(req, { action, entityType, entityId, entityLabel, details }) {
  try {
    db.prepare(
      `INSERT INTO audit_log (id, workspace_id, actor_id, actor_name, actor_role, action, entity_type, entity_id, entity_label, details, ip_address)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      uid('aud'),
      req?.workspaceId || null,
      req?.user?.id || null,
      req?.user?.name || null,
      req?.user?.role || null,
      action,
      entityType || null,
      entityId || null,
      entityLabel || null,
      details !== undefined ? JSON.stringify(details) : null,
      req?.ip || null
    );
  } catch (e) {
    console.error('[audit] failed to record entry', e);
  }
}
