// Uses Node's built-in node:sqlite (available Node 22.5+) so this app runs
// with zero native module compilation — no node-gyp/python toolchain required
// on the machine that runs it. That's a deliberate choice for portability.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { encrypt, isEncrypted } from './services/crypto.js';
import { legacyToGraph } from './services/workflowGraph.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Overridable so the automated test suite (test/setup.mjs) can point every
// test file at its own throwaway temp directory instead of ever touching
// this project's real server/data/itsm.db -- the same "configurable
// location for testability" pattern already used for graphMailer.js's
// GRAPH_LOGIN_BASE/GRAPH_API_BASE. Unset in every real deployment.
const dataDir = process.env.ITSM_DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

// Exposed for services/backup.js's raw-database export (super-admin only) --
// nothing else outside this module should ever need the file's location on
// disk, every other consumer goes through the `db` wrapper below.
export const DATA_DIR = dataDir;
export const DB_FILE_PATH = path.join(dataDir, 'itsm.db');

const rawDb = new DatabaseSync(DB_FILE_PATH);
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

-- Read-only visibility onto a ticket for someone other than its requester --
-- currently populated only by merging (the losing ticket's requester
-- becomes a watcher on the surviving one, so they don't lose all visibility
-- into their issue just because it got merged), but deliberately generic
-- enough to reuse for a future "CC someone on this ticket" feature. A
-- watcher can view/GET the ticket like the requester can, but NOT post
-- comments/attachments/CSAT on it -- those stay requester-or-agent-only.
CREATE TABLE IF NOT EXISTS ticket_watchers (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ticket_id, user_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_history (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  event TEXT NOT NULL,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Ticket Tasks: a checklist of assignable, sequenceable sub-items under one
-- ticket (e.g. an onboarding request's "Provision laptop" / "Create AD
-- account" / "Order badge"), distinct from the parent ticket itself and from
-- a Business Rule's per-field logic -- these are work items, not form
-- fields. The depends_on_task_id column is an optional same-ticket predecessor: the
-- UI blocks moving a task to in_progress/done until its dependency is done
-- (see services/tasks.js's cycle check on write). Never hard-deleted from
-- ticket_history's perspective -- creation/completion are logged there like
-- every other ticket event -- but the row itself IS a real DELETE when
-- removed, since a checklist item is disposable in a way a ticket is not.
CREATE TABLE IF NOT EXISTS ticket_tasks (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open', -- open | in_progress | done
  priority TEXT NOT NULL DEFAULT 'medium', -- low | medium | high
  assignee_id TEXT,
  due_date TEXT,
  sort_order INTEGER DEFAULT 0,
  depends_on_task_id TEXT,
  created_by TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
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

-- ---- Escalation Rules: automatic multi-level escalation as a ticket
-- approaches or breaches its SLA resolution window. Matched to a ticket the
-- same way sla_policies is (most-specific-wins on type/priority/team), and
-- each policy can have several ordered levels (e.g. 50% -> notify the group,
-- 100% -> bump priority + notify an admin). No scheduler/cron exists
-- anywhere in this app by design -- see evaluateEscalations() in
-- escalationEngine.js for how this still fires close to real-time without
-- one (evaluated whenever a ticket is read or updated, not on a timer). ----
CREATE TABLE IF NOT EXISTS escalation_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ticket_type TEXT, -- null = matches any type
  priority TEXT,    -- null = matches any priority
  team TEXT,        -- null = matches any group
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS escalation_levels (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  level_order INTEGER NOT NULL DEFAULT 1,
  threshold_pct INTEGER NOT NULL, -- % of the resolution SLA window elapsed
  notify_role TEXT,     -- 'admin' | 'agent' -- null = no role notify
  notify_user_id TEXT,  -- a specific person (e.g. a manager) -- null = none
  set_priority TEXT,    -- bump the ticket to this priority -- null = leave as-is
  post_comment INTEGER DEFAULT 1, -- add a visible note on the ticket when this level fires
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (policy_id) REFERENCES escalation_policies(id) ON DELETE CASCADE
);

-- Which levels have already fired for which ticket, so re-evaluating never
-- re-notifies for the same threshold twice.
CREATE TABLE IF NOT EXISTS ticket_escalations (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  level_id TEXT NOT NULL,
  fired_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ticket_id, level_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (level_id) REFERENCES escalation_levels(id) ON DELETE CASCADE
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

CREATE TABLE IF NOT EXISTS custom_roles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]', -- JSON array of permission keys, see services/permissions.js
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,       -- e.g. 'sla_policy.created', 'user.updated' -- see services/auditLog.js callers for the full vocabulary
  entity_type TEXT,
  entity_id TEXT,
  entity_label TEXT,          -- human-readable snapshot (name/email at the time) so the row still reads clearly after the entity is renamed or deleted
  details TEXT,                -- JSON, free-form -- never a secret/credential value
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_workspace ON audit_log(workspace_id, created_at DESC);

-- Major Incident Management: a Major Incident is a distinct governance
-- record anchored to one ordinary incident ticket, not a ticket type of its
-- own -- the anchor ticket keeps behaving like any other incident (SLA,
-- lifecycle, comments) while this record adds severity, an Incident
-- Commander, a communication cadence, related-ticket linking, and a
-- post-incident review, none of which make sense on a routine ticket.
CREATE TABLE IF NOT EXISTS major_incidents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  number TEXT NOT NULL,                        -- MI-1, MI-2... own sequence, independent of ticket numbers
  severity TEXT NOT NULL DEFAULT 'sev2',        -- sev1 | sev2 | sev3
  status TEXT NOT NULL DEFAULT 'active',        -- active | monitoring | resolved | closed
  summary TEXT NOT NULL,
  impact_description TEXT,
  commander_id TEXT,
  declared_by TEXT,
  declared_at TEXT DEFAULT (datetime('now')),
  update_interval_minutes INTEGER DEFAULT 30,   -- how often a status update is expected while active/monitoring
  next_update_due_at TEXT,                      -- read-time computed "overdue" flag, same no-scheduler pattern as SLA/escalations
  resolved_at TEXT,
  pir_due_at TEXT,                              -- set on resolve; post-incident review expected within a few days
  pir_status TEXT DEFAULT 'not_started',        -- not_started | in_progress | completed
  pir_document TEXT,
  closed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id)
);

CREATE TABLE IF NOT EXISTS major_incident_updates (
  id TEXT PRIMARY KEY,
  major_incident_id TEXT NOT NULL,
  author_id TEXT,
  author_name TEXT,
  message TEXT NOT NULL,
  status_at_time TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (major_incident_id) REFERENCES major_incidents(id) ON DELETE CASCADE
);

-- Tickets that appear to be the same underlying outage (duplicate reports,
-- downstream symptoms) get linked here rather than merged -- unlike Ticket
-- Merging, a related ticket keeps its own life, ownership and history; it's
-- just visibly grouped under the Major Incident for coordination.
CREATE TABLE IF NOT EXISTS major_incident_related_tickets (
  id TEXT PRIMARY KEY,
  major_incident_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  linked_at TEXT DEFAULT (datetime('now')),
  UNIQUE(major_incident_id, ticket_id),
  FOREIGN KEY (major_incident_id) REFERENCES major_incidents(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Self-Service AI Chatbot: a session per "describe a new problem" conversation
-- (separate from the general-purpose Sona command hub / ask-about-my-tickets
-- flow already backed by /ai/ask and /ai/my-tickets-ask). Tracked as its own
-- entity specifically so deflection can be measured -- did the Knowledge Base
-- actually resolve this, or did it end in a real ticket -- the standard KPI
-- for a self-service deflection chatbot that a plain Q&A assistant has no
-- equivalent of.
CREATE TABLE IF NOT EXISTS chatbot_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT DEFAULT 'open', -- open | deflected | escalated
  ticket_id TEXT,             -- set once escalated to a real ticket
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS chatbot_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL, -- user | assistant
  content TEXT NOT NULL,
  kb_article_ids TEXT, -- JSON array -- articles cited by this assistant reply, if any
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES chatbot_sessions(id) ON DELETE CASCADE
);

-- Single Sign-On: an admin-configured OAuth app per workspace per provider
-- (their own Google Cloud / Microsoft Entra app registration -- this is a
-- BYO-credentials integration, same philosophy as ai_providers/integrations/
-- external_connections, never a hardcoded vendor). allowed_domain, if set,
-- is the only real access control on auto-provisioning -- without it,
-- anyone with a Google/Microsoft account could sign themselves into this
-- workspace, so the admin UI strongly steers toward setting it.
CREATE TABLE IF NOT EXISTS sso_providers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,              -- google | microsoft
  client_id TEXT NOT NULL,
  client_secret TEXT NOT NULL,         -- encrypted, see services/crypto.js
  tenant_id TEXT,                      -- microsoft only; null = 'common' (any Microsoft account/org)
  allowed_domain TEXT,                 -- optional -- restrict sign-in/auto-provision to this email domain
  auto_provision_role TEXT NOT NULL DEFAULT 'requester',
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, provider)
);

-- Directory Sync: unlike sso_providers above (a redirect-based OAuth login
-- that only ever hears from someone who successfully signs in), this
-- actively queries an external directory's full user list on a schedule --
-- see services/directorySync.js -- to provision new accounts, refresh
-- details, and deactivate (never hard-delete) anyone removed/disabled
-- there. Genuinely new capability, not an extension of SSO.
CREATE TABLE IF NOT EXISTS directory_providers (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  type TEXT NOT NULL,                        -- ldap | microsoft_graph
  name TEXT NOT NULL,
  config TEXT NOT NULL,                      -- encrypted JSON, shape varies by type
  sync_interval_minutes INTEGER DEFAULT 0,   -- 0 = periodic sync off, manual "Sync now" only
  auto_provision_role TEXT NOT NULL DEFAULT 'requester',
  default_custom_role_id TEXT,
  default_team TEXT,
  enabled INTEGER DEFAULT 1,
  last_synced_at TEXT,
  last_sync_status TEXT,                     -- success | error
  last_sync_summary TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS directory_sync_logs (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL,                      -- success | error
  summary TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (provider_id) REFERENCES directory_providers(id) ON DELETE CASCADE
);

-- Email Configuration: one SMTP profile per workspace (a config singleton,
-- not a list -- unlike integrations.email_smtp, which models arbitrary
-- outbound webhooks/notifiers, this is THE transactional email system every
-- lifecycle event below sends real mail through). Password is encrypted at
-- rest the same way as every other stored secret in this app (crypto.js).
CREATE TABLE IF NOT EXISTS email_settings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL UNIQUE,
  enabled INTEGER DEFAULT 0,
  host TEXT, port INTEGER DEFAULT 587, secure INTEGER DEFAULT 0,
  username TEXT, password TEXT,
  from_name TEXT, from_email TEXT, reply_to TEXT,
  footer_html TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Email Templates: one row per lifecycle event ("key"), scoped to an
-- audience (requester/agent/admin/approver) purely for grouping in the UI --
-- who actually receives it is decided by the call site, not this column.
-- Seeded lazily (services/emailService.js's ensureDefaultTemplates, called
-- at the top of GET /email-templates and sendTemplatedEmail) rather than
-- only in seed.js, so any workspace -- including ones created after this
-- feature shipped -- always has the full set without a migration script.
CREATE TABLE IF NOT EXISTS email_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  audience TEXT NOT NULL,      -- requester | agent | admin | approver
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  body_html TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, key)
);

-- A delivery log for every attempted send (sent/failed/simulated) -- the
-- same "give the admin a recent-runs table" pattern already used for
-- directory_sync_logs, so a misconfigured SMTP profile or a disabled
-- template shows up as visible history instead of a silent no-op.
CREATE TABLE IF NOT EXISTS email_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  template_key TEXT,
  to_email TEXT NOT NULL,
  subject TEXT,
  status TEXT NOT NULL,        -- sent | failed | simulated
  error TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- One row per inbound email the poller (services/inboundEmail.js) looked at
-- on a connected mailbox -- gives the admin real visibility ("14 tickets
-- created from email, 6 replies matched, 2 skipped") the same way
-- directory_sync_logs does for directory sync, instead of inbound
-- processing being a silent background thing nobody can audit.
CREATE TABLE IF NOT EXISTS email_inbound_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  message_id TEXT,
  from_email TEXT,
  subject TEXT,
  action TEXT NOT NULL,        -- ticket_created | comment_added | skipped | error
  ticket_id TEXT,
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Canned Responses: agent-authored reply snippets surfaced in the ticket
-- Reply composer (routes/cannedResponses.js, TicketDetail.jsx). The team
-- column scopes one to a specific team's queue (e.g. only Network agents see a
-- network-outage snippet); NULL means visible to every team. Deliberately
-- agent-manageable, not admin-locked -- these are the same kind of everyday
-- personal/team productivity content as a saved KB draft, not a
-- security-sensitive configuration surface.
CREATE TABLE IF NOT EXISTS canned_responses (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  shortcut TEXT,
  category TEXT,
  team TEXT,
  body_html TEXT NOT NULL,
  created_by TEXT,
  usage_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Public Developer API: lets an external company system authenticate
-- directly against /api/v1/* without a user session, scoped to exactly the
-- resources it's granted. The raw key is shown to the admin exactly once at
-- creation time (like a Stripe/GitHub token) and never stored -- key_hash is
-- a SHA-256 of it, key_prefix is just enough of the key to recognize it in
-- a list later.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_by TEXT,
  last_used_at TEXT,
  expires_at TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS saved_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL, -- JSON: {group_by, filters}
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
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

-- ---- Ticket field visibility/required rules (legacy engine) ----
-- Superseded by business_rules below (multi-condition AND/OR, multi-action,
-- priority-ordered, active/inactive). Kept only so existing rows survive a
-- one-time migration into business_rules on boot -- the app no longer reads
-- or writes this table.
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

-- ---- Business Rule Logic Engine ----
-- One rule = a named IF/THEN: conditions is one AND/OR group evaluated
-- against a ticket's current field values, actions is an ordered list
-- applied when the group matches. Rules run in priority order (lower
-- runs first) and later rules see any values earlier ones set via
-- set_value, so ordering is meaningful, not cosmetic. status lets an
-- admin disable a rule without deleting it.
CREATE TABLE IF NOT EXISTS business_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_type TEXT NOT NULL, -- incident | request | problem | change
  name TEXT NOT NULL,
  conditions TEXT NOT NULL DEFAULT '{"logic":"AND","rules":[]}', -- JSON: { logic: 'AND'|'OR', rules: [{field, operator, value}] }
  actions TEXT NOT NULL DEFAULT '[]', -- JSON array: [{type, field, options?, value?}]
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'active', -- active | inactive
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- ---- Field Manager: admin-defined custom fields per ticket type (distinct
-- from Business Rules, which only governs visibility/required/validation of
-- fields that already exist -- these are the fields themselves). ----
CREATE TABLE IF NOT EXISTS ticket_custom_fields (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_type TEXT NOT NULL, -- incident | request | problem | change
  field_key TEXT NOT NULL, -- stable slug; referenced by stored values and by Business Rules, never changes after creation
  label TEXT NOT NULL,
  field_type TEXT NOT NULL DEFAULT 'text', -- text | textarea | select | multiselect
  options TEXT, -- JSON array of strings, for select/multiselect
  required INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, ticket_type, field_key)
);

CREATE TABLE IF NOT EXISTS ticket_custom_field_values (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  value TEXT, -- plain text; JSON-encoded array for multiselect
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (field_id) REFERENCES ticket_custom_fields(id) ON DELETE CASCADE,
  UNIQUE(ticket_id, field_id)
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

-- ---- Agent groups (Freshservice-style "Groups" — a named team of agents,
-- scoped to a single workspace so a group configured under one workspace is
-- never visible/selectable from another) ----
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- ---- Safety Guardrail Matrix: Tier C automation actions (ones that bypass
-- a governance gate, e.g. auto-approving a pending approval) don't execute
-- unattended -- they land here for a human to approve or reject first. ----
CREATE TABLE IF NOT EXISTS automation_pending_actions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  ticket_id TEXT,
  action TEXT NOT NULL, -- json blob of the single action {type, ...params}
  tier TEXT NOT NULL DEFAULT 'C',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (automation_id) REFERENCES automations(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- ---- Ticket Lifecycles: an admin-defined state machine per ticket_type,
-- opt-in and additive. A type with no row here (or enabled = 0) keeps the
-- original free-form status field exactly as before -- nothing here is
-- required for the app to function. Once enabled, tickets.status is always
-- derived from the current stage's bucket (open/in_progress/on_hold/
-- resolved/closed) so every existing SLA/dashboard/report query that filters
-- on status keeps working unmodified. ----
CREATE TABLE IF NOT EXISTS ticket_lifecycles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_type TEXT NOT NULL, -- incident | request | problem | change
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, ticket_type),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lifecycle_stages (
  id TEXT PRIMARY KEY,
  lifecycle_id TEXT NOT NULL,
  key TEXT NOT NULL, -- stable slug set at creation, never changes after -- referenced by tickets.lifecycle_stage
  label TEXT NOT NULL,
  bucket TEXT NOT NULL DEFAULT 'open', -- open | in_progress | on_hold | resolved | closed
  is_terminal INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(lifecycle_id, key),
  FOREIGN KEY (lifecycle_id) REFERENCES ticket_lifecycles(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS lifecycle_transitions (
  id TEXT PRIMARY KEY,
  lifecycle_id TEXT NOT NULL,
  from_stage_id TEXT NOT NULL,
  to_stage_id TEXT NOT NULL,
  requires_role TEXT, -- null | agent | admin -- minimum role permitted to perform this transition
  condition_field TEXT, -- optional gate against a live ticket field, e.g. cab_status
  condition_operator TEXT, -- equals | not_equals | is_empty | is_not_empty
  condition_value TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (lifecycle_id) REFERENCES ticket_lifecycles(id) ON DELETE CASCADE,
  FOREIGN KEY (from_stage_id) REFERENCES lifecycle_stages(id) ON DELETE CASCADE,
  FOREIGN KEY (to_stage_id) REFERENCES lifecycle_stages(id) ON DELETE CASCADE
);

-- ---- Employee Onboarding / Offboarding ----
-- A dedicated module rather than a 5th ticket type: tickets.type is
-- hardcoded to incident|request|problem|change in several places (lifecycle
-- engine, ticket numbering), so bolting HR cases on as a ticket type would
-- ripple invasively. hr_cases.stage is write-time derived by
-- hrCaseEngine.recomputeCaseStage() from its tasks -- never written directly
-- by a route -- so the progress stepper advances automatically as tasks
-- complete, instead of requiring a manual "move to next stage" action.
CREATE TABLE IF NOT EXISTS hr_cases (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  case_type TEXT NOT NULL, -- onboarding | offboarding
  status TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | completed | cancelled
  employee_name TEXT NOT NULL,
  employee_email TEXT,
  job_title TEXT,
  department TEXT,
  employment_type TEXT DEFAULT 'full_time', -- full_time | contractor | intern
  location TEXT,
  manager_id TEXT,
  buddy_id TEXT, -- onboarding only
  start_date TEXT, -- onboarding
  last_working_day TEXT, -- offboarding
  stage TEXT, -- derived -- see hrCaseEngine.js; not written directly by routes
  risk_level TEXT NOT NULL DEFAULT 'standard', -- standard | elevated -- offboarding only
  template_id TEXT,
  notes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  completed_at TEXT,
  FOREIGN KEY (manager_id) REFERENCES users(id),
  FOREIGN KEY (buddy_id) REFERENCES users(id),
  FOREIGN KEY (template_id) REFERENCES hr_case_templates(id)
);

-- The checklist. depends_on_task_id is advisory-only (read-time "blocked"
-- display via hrCaseEngine.isTaskBlocked) -- never hard-enforced server-side,
-- so an agent can always mark a blocked task done. Approval/sign-off steps
-- are just tasks with track='approval' + requires_decision=1, chained via
-- depends_on_task_id for multi-step sign-off -- deliberately NOT reusing the
-- ticket 'approvals' table, which is ticket-coupled (approvalEngine.js
-- force-closes tickets on rejection). Rejecting an approval task here has no
-- automatic downstream effect -- this module coordinates humans, it does not
-- enforce IAM/access revocation.
CREATE TABLE IF NOT EXISTS hr_case_tasks (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  track TEXT NOT NULL DEFAULT 'other', -- it | hr | facilities | manager | approval | other
  stage_key TEXT, -- which case_type stage this belongs to (see hrCaseEngine.js)
  group_id TEXT,
  assignee_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | in_progress | done | skipped
  requires_decision INTEGER DEFAULT 0,
  decision TEXT, -- approved | rejected -- only meaningful when requires_decision=1
  due_at TEXT,
  completed_at TEXT,
  completed_by TEXT,
  depends_on_task_id TEXT,
  sort_order INTEGER DEFAULT 0,
  source TEXT DEFAULT 'manual', -- template | ai | manual
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (case_id) REFERENCES hr_cases(id) ON DELETE CASCADE,
  FOREIGN KEY (group_id) REFERENCES groups(id),
  FOREIGN KEY (assignee_id) REFERENCES users(id),
  FOREIGN KEY (depends_on_task_id) REFERENCES hr_case_tasks(id)
);

-- Reusable department checklists. 'tasks' mirrors automations.actions'
-- JSON-blob convention -- templates are blueprints with no per-instance
-- state, which only exists once applyTemplate() materializes them into real
-- hr_case_tasks rows.
CREATE TABLE IF NOT EXISTS hr_case_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  case_type TEXT NOT NULL, -- onboarding | offboarding
  role_match TEXT, -- optional free-text hint (e.g. "Engineer") for template suggestions
  description TEXT,
  tasks TEXT NOT NULL DEFAULT '[]', -- JSON [{title,description,track,due_offset_days,requires_decision,depends_on_index}]
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---- Bilateral External Ticket Sync (ServiceNow / Jira / Freshservice) ----
-- Distinct from the 'integrations' table above, which is one-way fire-and-
-- forget notifications (Slack/Teams/email/webhook). This is real bidirectional
-- CRUD against a remote platform's own REST API: a ticket here can be linked
-- to a record there, edits here push out automatically (see
-- services/externalSync.js, hooked from routes/tickets.js's PATCH handler),
-- and edits there flow back in via a webhook receiver (routes/externalSyncWebhooks.js)
-- or a manual pull. auth_config is encrypted the same way integrations.config is.
CREATE TABLE IF NOT EXISTS external_connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  platform TEXT NOT NULL, -- servicenow | jira | freshservice
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_config TEXT NOT NULL, -- encrypted JSON, shape varies by platform (see services/externalPlatforms/*)
  field_mapping TEXT DEFAULT '{}', -- JSON: platform-specific defaults (jira project_key/issue_type, servicenow assignment_group, freshservice group_id)
  webhook_secret TEXT NOT NULL, -- random token the external platform must present on inbound calls
  enabled INTEGER DEFAULT 1,
  last_tested_at TEXT,
  last_test_ok INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ticket_external_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL, -- their sys_id / issue key / ticket id
  external_number TEXT, -- human-readable (INC0012345, PROJ-123, #456)
  external_url TEXT, -- deep link to view it on their platform
  sync_status TEXT DEFAULT 'synced', -- synced | pending | error
  last_synced_at TEXT,
  last_error TEXT,
  last_direction TEXT, -- outbound | inbound -- which direction the last successful sync went
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
  FOREIGN KEY (connection_id) REFERENCES external_connections(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ticket_sync_logs (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL,
  direction TEXT NOT NULL, -- outbound | inbound
  status TEXT NOT NULL, -- success | error
  detail TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (link_id) REFERENCES ticket_external_links(id) ON DELETE CASCADE
);

-- MFA recovery codes: a table rather than a single column because there are
-- several (see services/totp.js's generateRecoveryCodes), each independently
-- single-use -- used_at is stamped the moment one is redeemed so it can
-- never be replayed, and the set is fully replaced (old rows deleted) every
-- time MFA is re-enabled. Only a SHA-256 hash is ever stored, never the
-- code itself, same show-once/hash-at-rest pattern as api_keys.key_hash.
CREATE TABLE IF NOT EXISTS mfa_recovery_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Error Monitoring: every unhandled request error (Express's final error
-- handler in index.js) and every process-level uncaughtException/
-- unhandledRejection lands here -- see services/errorLog.js. workspace_id is
-- nullable because plenty of failures happen before requireWorkspace (or
-- even requireAuth) ever runs, and process-level crashes have no request at
-- all. Deliberately a platform-operator (super-admin) concern, not a
-- per-workspace one, unlike audit_log -- see routes/admin.js's GET /errors:
-- stack traces can carry internal implementation detail that a regular
-- workspace admin has no reason to see, and most rows here aren't cleanly
-- attributable to one workspace anyway.
CREATE TABLE IF NOT EXISTS error_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  method TEXT,
  path TEXT,
  status_code INTEGER,
  message TEXT,
  stack TEXT,
  user_id TEXT,
  user_email TEXT,
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_error_log_created ON error_log(created_at DESC);

-- ---- Change Management & CAB --------------------------------------------
-- A full ITIL change pipeline. Before this, "change management" was one
-- tickets.cab_status column plus a single approvals row -- no change types,
-- no risk scoring, no calendar, no freeze windows, no ECAB, no
-- implementation tracking, no PIR.
--
-- The ten-state lifecycle lives in tickets.change_state and is driven by
-- services/changeWorkflow.js, which also writes tickets.status to the
-- matching bucket on every transition. That keeps every existing
-- status-based query, filter and report working untouched, the same way
-- lifecycleEngine.js already derives status from a stage's bucket -- but the
-- guards here (cannot start without BOTH approval and a reserved slot,
-- cannot close without a required PIR) are change-specific and cannot be
-- expressed in the generic lifecycle engine.

-- The four change types from the flow diagram, as configuration rather than
-- a hardcoded enum: approval route, SLA, and which plans are mandatory all
-- differ per type and are exactly what an admin needs to tune.
-- pir_required_bands and mandatory_fields are JSON arrays.
CREATE TABLE IF NOT EXISTS change_types (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  key TEXT NOT NULL,                    -- standard | normal | emergency | expedite
  label TEXT NOT NULL,
  description TEXT,
  approval_mode TEXT NOT NULL,          -- auto_template | cab | ecab | expedite
  approval_sla_hours REAL,              -- null = no SLA clock
  requires_backout INTEGER DEFAULT 1,
  requires_test_plan INTEGER DEFAULT 0,
  requires_implementation_plan INTEGER DEFAULT 1,
  pir_required_bands TEXT,
  mandatory_fields TEXT,
  allow_freeze_override INTEGER DEFAULT 0,
  lead_time_hours REAL DEFAULT 0,       -- minimum notice before the planned window
  sort_order INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, key)
);

-- Pre-approved recipes. A change whose fields match one skips CAB entirely
-- (the diagram's Standard "Match?" branch); no match routes it as Normal.
CREATE TABLE IF NOT EXISTS standard_change_templates (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  match_category TEXT,                  -- null = matches any
  match_subcategory TEXT,
  match_asset_type TEXT,
  match_title_contains TEXT,
  implementation_plan TEXT,
  backout_plan TEXT,
  test_plan TEXT,
  default_risk_band TEXT DEFAULT 'low',
  auto_approve INTEGER DEFAULT 1,
  max_duration_minutes INTEGER,
  usage_count INTEGER DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Weighted risk scoring. Deliberately additive points over named signals
-- rather than a formula in code, because risk drives approval routing and an
-- admin has to be able to see and change why a change scored what it did.
-- Signals are resolved in services/changeRisk.js -- including ones the flow
-- diagram does not mention but this app can answer from its CMDB:
-- blast_radius and open_incidents_on_ci.
CREATE TABLE IF NOT EXISTS change_risk_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  signal TEXT NOT NULL,                 -- see SIGNALS in services/changeRisk.js
  operator TEXT NOT NULL,               -- equals | gte | lte | contains | is_empty | is_not_empty
  value TEXT,
  points INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER DEFAULT 1,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Score thresholds. A score lands in the highest band whose min_score it
-- reaches, so the bands stay editable without touching the rules.
CREATE TABLE IF NOT EXISTS change_risk_bands (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  band TEXT NOT NULL,                   -- low | medium | high | critical
  min_score INTEGER NOT NULL,
  color TEXT,
  sort_order INTEGER DEFAULT 0,
  UNIQUE(workspace_id, band)
);

-- The computed assessment for one change, kept whole rather than just its
-- number: contributions explains the score to the CAB, and advisory holds
-- Sona's plan review, which is shown to approvers but never feeds the score.
CREATE TABLE IF NOT EXISTS change_risk_assessments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  band TEXT NOT NULL DEFAULT 'low',
  contributions TEXT,
  advisory TEXT,
  ai_used INTEGER DEFAULT 0,
  assessed_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ticket_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- Blackout periods. allow_emergency is what makes a freeze a policy rather
-- than a wall: an Emergency change may pierce it, but only with a recorded
-- reason (tickets.freeze_override_reason), which then shows up in metrics as
-- a freeze violation instead of passing silently.
CREATE TABLE IF NOT EXISTS change_freeze_windows (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  reason TEXT,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'all',    -- all | category | asset
  scope_value TEXT,
  allow_emergency INTEGER DEFAULT 1,
  enabled INTEGER DEFAULT 1,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Reserved implementation windows -- the basis for conflict detection. Kept
-- separate from tickets.scheduled_start/end so a released reservation leaves
-- a trace and a change can be re-scheduled without losing its history.
CREATE TABLE IF NOT EXISTS change_calendar_slots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved',  -- reserved | released
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_change_slots_window ON change_calendar_slots(workspace_id, status, start_at, end_at);

-- Approval routing, matched on change type + risk band by the same
-- most-specific-wins scoring as SLA and assignment policies.
CREATE TABLE IF NOT EXISTS change_approval_routes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  match_change_type TEXT,               -- null = any type
  match_risk_band TEXT,                 -- null = any band
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- quorum lets a group step need N approvals rather than just the first --
-- a real CAB does not pass on one member clicking approve.
CREATE TABLE IF NOT EXISTS change_approval_route_steps (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL,
  step_order INTEGER NOT NULL DEFAULT 1,
  approver_type TEXT NOT NULL,          -- cab_group | ecab_group | group | role | user | requester_manager
  approver_id TEXT,
  sla_hours REAL,
  quorum INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (route_id) REFERENCES change_approval_routes(id) ON DELETE CASCADE
);

-- Real CAB sittings, so "submit to CAB as per schedule" means something. An
-- ECAB meeting is the same shape with kind='ecab' and no waiting.
CREATE TABLE IF NOT EXISTS cab_meetings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'cab',     -- cab | ecab
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  chair_id TEXT,
  quorum INTEGER DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | in_session | closed | cancelled
  minutes TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cab_agenda_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  decision TEXT,                        -- approved | rejected | approved_with_conditions | deferred
  conditions TEXT,
  notes TEXT,
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(meeting_id, ticket_id),
  FOREIGN KEY (meeting_id) REFERENCES cab_meetings(id) ON DELETE CASCADE,
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS cab_attendance (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  present INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(meeting_id, user_id),
  FOREIGN KEY (meeting_id) REFERENCES cab_meetings(id) ON DELETE CASCADE
);

-- Post Implementation Review. One per change, created when the type's
-- pir_required_bands covers the change's risk band.
CREATE TABLE IF NOT EXISTS change_pir (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  outcome TEXT,                         -- successful | successful_with_issues | failed | rolled_back
  met_objectives INTEGER,
  caused_incident INTEGER DEFAULT 0,
  incident_ticket_id TEXT,
  lessons_learned TEXT,
  follow_up_actions TEXT,
  reviewed_by TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(ticket_id),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

-- The audit table the flow diagram's developer notes ask for. Written by the
-- single transition() entry point in services/changeWorkflow.js, so no call
-- site can move a change without leaving a row. guards holds the evaluated
-- guard results, which is what makes a refusal explainable after the fact.
CREATE TABLE IF NOT EXISTS change_state_transitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  actor_id TEXT,
  actor_name TEXT,
  reason TEXT,
  guards TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_change_transitions_ticket ON change_state_transitions(ticket_id, created_at DESC);

-- Idempotency for the change API, another explicit developer note. A repeated
-- POST with the same Idempotency-Key replays the stored response instead of
-- re-running the action -- which matters most for "execute backout", where a
-- retried request must not run the backout twice.
CREATE TABLE IF NOT EXISTS request_keys (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  route TEXT NOT NULL,
  status_code INTEGER,
  response_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, route, idempotency_key)
);

-- ---- Editable options for built-in enum fields --------------------------
-- Impact, Risk and Priority were hardcoded arrays in several files at once
-- (services/businessRules.js's ENUM_OPTIONS, RISKS in two frontend files,
-- plus badge colour maps), so an admin could not add "Site-wide" to Impact
-- without a code change. These rows make them real data.
--
-- What is editable differs per field, and that constraint lives in
-- services/ticketFields.js's registry rather than being scattered here:
-- Impact and Risk are fully editable, while Priority's *value set* is fixed
-- because SLA fallback targets, the escalation engine's PRIORITY_RANK and
-- major-incident promotion all key off exactly low/medium/high/critical.
-- Its label and colour are still editable.
--
-- Seeded lazily per workspace, same approach as email_templates and the
-- category taxonomy below.
CREATE TABLE IF NOT EXISTS ticket_field_options (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  field_key TEXT NOT NULL,     -- priority | impact | risk
  value TEXT NOT NULL,         -- the stored value; immutable for locked fields
  label TEXT NOT NULL,         -- what agents see
  color TEXT,                  -- a token from services/ticketFields.js's COLORS
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, field_key, value)
);

CREATE INDEX IF NOT EXISTS idx_field_options_key ON ticket_field_options(workspace_id, field_key, sort_order);

-- ---- Ticket category taxonomy -------------------------------------------
-- tickets.category / tickets.subcategory were free-text columns, which meant
-- the picker in the ticket view, the AI classifier's own hardcoded category
-- list (services/aiClient.js categorizeTicket) and whatever an agent typed
-- could all disagree -- and every typo fragmented reporting. This makes the
-- taxonomy real, admin-owned data, and the AI classifier now reads its
-- allowed categories from here instead of a literal in its prompt.
--
-- Seeded lazily per workspace by services/ticketCategories.js's
-- ensureDefaultTaxonomy(), the same approach email_templates uses above, so
-- a workspace created before this shipped still gets the full set with no
-- migration script.
CREATE TABLE IF NOT EXISTS ticket_categories (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, name)
);

CREATE TABLE IF NOT EXISTS ticket_subcategories (
  id TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(category_id, name),
  FOREIGN KEY (category_id) REFERENCES ticket_categories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ticket_subcategories_cat ON ticket_subcategories(category_id, sort_order);

-- ---- On-Call Scheduling -------------------------------------------------
-- Deliberately stores rotation *rules*, never materialized shift rows: who
-- is on call at any instant is computed from (start_date, rotation_length,
-- member order) by services/oncallEngine.js, the same read-time-computation
-- philosophy as escalations and SLA due dates. A shift table would have to
-- be generated ahead of time and would silently drift the moment anyone
-- edited the member list or rotation length.
--
-- The timezone column is an IANA name and lives on the schedule rather than
-- being inherited from business_hours (global and timezone-less) because
-- a follow-the-sun rotation is precisely a case where two schedules in one
-- workspace need different zones. Handoffs are computed in this zone so a
-- DST transition never moves a handoff by an hour.
CREATE TABLE IF NOT EXISTS oncall_schedules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  team TEXT,               -- optional: the group this schedule covers
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Stacked layers, highest layer_order wins where several are active at once
-- (PagerDuty's model): e.g. layer 1 = 24x7 weekly primary, layer 2 = a
-- business-hours-only day shift that takes precedence while it applies.
-- The restriction column is JSON, null = always active:
--   { days: [1,2,3,4,5], start_time: '09:00', end_time: '17:00' }
CREATE TABLE IF NOT EXISTS oncall_layers (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  layer_order INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  rotation_type TEXT NOT NULL DEFAULT 'weekly', -- daily | weekly | custom
  rotation_length_days INTEGER NOT NULL DEFAULT 7,
  handoff_time TEXT NOT NULL DEFAULT '09:00',   -- 'HH:MM' in the schedule's timezone
  start_date TEXT NOT NULL,                     -- 'YYYY-MM-DD', rotation epoch
  restriction TEXT,
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (schedule_id) REFERENCES oncall_schedules(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS oncall_layer_members (
  id TEXT PRIMARY KEY,
  layer_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  member_order INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (layer_id) REFERENCES oncall_layers(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- A manual override beats every computed layer for its window -- the escape
-- hatch for "Priya is covering Tuesday night". The only stored (rather than
-- computed) piece of on-call state, which is why it can't drift: it has no
-- rotation to fall out of step with.
CREATE TABLE IF NOT EXISTS oncall_overrides (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reason TEXT,
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (schedule_id) REFERENCES oncall_schedules(id) ON DELETE CASCADE
);

-- Who gets paged, in order, when an alert on this schedule goes
-- unacknowledged. delay_minutes is measured from the alert's creation, not
-- from the previous step, so reordering steps can't accidentally compound
-- the total time to reach the last one.
CREATE TABLE IF NOT EXISTS oncall_escalation_steps (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  step_order INTEGER NOT NULL DEFAULT 1,
  target_type TEXT NOT NULL DEFAULT 'oncall_layer', -- oncall_layer | user | group | role
  target_id TEXT,
  delay_minutes INTEGER NOT NULL DEFAULT 5,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (schedule_id) REFERENCES oncall_schedules(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_oncall_layers_schedule ON oncall_layers(schedule_id, layer_order);
CREATE INDEX IF NOT EXISTS idx_oncall_members_layer ON oncall_layer_members(layer_id, member_order);
CREATE INDEX IF NOT EXISTS idx_oncall_overrides_window ON oncall_overrides(schedule_id, start_at, end_at);

-- ---- Agent availability -------------------------------------------------
-- Per-workspace, like workspace_members and for the same reason: the same
-- physical person can be a full-time agent here and an occasional one
-- elsewhere, so capacity and status describe the membership, not the user.
-- A row is created lazily on first edit; its absence means "default
-- available with the policy's default cap", so this table never needs
-- backfilling for existing members.
CREATE TABLE IF NOT EXISTS agent_availability (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', -- available | busy | dnd
  status_message TEXT,
  max_concurrent_tickets INTEGER NOT NULL DEFAULT 10,
  skills TEXT,             -- JSON array of free-text skill tags, fed to Sona
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(workspace_id, user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS agent_time_off (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reason TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_time_off_window ON agent_time_off(workspace_id, user_id, start_at, end_at);

-- ---- Assignment policies ------------------------------------------------
-- Matched to a ticket by the same most-specific-wins scoring as
-- sla_policies and escalation_policies (see findAssignmentPolicy in
-- services/assignmentEngine.js).
--
-- The four respect_* flags are separate columns rather than one JSON blob
-- because each is a hard eliminator with its own semantics, and admins
-- toggle them individually -- e.g. "respect capacity but ignore presence"
-- is a sensible config for an email-driven team that doesn't sit in the UI.
CREATE TABLE IF NOT EXISTS assignment_policies (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  match_type TEXT,      -- null = any ticket type
  match_priority TEXT,
  match_team TEXT,
  match_category TEXT,
  strategy TEXT NOT NULL DEFAULT 'least_loaded', -- least_loaded | round_robin | oncall_first | ai_sona
  candidate_source TEXT NOT NULL DEFAULT 'group', -- group | oncall_schedule | explicit_list
  candidate_group_id TEXT,
  candidate_schedule_id TEXT,
  respect_presence INTEGER DEFAULT 0,
  respect_oncall INTEGER DEFAULT 0,
  respect_status INTEGER DEFAULT 1,
  respect_capacity INTEGER DEFAULT 1,
  ai_enabled INTEGER DEFAULT 0,
  fallback_strategy TEXT NOT NULL DEFAULT 'least_loaded', -- used when AI is off/unavailable
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS assignment_policy_candidates (
  id TEXT PRIMARY KEY,
  policy_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  FOREIGN KEY (policy_id) REFERENCES assignment_policies(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Every auto-assignment decision, including the ones that assigned nobody.
-- The candidates column is the full scored set at decision time, so a "why
-- did it pick them?" question is answerable months later without re-deriving
-- state that has since changed. ai_used distinguishes a Sona decision from
-- the deterministic fallback that ran because Sona was unavailable.
CREATE TABLE IF NOT EXISTS assignment_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  ticket_id TEXT,
  policy_id TEXT,
  assigned_user_id TEXT,
  strategy_used TEXT,
  ai_used INTEGER DEFAULT 0,
  candidates TEXT,
  rationale TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assignment_log_ticket ON assignment_log(ticket_id);
CREATE INDEX IF NOT EXISTS idx_assignment_log_created ON assignment_log(workspace_id, created_at DESC);

-- ---- Alert Management ---------------------------------------------------
-- One row per monitoring integration. webhook_secret authenticates the
-- unauthenticated ingestion route (routes/alertWebhooks.js) the same way
-- external_connections.webhook_secret does for ticket sync -- a monitoring
-- tool can't send our JWT.
--
-- field_map is JSON mapping our canonical fields to dotted paths in the
-- source's own payload shape, e.g. {"title":"alert.name","entity":"host"}.
-- That's what lets one generic receiver absorb Datadog, Grafana, Prometheus
-- and a bespoke script without a code change per vendor.
CREATE TABLE IF NOT EXISTS alert_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL DEFAULT 'generic', -- generic | datadog | prometheus | grafana | nagios | zabbix | internal
  webhook_secret TEXT,
  field_map TEXT,
  default_severity TEXT NOT NULL DEFAULT 'medium',
  dedupe_window_minutes INTEGER NOT NULL DEFAULT 60,
  max_per_minute INTEGER NOT NULL DEFAULT 60,   -- flood cap; 0 = unlimited
  enabled INTEGER DEFAULT 1,
  last_received_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- dedupe_key is the heart of alert management: a repeated alert for the same
-- entity inside the source's dedupe window bumps occurrence_count instead of
-- creating another row, which is what stops a flapping check from opening
-- 400 incidents overnight.
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source_id TEXT,
  dedupe_key TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',  -- critical | high | medium | low | info
  status TEXT NOT NULL DEFAULT 'open',      -- open | acknowledged | resolved | suppressed
  entity TEXT,
  monitor_id TEXT,                          -- set when raised by an internal monitor
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT DEFAULT (datetime('now')),
  last_seen_at TEXT DEFAULT (datetime('now')),
  acknowledged_at TEXT,
  acknowledged_by TEXT,
  resolved_at TEXT,
  ticket_id TEXT,                           -- the incident this became, if any
  escalation_step INTEGER DEFAULT 0,        -- how far up oncall_escalation_steps we've paged
  raw_payload TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alerts_dedupe ON alerts(workspace_id, dedupe_key, status);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER DEFAULT 1,
  rule_order INTEGER NOT NULL DEFAULT 1,
  match_severity TEXT,   -- null = any
  match_source_id TEXT,
  match_title_contains TEXT,
  match_entity_contains TEXT,
  action_create_incident INTEGER DEFAULT 1,
  action_incident_priority TEXT,
  action_suppress INTEGER DEFAULT 0,
  action_notify_schedule_id TEXT,
  action_promote_major INTEGER DEFAULT 0,
  action_assignment_policy_id TEXT,
  stop_processing INTEGER DEFAULT 1,  -- first matching rule wins unless cleared
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  event TEXT NOT NULL,   -- received | deduped | suppressed | acknowledged | resolved | incident_created | escalated | rule_matched
  detail TEXT,
  actor_id TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (alert_id) REFERENCES alerts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alert_events_alert ON alert_events(alert_id, created_at DESC);

-- Alerts raised from our own data rather than an external tool. Evaluated on
-- the alertScheduler tick because nothing "reads" an SLA breach into
-- existence -- the same justification directorySyncScheduler.js documents
-- for being one of the few real background jobs in this app.
CREATE TABLE IF NOT EXISTS internal_alert_monitors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  monitor_type TEXT NOT NULL, -- sla_at_risk | sla_breached | unassigned_critical | queue_depth | reopen_rate
  threshold REAL NOT NULL DEFAULT 1,
  window_minutes INTEGER NOT NULL DEFAULT 60,
  severity TEXT NOT NULL DEFAULT 'high',
  enabled INTEGER DEFAULT 1,
  last_evaluated_at TEXT,
  last_triggered_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// Additive migrations for columns introduced after the initial tickets table
// (safe no-ops if the column already exists).
const ticketColumnMigrations = [
  // Change Management. change_state drives the ten-state lifecycle from the
  // flow diagram and is authoritative for a change; tickets.status is kept in
  // sync with its bucket by services/changeWorkflow.js so nothing that
  // queries status has to learn about change states.
  //
  // rollback_plan (added further down, for the original CAB feature) is the
  // backout plan -- not renamed, because business rules, the public API and
  // existing tickets all reference that column name already.
  "ALTER TABLE tickets ADD COLUMN change_type TEXT",              // standard | normal | emergency | expedite
  "ALTER TABLE tickets ADD COLUMN change_state TEXT",             // see CHANGE_STATES in services/changeWorkflow.js
  "ALTER TABLE tickets ADD COLUMN risk_score INTEGER",
  "ALTER TABLE tickets ADD COLUMN risk_band TEXT",                // low | medium | high | critical
  "ALTER TABLE tickets ADD COLUMN implementation_plan TEXT",
  "ALTER TABLE tickets ADD COLUMN test_plan TEXT",
  "ALTER TABLE tickets ADD COLUMN scheduled_start TEXT",
  "ALTER TABLE tickets ADD COLUMN scheduled_end TEXT",
  "ALTER TABLE tickets ADD COLUMN actual_start TEXT",
  "ALTER TABLE tickets ADD COLUMN actual_end TEXT",
  "ALTER TABLE tickets ADD COLUMN standard_template_id TEXT",
  "ALTER TABLE tickets ADD COLUMN freeze_override_reason TEXT",
  "ALTER TABLE tickets ADD COLUMN closure_approved_by TEXT",
  "ALTER TABLE tickets ADD COLUMN closure_approved_at TEXT",
  "ALTER TABLE tickets ADD COLUMN pir_required INTEGER DEFAULT 0",
  // Evidence captured during implementation is an attachment with a marker,
  // rather than a second attachment table with its own upload path.
  "ALTER TABLE attachments ADD COLUMN kind TEXT DEFAULT 'general'", // general | evidence
  // Group steps in an approval route need to know which step a row belongs
  // to and how many approvals that step still needs.
  "ALTER TABLE approvals ADD COLUMN approver_type TEXT",
  "ALTER TABLE approvals ADD COLUMN route_step_id TEXT",
  "ALTER TABLE approvals ADD COLUMN sla_due_at TEXT",
  "ALTER TABLE approvals ADD COLUMN sla_breached INTEGER DEFAULT 0",
  "ALTER TABLE approvals ADD COLUMN conditions TEXT",
  // Test mode lets an automation evaluate against real ticket events without
  // executing its actions — it logs what it would have done instead. Kept as
  // a column on automations itself (not a separate enabled-like flag) so an
  // automation is always in exactly one of: off / test / live.
  "ALTER TABLE automations ADD COLUMN test_mode INTEGER DEFAULT 0",
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
  "ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1",
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
  "ALTER TABLE groups ADD COLUMN workspace_id TEXT",
  // Business Rules engine: a rule can be gated by a condition on another
  // field's live value ("only apply when X = Y") and can carry a format
  // validation, on top of the original static visible/required flags.
  "ALTER TABLE ticket_field_rules ADD COLUMN condition_field TEXT",
  "ALTER TABLE ticket_field_rules ADD COLUMN condition_op TEXT", // equals | not_equals | contains | in
  "ALTER TABLE ticket_field_rules ADD COLUMN condition_value TEXT",
  "ALTER TABLE ticket_field_rules ADD COLUMN validation_type TEXT", // regex | min_length | max_length | number_range
  "ALTER TABLE ticket_field_rules ADD COLUMN validation_value TEXT",
  "ALTER TABLE ticket_field_rules ADD COLUMN validation_message TEXT",
  // Lifecycle engine: which named stage (lifecycle_stages.key) a ticket is
  // currently in, when its type has an enabled lifecycle configured. Null
  // for types with no lifecycle, and for legacy tickets created before one
  // was turned on -- those resolve their effective stage at read/transition
  // time by matching their current status to a stage bucket instead.
  "ALTER TABLE tickets ADD COLUMN lifecycle_stage TEXT",
  // Workflow graph editor: a branching node/edge graph (React Flow shape)
  // that supersedes the legacy flat trigger/conditions/actions columns as
  // the source of truth for execution. Those legacy columns are kept and
  // still written (derived from the graph) only because `actions` is
  // NOT NULL and relaxing that needs a full table rebuild -- see
  // deriveLegacyFromGraph() in automationEngine.js.
  "ALTER TABLE automations ADD COLUMN nodes TEXT",
  "ALTER TABLE automations ADD COLUMN edges TEXT",
  // Which graph node a gated (Tier C) pending action came from, so approving
  // it can resume the branch from that point instead of dead-ending.
  "ALTER TABLE automation_pending_actions ADD COLUMN node_id TEXT",
  // Lets an admin turn file attachments on/off (and optionally mandate one)
  // per catalog item, from the Service Catalog's own item editor -- rather
  // than a single blanket toggle for every request ticket.
  "ALTER TABLE catalog_items ADD COLUMN allow_attachments INTEGER DEFAULT 1",
  "ALTER TABLE catalog_items ADD COLUMN require_attachment INTEGER DEFAULT 0",
  // Spam moderation: flagged tickets stop showing in the default queue (see
  // GET /tickets) without being deleted -- reversible via unmark, and still
  // directly reachable by id for whoever flagged it.
  "ALTER TABLE tickets ADD COLUMN is_spam INTEGER DEFAULT 0",
  "ALTER TABLE tickets ADD COLUMN spam_marked_at TEXT",
  // Employee id and reporting manager -- like role/team, these describe a
  // person's standing *within this workspace* (the same physical user could
  // be a different employee id / report to a different manager in another
  // workspace), so they live on the membership row, not the global user.
  // manager_id points at another user's id, resolved to a name at read time.
  "ALTER TABLE workspace_members ADD COLUMN employee_id TEXT",
  "ALTER TABLE workspace_members ADD COLUMN manager_id TEXT",
  // Self-service profile preferences -- global on the user (not per-
  // workspace, unlike role/team/employee_id/manager above), since a
  // language/timezone/location preference describes the person, not their
  // standing in any particular workspace.
  "ALTER TABLE users ADD COLUMN language TEXT",
  "ALTER TABLE users ADD COLUMN location TEXT",
  "ALTER TABLE users ADD COLUMN timezone TEXT",
  // Tracks a comment pulled in from an external platform (ServiceNow journal
  // entry id, Jira comment id, etc.) so re-pulling the same ticket never
  // imports the same remote comment twice. Null for every comment written
  // natively in this app.
  "ALTER TABLE ticket_comments ADD COLUMN external_comment_id TEXT",
  // Ticket Merging: when a duplicate is merged into a primary ticket, it's
  // closed and stamped with which ticket absorbed it -- never hard-deleted,
  // so its own history/number stay intact and auditable.
  "ALTER TABLE tickets ADD COLUMN merged_into_id TEXT",
  // Custom Roles & Permissions: an agent's membership can optionally carry a
  // delegated permission set (e.g. "SLA Administrator") on top of their base
  // agent role, without promoting them to full admin. Null = base role only.
  "ALTER TABLE workspace_members ADD COLUMN custom_role_id TEXT",
  // Advanced Reporting: a saved report can be kept private to its author or
  // shared with the whole workspace, filed under a freeform folder label
  // (e.g. "SLA", "Agent Performance" -- ServiceNow-style report categories,
  // deliberately just a text column rather than a whole folders table since
  // nothing else needs to reference a folder besides grouping the list), and
  // remembers which chart type it was last viewed as.
  "ALTER TABLE saved_reports ADD COLUMN visibility TEXT DEFAULT 'shared'",
  "ALTER TABLE saved_reports ADD COLUMN folder TEXT",
  "ALTER TABLE saved_reports ADD COLUMN chart_type TEXT DEFAULT 'bar'",
  // Approval node type in the workflow graph editor: reuses the same
  // pending/resume table the Tier C action gate already relies on (see
  // automationEngine.js), distinguished by `kind` so decidePendingAction
  // knows whether to run a gated action (kind='action') or just record a
  // human decision and resume down the matching approved/rejected branch
  // (kind='approval'). `note` is the optional comment an approver can leave
  // when deciding, surfaced in the run log.
  "ALTER TABLE automation_pending_actions ADD COLUMN kind TEXT DEFAULT 'action'",
  "ALTER TABLE automation_pending_actions ADD COLUMN note TEXT",
  // ITIL-style RBAC: a group can grant its members a custom role's permission
  // bundle just by membership (see resolveEffectivePermissions in
  // services/permissions.js), and optionally names an informational manager
  // -- also reused as a new 'group_manager' approver option on catalog items
  // (see catalog_items.approver_type below).
  "ALTER TABLE groups ADD COLUMN default_custom_role_id TEXT",
  "ALTER TABLE groups ADD COLUMN manager_user_id TEXT",
  // Catalog items previously only supported approver_role (a base role).
  // approver_type widens that to also target a specific user or the item's
  // assignment group's manager, without dropping the existing column --
  // approver_role/approver_id are only read when relevant to the chosen type.
  "ALTER TABLE catalog_items ADD COLUMN approver_type TEXT DEFAULT 'role'", // role | user | group_manager
  "ALTER TABLE catalog_items ADD COLUMN approver_id TEXT",
  "ALTER TABLE catalog_items ADD COLUMN approver_group_id TEXT",
  // Reversible soft-delete for tickets (tickets.delete permission, itil_admin
  // persona) -- consistent with this app's existing "never hard-delete a
  // ticket" pattern (merge closes and stamps merged_into_id rather than
  // deleting). Deleted tickets are excluded from every normal list/report the
  // same way merged/spam tickets already are, and can be restored.
  "ALTER TABLE tickets ADD COLUMN deleted_at TEXT",
  // Lets a requester reopen their own resolved/closed incident, or cancel
  // their own still-open request, through dedicated endpoints rather than
  // the general PATCH (which stays locked to title/description for them).
  "ALTER TABLE tickets ADD COLUMN reopened_count INTEGER DEFAULT 0",
  // Directory Sync: which provider last synced this membership, and the
  // stable external key used to match it across syncs -- the DN for LDAP,
  // the object id for Graph. Email is NOT used as the reconciliation key
  // (it can change); a membership with no directory_provider_id is never
  // touched by a sync run, so manually-created and OAuth-SSO users are
  // completely unaffected. See services/directorySync.js.
  "ALTER TABLE workspace_members ADD COLUMN directory_provider_id TEXT",
  "ALTER TABLE workspace_members ADD COLUMN directory_external_id TEXT",
  "ALTER TABLE workspace_members ADD COLUMN directory_synced_at TEXT",
  // SLA policies upgrade: from 3 fixed fields (priority/category/team, each
  // an implicit AND, "most fields matched" wins) to a full condition builder
  // -- same {logic, rules:[{field,operator,value}]} shape and operator set
  // Business Rules already uses, so it's one condition language app-wide.
  // `sort_order` replaces "most specific wins" with an explicit, admin-
  // controlled evaluation order (first matching policy wins, like an ordered
  // rule list) -- the old priority/category/team columns are left in place,
  // untouched, purely as a fallback so a pre-existing policy that never got
  // real `conditions` saved still evaluates identically (see
  // resolveConditions() in services/sla.js) without a migration script.
  "ALTER TABLE sla_policies ADD COLUMN conditions TEXT",
  "ALTER TABLE sla_policies ADD COLUMN sort_order INTEGER DEFAULT 0",
  // Connect a real Microsoft 365/Outlook mailbox for sending AND receiving,
  // as an alternative to typing raw SMTP credentials -- reuses whichever
  // Microsoft app registration is already configured under Single Sign-On
  // (client_id/client_secret/tenant_id on that sso_providers row), just with
  // a wider delegated scope (Mail.Send, Mail.ReadWrite, offline_access)
  // requested through a separate consent screen, since a login flow has no
  // reason to ask for mail permissions. Tokens are encrypted at rest exactly
  // like every other stored secret (crypto.js). mailbox_provider being
  // 'smtp' (the default) means every column below is simply unused --
  // sendMail()/testEmailConfig() in emailService.js branch on it.
  "ALTER TABLE email_settings ADD COLUMN mailbox_provider TEXT DEFAULT 'smtp'",
  "ALTER TABLE email_settings ADD COLUMN graph_mailbox_email TEXT",
  "ALTER TABLE email_settings ADD COLUMN graph_access_token TEXT",
  "ALTER TABLE email_settings ADD COLUMN graph_refresh_token TEXT",
  "ALTER TABLE email_settings ADD COLUMN graph_token_expires_at TEXT",
  "ALTER TABLE email_settings ADD COLUMN graph_connected_by TEXT",
  // Inbound side of the same connected mailbox: "email this address, get a
  // ticket" -- off by default even once a mailbox is connected for sending,
  // since turning a real inbox into a ticket source is a bigger decision
  // than just wanting outbound mail to come from a real address.
  "ALTER TABLE email_settings ADD COLUMN inbound_enabled INTEGER DEFAULT 0",
  "ALTER TABLE email_settings ADD COLUMN inbound_default_type TEXT DEFAULT 'incident'",
  "ALTER TABLE email_settings ADD COLUMN inbound_last_synced_at TEXT",
  // MFA (TOTP): totp_secret is encrypted at rest exactly like every other
  // stored secret (crypto.js) and is written at /mfa/setup time before it's
  // actually active -- totp_enabled only flips to 1 once the user proves
  // they can generate a real code from it (POST /mfa/enable), so a secret
  // sitting unconfirmed never silently starts being required at login.
  "ALTER TABLE users ADD COLUMN totp_secret TEXT",
  "ALTER TABLE users ADD COLUMN totp_enabled INTEGER DEFAULT 0",
  "ALTER TABLE users ADD COLUMN totp_enrolled_at TEXT",
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
  'notifications', 'ticket_field_rules', 'attachments', 'groups', 'ticket_custom_fields', 'business_rules',
];
for (const table of tenantTables) {
  try {
    db.prepare(`UPDATE ${table} SET workspace_id = ? WHERE workspace_id IS NULL`).run(DEFAULT_WORKSPACE_ID);
  } catch {
    // ignore — table may be empty/not yet populated
  }
}

// ---- One-time migration: legacy ticket_field_rules -> business_rules ----
// Each old row (one field, one optional condition, visible/required flags)
// becomes an equivalent single-condition rule with show/hide + mandate
// actions, so nothing an admin already configured silently disappears when
// the new engine takes over. Guarded by a system flag row so it only ever runs once.
const legacyMigratedFlag = db.prepare('SELECT value FROM workspace_settings WHERE workspace_id = ? AND key = ?').get(SYSTEM_WS, 'business_rules_migrated_v1');
if (!legacyMigratedFlag) {
  const legacyRows = db.prepare('SELECT * FROM ticket_field_rules').all();
  for (const row of legacyRows) {
    const actions = [{ type: row.visible ? 'show_field' : 'hide_field', field: row.field_name }];
    if (row.required) actions.push({ type: 'mandate_field', field: row.field_name });
    const conditions = row.condition_field
      ? { logic: 'AND', rules: [{ field: row.condition_field, operator: row.condition_op || 'equals', value: row.condition_value || '' }] }
      : { logic: 'AND', rules: [] };
    db.prepare(
      'INSERT INTO business_rules (id, workspace_id, ticket_type, name, conditions, actions, priority, status) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      uid('brl'), row.workspace_id || DEFAULT_WORKSPACE_ID, row.ticket_type,
      `Migrated: ${row.field_name}`, JSON.stringify(conditions), JSON.stringify(actions), 100, 'active'
    );
  }
  db.prepare('INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value) VALUES (?,?,?)').run(SYSTEM_WS, 'business_rules_migrated_v1', '1');
}

// ---- Workflow graph backfill (idempotent, runs every boot -- not a
// once-only flag, because seed.js can insert legacy-shape automation rows
// at any point relative to a one-time flag) — any automation row still
// missing a graph gets one synthesized from its legacy trigger/conditions/
// actions columns. ----
{
  const legacyRows = db.prepare('SELECT * FROM automations WHERE nodes IS NULL').all();
  for (const row of legacyRows) {
    let trigger, conditions, actions;
    try {
      trigger = JSON.parse(row.trigger);
      conditions = JSON.parse(row.conditions || '[]');
      actions = JSON.parse(row.actions);
    } catch {
      continue;
    }
    const { nodes, edges } = legacyToGraph(trigger, conditions, actions);
    db.prepare('UPDATE automations SET nodes = ?, edges = ? WHERE id = ?').run(JSON.stringify(nodes), JSON.stringify(edges), row.id);
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
