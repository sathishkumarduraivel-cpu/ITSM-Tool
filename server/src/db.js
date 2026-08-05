// Uses Node's built-in node:sqlite (available Node 22.5+) so this app runs
// with zero native module compilation — no node-gyp/python toolchain required
// on the machine that runs it. That's a deliberate choice for portability.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encrypt, isEncrypted } from './services/crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const rawDb = new DatabaseSync(path.join(dataDir, 'itsm.db'));
// Rollback-journal mode (SQLite's default) rather than WAL: WAL relies on
// shared-memory-mapped files which some mounted/network/sandboxed filesystems
// reject with "disk I/O error". DELETE mode works everywhere.
rawDb.exec('PRAGMA journal_mode = DELETE');
rawDb.exec('PRAGMA foreign_keys = ON');

// Thin wrapper so route/service code can keep using the familiar
// better-sqlite3-style `db.prepare(sql).run/get/all(...)` call pattern.
export const db = {
  exec: (sql) => rawDb.exec(sql),
  prepare: (sql) => {
    const stmt = rawDb.prepare(sql);
    return {
      run: (...params) => stmt.run(...params),
      get: (...params) => stmt.get(...params),
      all: (...params) => stmt.all(...params),
    };
  },
};

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'requester', -- admin | agent | requester
  team TEXT,
  avatar_color TEXT DEFAULT '#6366f1',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  number TEXT UNIQUE NOT NULL,
  type TEXT NOT NULL DEFAULT 'incident', -- incident | request | problem | change
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | in_progress | on_hold | resolved | closed
  priority TEXT NOT NULL DEFAULT 'medium', -- low | medium | high | critical
  impact TEXT DEFAULT 'medium',
  category TEXT,
  subcategory TEXT,
  requester_id TEXT,
  assignee_id TEXT,
  team TEXT,
  sla_due_at TEXT,
  sla_breached INTEGER DEFAULT 0,
  ai_sentiment TEXT,
  ai_summary TEXT,
  ai_suggested_category TEXT,
  source TEXT DEFAULT 'portal', -- portal | email | slack | api | ai-chat
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  closed_at TEXT,
  FOREIGN KEY (requester_id) REFERENCES users(id),
  FOREIGN KEY (assignee_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  body TEXT NOT NULL,
  is_private INTEGER DEFAULT 0,
  is_ai INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_history (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  tag TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'hardware', -- hardware | software | license | service
  status TEXT DEFAULT 'in_use', -- in_use | in_stock | retired | maintenance
  owner_id TEXT,
  location TEXT,
  vendor TEXT,
  purchase_date TEXT,
  warranty_expiry TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (owner_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS kb_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT,
  body TEXT NOT NULL,
  tags TEXT,
  views INTEGER DEFAULT 0,
  helpful_count INTEGER DEFAULT 0,
  author_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  enabled INTEGER DEFAULT 1,
  trigger TEXT NOT NULL, -- json {event, filters}
  conditions TEXT DEFAULT '[]', -- json array
  actions TEXT NOT NULL, -- json array
  run_count INTEGER DEFAULT 0,
  last_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automation_logs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  ticket_id TEXT,
  status TEXT, -- success | error | skipped
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL, -- slack | teams | email_smtp | jira | webhook | github
  name TEXT NOT NULL,
  config TEXT NOT NULL, -- json blob, secrets included (encrypted at rest in prod)
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider_type TEXT NOT NULL, -- openai | anthropic | azure_openai | ollama | google | custom
  base_url TEXT,
  api_key TEXT,
  model TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  extra_headers TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- ---- Service Catalog ----
CREATE TABLE IF NOT EXISTS catalog_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  icon TEXT DEFAULT 'Package',
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY,
  category_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  icon TEXT DEFAULT 'Package',
  form_schema TEXT DEFAULT '[]', -- json array of {key,label,type,required,options}
  approval_required INTEGER DEFAULT 1,
  approver_role TEXT DEFAULT 'admin', -- admin | agent | manager
  default_priority TEXT DEFAULT 'medium',
  price REAL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (category_id) REFERENCES catalog_categories(id)
);

-- ---- Generic approval chain (used by catalog requests + changes) ----
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  approver_id TEXT,
  approver_role TEXT,
  step_order INTEGER DEFAULT 1,
  status TEXT DEFAULT 'pending', -- pending | approved | rejected
  comments TEXT,
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- ---- SLA policies & business hours ----
CREATE TABLE IF NOT EXISTS sla_policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  priority TEXT, -- null = matches any
  category TEXT,
  team TEXT,
  response_minutes INTEGER NOT NULL DEFAULT 60,
  resolution_minutes INTEGER NOT NULL DEFAULT 1440,
  business_hours_only INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS business_hours (
  id TEXT PRIMARY KEY,
  day_of_week INTEGER NOT NULL, -- 0=Sunday .. 6=Saturday
  start_time TEXT NOT NULL, -- 'HH:MM'
  end_time TEXT NOT NULL
);

-- ---- CMDB ----
CREATE TABLE IF NOT EXISTS asset_relationships (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL,
  related_asset_id TEXT NOT NULL,
  relationship_type TEXT DEFAULT 'depends_on', -- depends_on | hosted_on | connected_to
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE,
  FOREIGN KEY (related_asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_assets (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

-- ---- Contracts & Purchase Orders ----
CREATE TABLE IF NOT EXISTS contracts (
  id TEXT PRIMARY KEY,
  vendor TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'support', -- support | license | lease | service
  start_date TEXT,
  end_date TEXT,
  value REAL,
  renewal_notice_days INTEGER DEFAULT 30,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  po_number TEXT UNIQUE NOT NULL,
  vendor TEXT NOT NULL,
  item TEXT NOT NULL,
  amount REAL,
  status TEXT DEFAULT 'draft', -- draft | ordered | received | cancelled
  ordered_date TEXT,
  received_date TEXT,
  asset_id TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (asset_id) REFERENCES assets(id)
);

-- ---- Notifications ----
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link TEXT,
  read INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS notification_templates (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL, -- ticket_created | ticket_assigned | sla_breach | approval_requested | change_approved | ticket_resolved
  channel TEXT DEFAULT 'in_app', -- in_app | email | slack
  subject TEXT,
  body TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---- CSAT ----
CREATE TABLE IF NOT EXISTS csat_surveys (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  rating INTEGER NOT NULL, -- 1-5
  comment TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- ---- Workspaces (multi-tenant isolation) ----
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  logo_color TEXT DEFAULT '#6366f1',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'requester', -- admin | agent | requester, scoped to this workspace
  team TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, user_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE IF NOT EXISTS ticket_counters (
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 999,
  PRIMARY KEY (workspace_id, type)
);

-- ---- Ticket field visibility/required rules ----
CREATE TABLE IF NOT EXISTS ticket_field_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_type TEXT NOT NULL, -- incident | request | problem | change
  category TEXT, -- null = applies to all categories of this type
  field_name TEXT NOT NULL,
  visible INTEGER DEFAULT 1,
  required INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---- Ticket attachments ----
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  uploaded_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users(id)
);
`);

// Additive migrations for columns introduced after the initial tickets table
// (safe no-ops if the column already exists).
const ticketColumnMigrations = [
  "ALTER TABLE tickets ADD COLUMN risk TEXT",
  "ALTER TABLE tickets ADD COLUMN planned_start TEXT",
  "ALTER TABLE tickets ADD COLUMN planned_end TEXT",
  "ALTER TABLE tickets ADD COLUMN rollback_plan TEXT",
  "ALTER TABLE tickets ADD COLUMN cab_status TEXT DEFAULT 'not_required'", // not_required | pending | approved | rejected
  "ALTER TABLE tickets ADD COLUMN catalog_item_id TEXT",
  "ALTER TABLE tickets ADD COLUMN catalog_form_data TEXT",
  "ALTER TABLE tickets ADD COLUMN sla_policy_id TEXT",
  "ALTER TABLE tickets ADD COLUMN response_due_at TEXT",
  "ALTER TABLE tickets ADD COLUMN responded_at TEXT",
  // workspace / multi-tenant isolation columns (nullable — node:sqlite can't
  // ADD COLUMN with NOT NULL + backfill atomically; correctness is app-enforced,
  // matching this codebase's existing style)
  "ALTER TABLE users ADD COLUMN is_super_admin INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN last_workspace_id TEXT",
  "ALTER TABLE tickets ADD COLUMN workspace_id TEXT",
  "ALTER TABLE assets ADD COLUMN workspace_id TEXT",
  "ALTER TABLE kb_articles ADD COLUMN workspace_id TEXT",
  "ALTER TABLE automations ADD COLUMN workspace_id TEXT",
  "ALTER TABLE integrations ADD COLUMN workspace_id TEXT",
  "ALTER TABLE catalog_categories ADD COLUMN workspace_id TEXT",
  "ALTER TABLE catalog_items ADD COLUMN workspace_id TEXT",
  "ALTER TABLE sla_policies ADD COLUMN workspace_id TEXT",
  "ALTER TABLE business_hours ADD COLUMN workspace_id TEXT",
  "ALTER TABLE contracts ADD COLUMN workspace_id TEXT",
  "ALTER TABLE purchase_orders ADD COLUMN workspace_id TEXT",
  "ALTER TABLE ai_providers ADD COLUMN workspace_id TEXT",
  "ALTER TABLE notification_templates ADD COLUMN workspace_id TEXT",
  "ALTER TABLE notifications ADD COLUMN workspace_id TEXT",
];
for (const sql of ticketColumnMigrations) {
  try {
    db.exec(sql);
  } catch {
    // column already exists — ignore
  }
}

export function uid(prefix = '') {
  const rand = Math.random().toString(36).slice(2, 10);
  return prefix ? `${prefix}_${Date.now().toString(36)}${rand}` : `${Date.now().toString(36)}${rand}`;
}

// ---- One-time secrets re-encryption (idempotent — guarded by a system flag row) ----
const SYSTEM_WS = '_system';
const secretsFlag = db.prepare('SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?').get(SYSTEM_WS, 'secrets_encrypted_v1');
if (!secretsFlag) {
  for (const p of db.prepare('SELECT id, api_key FROM ai_providers').all()) {
    if (p.api_key && !isEncrypted(p.api_key)) {
      db.prepare('UPDATE ai_providers SET api_key = ? WHERE id = ?').run(encrypt(p.api_key), p.id);
    }
  }
  for (const i of db.prepare('SELECT id, config FROM integrations').all()) {
    if (i.config && !isEncrypted(i.config)) {
      db.prepare('UPDATE integrations SET config = ? WHERE id = ?').run(encrypt(i.config), i.id);
    }
  }
  db.prepare('INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value) VALUES (?,?,?)').run(SYSTEM_WS, 'secrets_encrypted_v1', '1');
}

// ---- Workspace backfill (idempotent) — ensures a Default Workspace exists,
// every user has a membership, and every tenant table's rows are scoped to it.
let defaultWorkspace = db.prepare('SELECT * FROM workspaces WHERE slug = ?').get('default');
if (!defaultWorkspace) {
  const wsId = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(wsId, 'Default Workspace', 'default');
  defaultWorkspace = { id: wsId };
}
export const DEFAULT_WORKSPACE_ID = defaultWorkspace.id;

const orphanUsers = db.prepare(`
  SELECT u.id, u.role, u.team FROM users u
  LEFT JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
  WHERE wm.id IS NULL
`).all(DEFAULT_WORKSPACE_ID);
for (const u of orphanUsers) {
  db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, team) VALUES (?,?,?,?,?)')
    .run(uid('wm'), DEFAULT_WORKSPACE_ID, u.id, u.role, u.team);
}
db.prepare('UPDATE users SET last_workspace_id = ? WHERE last_workspace_id IS NULL').run(DEFAULT_WORKSPACE_ID);

const tenantTables = [
  'tickets', 'assets', 'kb_articles', 'automations', 'integrations',
  'catalog_categories', 'catalog_items', 'sla_policies', 'business_hours',
  'contracts', 'purchase_orders', 'ai_providers', 'notification_templates',
  'notifications', 'ticket_field_rules', 'attachments',
];
for (const table of tenantTables) {
  try {
    db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IS NULL`).run(DEFAULT_WORKSPACE_ID);
  } catch {
    // ignore — table may be empty/not yet populated
  }
}

// seed ticket_counters from existing ticket numbers so numbering continues rather than resetting
const TYPE_PREFIX = { incident: 'INC', request: 'REQ', problem: 'PRB', change: 'CHG' };
for (const type of Object.keys(TYPE_PREFIX)) {
  const existing = db.prepare('SELECT seq FROM ticket_counters WHERE workspace_id = ? AND type = ?').get(DEFAULT_WORKSPACE_ID, type);
  if (!existing) {
    let maxSeq = 999;
    for (const row of db.prepare('SELECT number FROM tickets WHERE workspace_id = ? AND type = ?').all(DEFAULT_WORKSPACE_ID, type)) {
      const m = /(\d+)$/.exec(row.number || '');
      if (m) maxSeq = Math.max(maxSeq, parseInt(m[1], 10));
    }
    db.prepare('INSERT INTO ticket_counters (workspace_id, type, seq) VALUES (?,?,?)').run(DEFAULT_WORKSPACE_ID, type, maxSeq);
  }
}
