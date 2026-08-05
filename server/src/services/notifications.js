import { db, uid } from '../db.js';

export function notifyUser(userId, title, body, link) {
  if (!userId) return;
  db.prepare('INSERT INTO notifications (id, user_id, title, body, link) VALUES (?,?,?,?,?)').run(
    uid('ntf'), userId, title, body || '', link || null
  );
}

export function notifyRole(role, title, body, link) {
  const users = db.prepare('SELECT id FROM users WHERE role = ?').all(role);
  for (const u of users) notifyUser(u.id, title, body, link);
}

export function renderTemplate(event, vars = {}) {
  const tpl = db.prepare('SELECT * FROM notification_templates WHERE event = ? AND enabled = 1 LIMIT 1').get(event);
  if (!tpl) return null;
  const fill = (str) => (str || '').replace(/\{\{(\w+)\}\}/g, (_, key) => (vars[key] ?? ''));
  return { subject: fill(tpl.subject), body: fill(tpl.body), channel: tpl.channel };
}
