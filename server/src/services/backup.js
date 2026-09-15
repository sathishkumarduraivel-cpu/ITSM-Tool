// Two distinct kinds of backup, for two distinct audiences:
//
// 1. buildWorkspaceBackup() -- a JSON export of one workspace's own data,
//    available to that workspace's own admins. Deliberately excludes
//    anything credential-shaped (SSO/directory provider secrets, email
//    server passwords and mailbox tokens, AI provider API keys, external
//    connection auth, API key hashes) -- a "back up my data" feature
//    becoming a secrets-exfiltration vector would be a strictly worse
//    outcome than not having it at all. Restoring configuration after a
//    disaster means reconnecting those integrations, not replaying secrets
//    from a file.
// 2. exportRawDatabase() -- the actual SQLite file, for a true whole-instance
//    disaster-recovery restore. Gated to super-admins only in routes/admin.js
//    since it spans every workspace. Secrets inside it are still encrypted
//    at rest (crypto.js), so even this file changing hands doesn't expose
//    plaintext credentials on its own.
import fs from 'node:fs';
import path from 'node:path';
import { db, uid, DATA_DIR, DB_FILE_PATH } from '../db.js';

function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}

export function buildWorkspaceBackup(workspaceId) {
  const workspace = db.prepare('SELECT id, name, slug, created_at FROM workspaces WHERE id = ?').get(workspaceId);
  if (!workspace) throw new Error('Workspace not found');

  const data = {
    // Curated, not `SELECT *` -- the one table in this export that actually
    // holds authentication material (password_hash, totp_secret, recovery
    // code hashes live in a separate table not included here at all).
    users: all(
      `SELECT u.id, u.name, u.email, u.avatar_color, u.language, u.location, u.timezone, u.created_at,
              wm.role, wm.team, wm.active, wm.employee_id, wm.manager_id, wm.custom_role_id
       FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? ORDER BY u.name`,
      workspaceId
    ),
    custom_roles: all('SELECT * FROM custom_roles WHERE workspace_id = ?', workspaceId),
    groups: all('SELECT * FROM groups WHERE workspace_id = ?', workspaceId),
    group_members: all('SELECT gm.* FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE g.workspace_id = ?', workspaceId),

    tickets: all('SELECT * FROM tickets WHERE workspace_id = ? AND deleted_at IS NULL', workspaceId),
    ticket_comments: all('SELECT tc.* FROM ticket_comments tc JOIN tickets t ON t.id = tc.ticket_id WHERE t.workspace_id = ? AND t.deleted_at IS NULL', workspaceId),
    ticket_history: all('SELECT th.* FROM ticket_history th JOIN tickets t ON t.id = th.ticket_id WHERE t.workspace_id = ? AND t.deleted_at IS NULL', workspaceId),
    ticket_tasks: all('SELECT * FROM ticket_tasks WHERE workspace_id = ?', workspaceId),
    ticket_watchers: all('SELECT tw.* FROM ticket_watchers tw JOIN tickets t ON t.id = tw.ticket_id WHERE t.workspace_id = ? AND t.deleted_at IS NULL', workspaceId),
    approvals: all('SELECT a.* FROM approvals a JOIN tickets t ON t.id = a.ticket_id WHERE t.workspace_id = ? AND t.deleted_at IS NULL', workspaceId),
    csat_surveys: all('SELECT cs.* FROM csat_surveys cs JOIN tickets t ON t.id = cs.ticket_id WHERE t.workspace_id = ? AND t.deleted_at IS NULL', workspaceId),

    ticket_custom_fields: all('SELECT * FROM ticket_custom_fields WHERE workspace_id = ?', workspaceId),
    ticket_custom_field_values: all(
      'SELECT v.* FROM ticket_custom_field_values v JOIN ticket_custom_fields f ON f.id = v.field_id WHERE f.workspace_id = ?', workspaceId
    ),

    assets: all('SELECT * FROM assets WHERE workspace_id = ?', workspaceId),
    asset_relationships: all('SELECT ar.* FROM asset_relationships ar JOIN assets a ON a.id = ar.asset_id WHERE a.workspace_id = ?', workspaceId),
    ticket_assets: all('SELECT ta.* FROM ticket_assets ta JOIN tickets t ON t.id = ta.ticket_id WHERE t.workspace_id = ? AND t.deleted_at IS NULL', workspaceId),

    kb_articles: all('SELECT * FROM kb_articles WHERE workspace_id = ?', workspaceId),
    sla_policies: all('SELECT * FROM sla_policies WHERE workspace_id = ?', workspaceId),
    business_hours: all('SELECT * FROM business_hours WHERE workspace_id = ?', workspaceId),
    escalation_policies: all('SELECT * FROM escalation_policies WHERE workspace_id = ?', workspaceId),
    escalation_levels: all('SELECT el.* FROM escalation_levels el JOIN escalation_policies ep ON ep.id = el.policy_id WHERE ep.workspace_id = ?', workspaceId),
    business_rules: all('SELECT * FROM business_rules WHERE workspace_id = ?', workspaceId),

    catalog_categories: all('SELECT * FROM catalog_categories WHERE workspace_id = ?', workspaceId),
    catalog_items: all('SELECT * FROM catalog_items WHERE workspace_id = ?', workspaceId),
    automations: all('SELECT * FROM automations WHERE workspace_id = ?', workspaceId),

    contracts: all('SELECT * FROM contracts WHERE workspace_id = ?', workspaceId),
    purchase_orders: all('SELECT * FROM purchase_orders WHERE workspace_id = ?', workspaceId),

    hr_cases: all('SELECT * FROM hr_cases WHERE workspace_id = ?', workspaceId),
    hr_case_tasks: all('SELECT hct.* FROM hr_case_tasks hct JOIN hr_cases hc ON hc.id = hct.case_id WHERE hc.workspace_id = ?', workspaceId),
    hr_case_templates: all('SELECT * FROM hr_case_templates WHERE workspace_id = ?', workspaceId),

    major_incidents: all('SELECT * FROM major_incidents WHERE workspace_id = ?', workspaceId),
    major_incident_updates: all('SELECT miu.* FROM major_incident_updates miu JOIN major_incidents mi ON mi.id = miu.major_incident_id WHERE mi.workspace_id = ?', workspaceId),
    major_incident_related_tickets: all('SELECT mirt.* FROM major_incident_related_tickets mirt JOIN major_incidents mi ON mi.id = mirt.major_incident_id WHERE mi.workspace_id = ?', workspaceId),

    email_templates: all('SELECT * FROM email_templates WHERE workspace_id = ?', workspaceId),
    canned_responses: all('SELECT * FROM canned_responses WHERE workspace_id = ?', workspaceId),
    notification_templates: all('SELECT * FROM notification_templates WHERE workspace_id = ?', workspaceId),
    saved_reports: all('SELECT * FROM saved_reports WHERE workspace_id = ?', workspaceId),
  };

  const counts = Object.fromEntries(Object.entries(data).map(([k, rows]) => [k, rows.length]));

  return {
    meta: {
      format: 'itsm-ai-workspace-backup-v1',
      exported_at: new Date().toISOString(),
      workspace: { id: workspace.id, name: workspace.name, slug: workspace.slug },
      counts,
      note: "Credentials and third-party integration secrets (SSO, email/mailbox, AI provider keys, API keys, external connection auth) are intentionally excluded. Attachment file contents are not included, only ticket/record data. Restoring this file back into the app isn't automated -- it's meant as a readable, portable record of your workspace's data.",
    },
    ...data,
  };
}

// A guaranteed-consistent snapshot (SQLite's own VACUUM INTO, the same
// mechanism real backup tooling uses) rather than a plain filesystem copy of
// the live .db file, which could in principle be read mid-write. The
// snapshot is written to a throwaway temp file next to the real database and
// the caller (routes/admin.js) is responsible for deleting it once the
// response has finished streaming.
export function snapshotRawDatabase() {
  const tmpPath = path.join(DATA_DIR, `backup-snapshot-${uid()}.db`);
  const escaped = tmpPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${escaped}'`);
  return tmpPath;
}

export function cleanupSnapshot(tmpPath) {
  fs.unlink(tmpPath, () => {}); // best-effort -- a leftover temp file is harmless, never worth failing the request over
}

export function dbFileSizeBytes() {
  try {
    return fs.statSync(DB_FILE_PATH).size;
  } catch {
    return null;
  }
}
