import { db, uid } from '../db.js';
import { sendToUser } from './realtime.js';

// This is the single choke point almost every notification-worthy event in
// the app already flows through (approvals, escalations, major incidents,
// groups, workspaces, catalog requests, HR cases...) -- pushing the
// real-time event from here, rather than at each of those dozens of call
// sites, makes all of them instant for free instead of waiting out
// NotificationBell's 20s poll (kept as a fallback, not removed).
export function notifyUser(userId, title, body, link, workspaceId) {
  if (!userId) return;
  const id = uid('ntf');
  db.prepare('INSERT INTO notifications (id, user_id, title, body, link, workspace_id) VALUES (?,?,?,?,?,?)').run(
    id, userId, title, body || '', link || null, workspaceId || null
  );
  if (workspaceId) sendToUser(workspaceId, userId, 'notification.new', { id, title, body, link });
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
