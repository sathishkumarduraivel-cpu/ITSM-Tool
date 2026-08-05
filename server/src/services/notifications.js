import { db, uid } from '../db.js';

export function notifyUser(userId, title, body, link, workspaceId) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (id, user_id, title, body, link, workspace_id) VALUES (?,?,?,?,?,?)').run(
    uid('ntf'), userId, title, body || '', link || null, workspaceId || null
  );
}

export function notifyRole(role, title, body, link, workspaceId) {
  const users = db.prepare(
    'SELECT u.id FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND wm.role = ? AND wm.active = 1'
  ).all(workspaceId, role);
  for (const u of users) notifyUser(u.id, title, body, link, workspaceId);
}

export function renderTemplate(event, vars = {}, workspaceId = null) {
  const tpl = workspaceId
    ? db.prepare('SELECT * FROM notification_templates WHERE workspace_id = ? AND event = ? AND enabled = 1 LIMIT 1').get(workspaceId, event)
    : db.prepare('SELECT * FROM notification_templates WHERE event = ? AND enabled = 1 LIMIT 1').get(event);
  if (!tpl) return null;
  const fill = (str) => (str || '').replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] ?? ''));
  return { subject: fill(tpl.subject), body: fill(tpl.body), channel: tpl.channel };
}
