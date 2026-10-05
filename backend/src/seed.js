import bcrypt from 'bcryptjs';
import { db, uid, DEFAULT_WORKSPACE_ID } from './db.js';
import { nextTicketNumber } from './services/ticketNumbering.js';
import { materializeTasks } from './services/hrCaseEngine.js';

const WS = DEFAULT_WORKSPACE_ID;

function upsertUser(name, email, password, role, team) {
  let user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (!user) {
    const id = uid('usr');
    const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    db.prepare('INSERT INTO users (id, name, email, password_hash, role, team, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?,?,?)').run(
      id, name, email, bcrypt.hashSync(password, 10), role, team || null, colors[Math.floor(Math.random() * colors.length)], WS
    );
    user = { id };
  }
  const membership = db.prepare('SELECT id FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(WS, user.id);
  if (!membership) {
    db.prepare('INSERT INTO workspace_members (id, workspace_id, user_id, role, team) VALUES (?,?,?,?,?)').run(uid('wm'), WS, user.id, role, team || null);
  }
  return user.id;
}

const adminId = upsertUser('Alex Admin', 'admin@itsm.ai', 'Admin@123', 'admin', 'Platform');
const agent1 = upsertUser('Priya Sharma', 'priya@itsm.ai', 'Agent@123', 'agent', 'Service Desk');
const agent2 = upsertUser('Diego Ruiz', 'diego@itsm.ai', 'Agent@123', 'agent', 'Network');
const req1 = upsertUser('Sam Requester', 'sam@company.com', 'User@123', 'requester', null);
const req2 = upsertUser('Jamie Requester', 'jamie@company.com', 'User@123', 'requester', null);

console.log('Seeded users:', { adminId, agent1, agent2, req1, req2 });

// ---- Groups (replace the old free-text "team" concept) ----
const groupCount = db.prepare('SELECT COUNT(*) c FROM groups WHERE workspace_id = ?').get(WS).c;
const groupIdByName = {};
if (groupCount === 0) {
  const groupDefs = [
    { name: 'Service Desk', description: 'First-line triage and general support', members: [agent1] },
    { name: 'Network', description: 'Networking, VPN and connectivity issues', members: [agent2] },
  ];
  for (const g of groupDefs) {
    const id = uid('grp');
    db.prepare('INSERT INTO groups (id, workspace_id, name, description) VALUES (?,?,?,?)').run(id, WS, g.name, g.description);
    groupIdByName[g.name] = id;
    for (const userId of g.members) {
      db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), id, userId);
    }
  }
  console.log(`Seeded ${groupDefs.length} groups.`);
}

const ticketCount = db.prepare('SELECT COUNT(*) c FROM tickets WHERE workspace_id = ?').get(WS).c;
if (ticketCount === 0) {
  const samples = [
    { title: 'VPN keeps disconnecting every 10 minutes', description: 'Since the update yesterday my VPN client drops constantly, blocking remote work.', type: 'incident', priority: 'high', category: 'Network', team: 'Network', requester_id: req1, assignee_id: agent2, status: 'in_progress' },
    { title: 'Need Adobe Photoshop license for new hire', description: 'New designer starting Monday needs a Photoshop seat.', type: 'request', priority: 'medium', category: 'Software', team: 'Service Desk', requester_id: req2, assignee_id: agent1, status: 'open' },
    { title: 'Laptop screen flickering', description: 'Screen flickers intermittently, especially on battery power.', type: 'incident', priority: 'medium', category: 'Hardware', team: 'Service Desk', requester_id: req1, assignee_id: agent1, status: 'open' },
    { title: 'Cannot access shared drive after password reset', description: 'Reset my password this morning and now the finance shared drive says access denied.', type: 'incident', priority: 'critical', category: 'Access & Identity', team: 'Service Desk', requester_id: req2, assignee_id: agent1, status: 'open' },
    { title: 'Request: provision new starter laptop', description: 'Onboarding for new engineer next week, needs standard dev laptop image.', type: 'request', priority: 'low', category: 'Hardware', team: 'Service Desk', requester_id: req1, assignee_id: agent2, status: 'resolved' },
    { title: 'Email delivery delayed by several hours', description: 'Multiple users reporting outbound email taking 3+ hours to deliver.', type: 'problem', priority: 'critical', category: 'Email', team: 'Network', requester_id: req2, assignee_id: agent2, status: 'in_progress' },
    { title: 'Change request: upgrade firewall firmware', description: 'Scheduled firmware upgrade for perimeter firewall to patch CVE.', type: 'change', priority: 'high', category: 'Security', team: 'Network', requester_id: adminId, assignee_id: agent2, status: 'open' },
    { title: 'Printer on 3rd floor offline', description: 'The HP printer near the kitchen shows offline for everyone.', type: 'incident', priority: 'low', category: 'Hardware', team: 'Service Desk', requester_id: req1, assignee_id: null, status: 'open' },
    { title: 'Slow performance in CRM application', description: 'CRM has been noticeably slow loading customer records since this morning.', type: 'incident', priority: 'high', category: 'Software', team: 'Service Desk', requester_id: req2, assignee_id: agent1, status: 'open' },
    { title: 'MFA prompts not appearing on login', description: 'Users report they are not being prompted for MFA on some devices, security concern.', type: 'incident', priority: 'critical', category: 'Security', team: 'Network', requester_id: req1, assignee_id: agent2, status: 'open' },
  ];
  const slaHours = { critical: 4, high: 8, medium: 24, low: 72 };
  for (const s of samples) {
    const id = uid('tkt');
    const number = nextTicketNumber(WS, s.type);
    const createdOffsetHours = Math.floor(Math.random() * 96);
    const created_at = new Date(Date.now() - createdOffsetHours * 3600 * 1000).toISOString();
    const sla_due_at = new Date(new Date(created_at).getTime() + (slaHours[s.priority] || 24) * 3600 * 1000).toISOString();
    db.prepare(
      `INSERT INTO tickets (id, workspace_id, number, type, title, description, status, priority, category, team, requester_id, assignee_id, sla_due_at, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, WS, number, s.type, s.title, s.description, s.status, s.priority, s.category, s.team, s.requester_id, s.assignee_id, sla_due_at, created_at, created_at);
    db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(uid('h'), id, 'created', 'Seed data');
  }
  console.log(`Seeded ${samples.length} tickets.`);
}

const assetCount = db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ?').get(WS).c;
if (assetCount === 0) {
  const assets = [
    { tag: 'LAP-1042', name: 'Dell Latitude 5440', type: 'hardware', status: 'in_use', owner_id: req1, vendor: 'Dell', location: 'HQ - 2F' },
    { tag: 'LAP-1043', name: 'MacBook Pro 14"', type: 'hardware', status: 'in_use', owner_id: req2, vendor: 'Apple', location: 'HQ - 3F' },
    { tag: 'LIC-3301', name: 'Adobe Creative Cloud (5 seats)', type: 'license', status: 'in_use', vendor: 'Adobe' },
    { tag: 'SRV-0007', name: 'Prod DB Server db-01', type: 'hardware', status: 'in_use', location: 'DC-East' },
    { tag: 'LAP-1050', name: 'Lenovo ThinkPad X1', type: 'hardware', status: 'in_stock', vendor: 'Lenovo', location: 'IT Storage' },
  ];
  for (const a of assets) {
    db.prepare(
      'INSERT INTO assets (id, workspace_id, tag, name, type, status, owner_id, vendor, location) VALUES (?,?,?,?,?,?,?,?,?)'
    ).run(uid('ast'), WS, a.tag, a.name, a.type, a.status, a.owner_id || null, a.vendor || null, a.location || null);
  }
  console.log(`Seeded ${assets.length} assets.`);
}

const kbCount = db.prepare('SELECT COUNT(*) c FROM kb_articles WHERE workspace_id = ?').get(WS).c;
if (kbCount === 0) {
  const articles = [
    { title: 'How to reset your VPN client', category: 'Network', body: 'Step 1: Quit the VPN client fully. Step 2: Clear cached profile in %APPDATA%/vpnclient. Step 3: Reinstall the latest client from the software portal. Step 4: Re-authenticate with MFA.', tags: 'vpn,network,remote' },
    { title: 'Requesting new software licenses', category: 'Software', body: 'Submit a Service Request under Software > License Request. Include the software name, version, and business justification. Approval SLA is 2 business days.', tags: 'software,license' },
    { title: 'Fixing shared drive access denied errors', category: 'Access & Identity', body: 'Access issues after a password reset usually resolve within 15 minutes as AD replication completes. If it persists, have IT re-sync your group membership.', tags: 'access,ad,password' },
  ];
  for (const a of articles) {
    db.prepare('INSERT INTO kb_articles (id, workspace_id, title, category, body, tags, author_id) VALUES (?,?,?,?,?,?,?)').run(
      uid('kb'), WS, a.title, a.category, a.body, a.tags, adminId
    );
  }
  console.log(`Seeded ${articles.length} KB articles.`);
}

const autoCount = db.prepare('SELECT COUNT(*) c FROM automations WHERE workspace_id = ?').get(WS).c;
if (autoCount === 0) {
  const workflows = [
    {
      name: 'Auto-categorize new tickets with AI',
      description: 'Runs AI classification the moment a ticket is created so nothing sits untriaged.',
      trigger: { event: 'ticket_created' },
      conditions: [],
      actions: [{ type: 'ai_categorize' }],
    },
    {
      name: 'Escalate critical incidents to Network team',
      description: 'Critical priority tickets in Network category get auto-assigned to the Network team and posted to Slack.',
      trigger: { event: 'ticket_created' },
      conditions: [{ field: 'priority', op: 'equals', value: 'critical' }],
      actions: [
        { type: 'assign_team', team: 'Network' },
        { type: 'notify_integration', integration_type: 'slack', message: 'New CRITICAL ticket needs attention' },
      ],
    },
    {
      name: 'Suggest AI resolution for reopened tickets',
      description: 'When a ticket status changes back to open, ask the AI assistant for a fresh resolution suggestion.',
      trigger: { event: 'ticket_updated' },
      conditions: [{ field: 'status', op: 'equals', value: 'open' }],
      actions: [{ type: 'ai_suggest_resolution' }],
    },
    {
      name: 'Auto-approve low-priority software requests',
      description: 'Low-priority Service Catalog software requests skip manual approval.',
      trigger: { event: 'ticket_created' },
      conditions: [{ field: 'type', op: 'equals', value: 'request' }, { field: 'priority', op: 'equals', value: 'low' }],
      actions: [{ type: 'auto_approve' }],
    },
  ];
  for (const w of workflows) {
    db.prepare('INSERT INTO automations (id, workspace_id, name, description, enabled, trigger, conditions, actions) VALUES (?,?,?,?,?,?,?,?)').run(
      uid('wf'), WS, w.name, w.description, 1, JSON.stringify(w.trigger), JSON.stringify(w.conditions), JSON.stringify(w.actions)
    );
  }
  console.log(`Seeded ${workflows.length} automations.`);
}

// ---- Employee Onboarding / Offboarding ----
// Guarded independently from the original Service Desk/Network groups block
// (which only ever runs once, before these existed) so this still seeds
// cleanly against an already-seeded workspace.
if (!db.prepare('SELECT id FROM groups WHERE workspace_id = ? AND name = ?').get(WS, 'IT')) {
  const hrGroupDefs = [
    { name: 'IT', description: 'Provisioning, access, and equipment for onboarding/offboarding', members: [agent1, agent2] },
    { name: 'HR', description: 'People operations, onboarding/offboarding paperwork and policy', members: [adminId] },
    { name: 'Facilities', description: 'Badges, seating, and equipment logistics', members: [agent1] },
  ];
  for (const g of hrGroupDefs) {
    const id = uid('grp');
    db.prepare('INSERT INTO groups (id, workspace_id, name, description) VALUES (?,?,?,?)').run(id, WS, g.name, g.description);
    for (const userId of g.members) {
      db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), id, userId);
    }
  }
  console.log(`Seeded ${hrGroupDefs.length} additional groups (IT/HR/Facilities).`);
}

function hrGroupId(name) {
  return db.prepare('SELECT id FROM groups WHERE workspace_id = ? AND name = ?').get(WS, name)?.id || null;
}

const hrTemplateCount = db.prepare('SELECT COUNT(*) c FROM hr_case_templates WHERE workspace_id = ?').get(WS).c;
if (hrTemplateCount === 0) {
  // Blueprint shape matches exactly what materializeTasks()/the AI drafter
  // produce: due_offset_days relative to start_date/last_working_day,
  // depends_on_index is a 0-based index into this same array.
  const onboardingBlueprint = [
    { title: 'Order laptop and standard peripherals', track: 'it', stage_key: 'pre_boarding', due_offset_days: -5, group_name: 'IT' },
    { title: 'Create email and SSO account', track: 'it', stage_key: 'pre_boarding', due_offset_days: -2, group_name: 'IT' },
    { title: 'Send offer paperwork and benefits enrollment', track: 'hr', stage_key: 'pre_boarding', due_offset_days: -7, group_name: 'HR' },
    { title: 'Prepare desk, badge, and building access', track: 'facilities', stage_key: 'pre_boarding', due_offset_days: -2, group_name: 'Facilities' },
    { title: 'Welcome meeting and office tour', track: 'manager', stage_key: 'day_one', due_offset_days: 0 },
    { title: 'IT orientation: tools, VPN, security policy', track: 'it', stage_key: 'day_one', due_offset_days: 0, group_name: 'IT' },
    { title: 'Assign onboarding buddy check-in', track: 'manager', stage_key: 'week_one', due_offset_days: 3 },
    { title: 'Complete required compliance training', track: 'hr', stage_key: 'week_one', due_offset_days: 5, group_name: 'HR' },
    { title: '30-day check-in with manager', track: 'manager', stage_key: 'thirty_sixty_ninety', due_offset_days: 30 },
    { title: '90-day performance review', track: 'manager', stage_key: 'thirty_sixty_ninety', due_offset_days: 90 },
  ];
  const offboardingBlueprint = [
    { title: 'Manager sign-off on departure', track: 'approval', stage_key: 'initiated', due_offset_days: -3, requires_decision: true },
    { title: 'Revoke SSO and email access', track: 'it', stage_key: 'access_revocation', due_offset_days: 0, group_name: 'IT', depends_on_index: 0 },
    { title: 'Revoke VPN and admin credentials', track: 'it', stage_key: 'access_revocation', due_offset_days: 0, group_name: 'IT', depends_on_index: 0 },
    { title: 'Disable building badge access', track: 'facilities', stage_key: 'access_revocation', due_offset_days: 0, group_name: 'Facilities', depends_on_index: 0 },
    { title: 'Collect laptop and equipment', track: 'it', stage_key: 'asset_return', due_offset_days: 1, group_name: 'IT' },
    { title: 'Process final pay and benefits paperwork', track: 'hr', stage_key: 'exit_interview', due_offset_days: 1, group_name: 'HR' },
    { title: 'Conduct exit interview', track: 'hr', stage_key: 'exit_interview', due_offset_days: 2, group_name: 'HR' },
  ];
  const resolveGroups = (blueprint) => blueprint.map(({ group_name, ...t }) => ({ ...t, group_id: group_name ? hrGroupId(group_name) : null }));

  db.prepare('INSERT INTO hr_case_templates (id, workspace_id, name, case_type, role_match, description, tasks) VALUES (?,?,?,?,?,?,?)').run(
    uid('hrt'), WS, 'Standard Employee Onboarding', 'onboarding', 'General',
    'Default cross-department checklist for a new full-time hire.', JSON.stringify(resolveGroups(onboardingBlueprint))
  );
  db.prepare('INSERT INTO hr_case_templates (id, workspace_id, name, case_type, role_match, description, tasks) VALUES (?,?,?,?,?,?,?)').run(
    uid('hrt'), WS, 'Standard Employee Offboarding', 'offboarding', 'General',
    'Default cross-department checklist for a departing employee.', JSON.stringify(resolveGroups(offboardingBlueprint))
  );
  console.log('Seeded 2 HR case templates (onboarding, offboarding).');
}

const hrCaseCount = db.prepare('SELECT COUNT(*) c FROM hr_cases WHERE workspace_id = ?').get(WS).c;
if (hrCaseCount === 0) {
  const onboardingTemplate = db.prepare('SELECT * FROM hr_case_templates WHERE workspace_id = ? AND case_type = ?').get(WS, 'onboarding');
  if (onboardingTemplate) {
    const caseId = uid('hrc');
    const startDate = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO hr_cases (id, workspace_id, case_type, employee_name, employee_email, job_title, department, employment_type, location, manager_id, start_date, template_id, created_by, stage)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(caseId, WS, 'onboarding', 'Jordan Lee', 'jordan.lee@itsm.ai', 'Software Engineer', 'Platform Engineering', 'full_time', 'HQ - 2F', adminId, startDate, onboardingTemplate.id, adminId, 'pre_boarding');
    const kase = db.prepare('SELECT * FROM hr_cases WHERE id = ?').get(caseId);
    materializeTasks(kase, JSON.parse(onboardingTemplate.tasks), 'template');
    console.log('Seeded 1 example onboarding case (Jordan Lee).');
  }
}

// ---- Service Catalog ----
const catCount = db.prepare('SELECT COUNT(*) c FROM catalog_categories WHERE workspace_id = ?').get(WS).c;
if (catCount === 0) {
  const hwCat = uid('cat');
  const swCat = uid('cat');
  const accCat = uid('cat');
  db.prepare('INSERT INTO catalog_categories (id, workspace_id, name, icon, sort_order) VALUES (?,?,?,?,?)').run(hwCat, WS, 'Hardware', 'Laptop', 1);
  db.prepare('INSERT INTO catalog_categories (id, workspace_id, name, icon, sort_order) VALUES (?,?,?,?,?)').run(swCat, WS, 'Software', 'AppWindow', 2);
  db.prepare('INSERT INTO catalog_categories (id, workspace_id, name, icon, sort_order) VALUES (?,?,?,?,?)').run(accCat, WS, 'Access', 'KeyRound', 3);

  const items = [
    {
      category_id: hwCat, name: 'New Laptop', description: 'Standard-issue laptop for a new hire or replacement.',
      form_schema: [{ key: 'reason', label: 'Reason', type: 'select', options: 'New hire,Replacement,Upgrade', required: true }, { key: 'notes', label: 'Additional notes', type: 'textarea', required: false }],
      approval_required: 1, approver_role: 'admin', default_priority: 'medium',
    },
    {
      category_id: swCat, name: 'Software License Request', description: 'Request a paid software license (Adobe, Office, etc).',
      form_schema: [{ key: 'software', label: 'Software name', type: 'text', required: true }, { key: 'justification', label: 'Business justification', type: 'textarea', required: true }],
      approval_required: 1, approver_role: 'admin', default_priority: 'low',
    },
    {
      category_id: accCat, name: 'VPN Access', description: 'Request remote VPN access for working off-site.',
      form_schema: [{ key: 'duration', label: 'Access duration', type: 'select', options: '30 days,90 days,Permanent', required: true }],
      approval_required: 1, approver_role: 'admin', default_priority: 'medium',
    },
    {
      category_id: accCat, name: 'Password Reset', description: 'Reset your account password immediately — no approval needed.',
      form_schema: [{ key: 'account', label: 'Which account', type: 'text', required: true }],
      approval_required: 0, approver_role: 'admin', default_priority: 'high',
    },
  ];
  for (const it of items) {
    db.prepare(
      `INSERT INTO catalog_items (id, workspace_id, category_id, name, description, form_schema, approval_required, approver_role, default_priority)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(uid('itm'), WS, it.category_id, it.name, it.description, JSON.stringify(it.form_schema), it.approval_required, it.approver_role, it.default_priority);
  }
  console.log(`Seeded 3 catalog categories and ${items.length} catalog items.`);
}

// ---- SLA policies ----
const slaCount = db.prepare('SELECT COUNT(*) c FROM sla_policies WHERE workspace_id = ?').get(WS).c;
if (slaCount === 0) {
  const policies = [
    { name: 'Critical incidents', priority: 'critical', response_minutes: 15, resolution_minutes: 240 },
    { name: 'High priority', priority: 'high', response_minutes: 30, resolution_minutes: 480 },
    { name: 'Standard requests', priority: 'medium', response_minutes: 60, resolution_minutes: 1440 },
    { name: 'Low priority', priority: 'low', response_minutes: 240, resolution_minutes: 4320 },
  ];
  for (const p of policies) {
    db.prepare('INSERT INTO sla_policies (id, workspace_id, name, priority, response_minutes, resolution_minutes) VALUES (?,?,?,?,?,?)').run(
      uid('sla'), WS, p.name, p.priority, p.response_minutes, p.resolution_minutes
    );
  }
  db.prepare('DELETE FROM business_hours WHERE workspace_id = ?').run(WS);
  for (let d = 1; d <= 5; d += 1) {
    db.prepare('INSERT INTO business_hours (id, workspace_id, day_of_week, start_time, end_time) VALUES (?,?,?,?,?)').run(uid('bh'), WS, d, '09:00', '17:00');
  }
  console.log(`Seeded ${policies.length} SLA policies and Mon–Fri 9-5 business hours.`);
}

// ---- Contracts & Purchase Orders ----
const contractCount = db.prepare('SELECT COUNT(*) c FROM contracts WHERE workspace_id = ?').get(WS).c;
if (contractCount === 0) {
  db.prepare('INSERT INTO contracts (id, workspace_id, vendor, name, type, start_date, end_date, value, renewal_notice_days) VALUES (?,?,?,?,?,?,?,?,?)').run(
    uid('ctr'), WS, 'Microsoft', 'Microsoft 365 E3 (50 seats)', 'license', '2025-09-01', '2026-08-31', 24000, 45
  );
  db.prepare('INSERT INTO contracts (id, workspace_id, vendor, name, type, start_date, end_date, value, renewal_notice_days) VALUES (?,?,?,?,?,?,?,?,?)').run(
    uid('ctr'), WS, 'Dell', 'Dell ProSupport Plus', 'support', '2025-01-01', '2026-12-31', 8000, 30
  );
  db.prepare('INSERT INTO purchase_orders (id, workspace_id, po_number, vendor, item, amount, status, ordered_date) VALUES (?,?,?,?,?,?,?,?)').run(
    uid('po'), WS, 'PO-1001', 'Lenovo', '10x ThinkPad X1 Carbon', 18500, 'ordered', '2026-07-20'
  );
  console.log('Seeded 2 contracts and 1 purchase order.');
}

// ---- Notification templates ----
const tplCount = db.prepare('SELECT COUNT(*) c FROM notification_templates WHERE workspace_id = ?').get(WS).c;
if (tplCount === 0) {
  const templates = [
    { event: 'ticket_created', channel: 'in_app', subject: 'New ticket', body: 'Ticket {{number}} was created: {{title}}' },
    { event: 'ticket_assigned', channel: 'in_app', subject: 'Ticket assigned', body: 'Ticket {{number}} was assigned to you: {{title}}' },
    { event: 'approval_requested', channel: 'in_app', subject: 'Approval needed', body: '{{number}} needs your approval: {{title}}' },
    { event: 'ticket_resolved', channel: 'in_app', subject: 'Ticket resolved', body: 'Your ticket {{number}} was resolved. Let us know how we did!' },
    { event: 'change_approved', channel: 'in_app', subject: 'Request approved', body: '{{number}} — {{title}} was approved.' },
    { event: 'change_rejected', channel: 'in_app', subject: 'Request rejected', body: '{{number}} — {{title}} was rejected.' },
  ];
  for (const t of templates) {
    db.prepare('INSERT INTO notification_templates (id, workspace_id, event, channel, subject, body) VALUES (?,?,?,?,?,?)').run(uid('tpl'), WS, t.event, t.channel, t.subject, t.body);
  }
  console.log(`Seeded ${templates.length} notification templates.`);
}

// ---- ITIL-style personas (seeded as custom_roles bundles -- see
// services/permissions.js for why this reuses the existing delegation
// system instead of a parallel role/containment schema) ----
function upsertCustomRole(name, description, permissions) {
  let row = db.prepare('SELECT id FROM custom_roles WHERE workspace_id = ? AND name = ?').get(WS, name);
  if (!row) {
    const id = uid('crole');
    db.prepare('INSERT INTO custom_roles (id, workspace_id, name, description, permissions) VALUES (?,?,?,?,?)').run(
      id, WS, name, description, JSON.stringify(permissions)
    );
    row = { id };
  }
  return row.id;
}

const roleId = {
  itil: upsertCustomRole('ITIL', 'Equivalent to the base Agent role — full ticket CRUD across incidents, requests, problems and changes, can be assigned work. No extra delegated permissions beyond what every agent already has; exists as a named persona for org-chart clarity.', []),
  itilAdmin: upsertCustomRole('ITIL Admin', 'ITIL + delete (archive) tickets, manage the Service Catalog, and manage SLA policies.', ['tickets.delete', 'catalog.manage', 'sla.manage']),
  incidentManager: upsertCustomRole('Incident Manager', 'Process ownership for Incidents — can act on an admin-gated Incident lifecycle transition without needing full admin.', ['incident.manage']),
  problemManager: upsertCustomRole('Problem Manager', 'Process ownership for Problems.', ['problem.manage']),
  changeManager: upsertCustomRole('Change Manager', 'Process ownership for Changes — can act as CAB on the admin-gated cab_review → scheduled transition without needing full admin.', ['change.manage']),
  knowledgeManager: upsertCustomRole('Knowledge Manager', 'Author, publish and retire Knowledge Base articles. (One KB permission tier in this app, covering both "knowledge" and "knowledge_admin" from the original ITIL role list.)', ['kb.manage']),
  catalogAdmin: upsertCustomRole('Catalog Admin', 'Manage Service Catalog categories, items and their guided request forms.', ['catalog.manage']),
  impersonator: upsertCustomRole('Impersonator', 'Can log in as another user for support/testing purposes. Every use is audit-logged.', ['users.impersonate']),
};
console.log('Seeded 8 ITIL-persona custom roles.');

// One sample agent per persona, matching this file's existing upsertUser
// pattern — all base role 'agent' (personas layer ON TOP of agent, they
// don't replace it), each with their custom_role_id set directly.
const personaUsers = [
  { name: 'Morgan Itil', email: 'morgan.itil@itsm.ai', role: roleId.itil, team: 'Service Desk' },
  { name: 'Riley ItilAdmin', email: 'riley.itiladmin@itsm.ai', role: roleId.itilAdmin, team: 'Service Desk' },
  { name: 'Casey IncidentMgr', email: 'casey.incidentmgr@itsm.ai', role: roleId.incidentManager, team: 'Service Desk' },
  { name: 'Drew ProblemMgr', email: 'drew.problemmgr@itsm.ai', role: roleId.problemManager, team: 'Service Desk' },
  { name: 'Taylor ChangeMgr', email: 'taylor.changemgr@itsm.ai', role: roleId.changeManager, team: 'Network' },
  { name: 'Jordan Knowledge', email: 'jordan.knowledge@itsm.ai', role: roleId.knowledgeManager, team: 'Service Desk' },
  { name: 'Avery CatalogAdmin', email: 'avery.catalogadmin@itsm.ai', role: roleId.catalogAdmin, team: 'Service Desk' },
  { name: 'Quinn Impersonator', email: 'quinn.impersonator@itsm.ai', role: roleId.impersonator, team: 'Service Desk' },
];
for (const p of personaUsers) {
  const userId = upsertUser(p.name, p.email, 'Persona@123', 'agent', p.team);
  db.prepare('UPDATE workspace_members SET custom_role_id = ? WHERE workspace_id = ? AND user_id = ?').run(p.role, WS, userId);
}
console.log(`Seeded ${personaUsers.length} persona sample users (password: Persona@123).`);

// One sample approver persona -- no custom role needed (approvals.js already
// scopes /decide to whoever is actually assigned via approver_id/
// approver_role, for any base role), demonstrated by making this user the
// CAB group's manager below so a "group_manager"-type catalog item has a
// real approver to resolve to.
const morganApprover = upsertUser('Morgan Approver', 'morgan.approver@itsm.ai', 'Persona@123', 'agent', 'Network');

// CAB group: demonstrates a group granting rights by membership
// (default_custom_role_id — every member gets Change Manager's bundle just
// by being in this group, without a personal custom_role_id) and naming a
// manager (manager_user_id — reused as the 'group_manager' approver option
// on catalog items, see routes/catalog.js's resolveApprover()).
let cabGroup = db.prepare('SELECT id FROM groups WHERE workspace_id = ? AND name = ?').get(WS, 'Change Advisory Board');
if (!cabGroup) {
  const id = uid('grp');
  db.prepare('INSERT INTO groups (id, workspace_id, name, description, manager_user_id, default_custom_role_id) VALUES (?,?,?,?,?,?)').run(
    id, WS, 'Change Advisory Board', 'Reviews and approves changes before they can be scheduled.', morganApprover, roleId.changeManager
  );
  db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), id, morganApprover);
  db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), id, agent2);
  cabGroup = { id };
  console.log('Seeded Change Advisory Board group (grants Change Manager to its members; manager = Morgan Approver).');
}

console.log('\nSeed complete. Login with:');
console.log('  admin@itsm.ai / Admin@123 (admin)');
console.log('  priya@itsm.ai / Agent@123 (agent)');
console.log('  sam@company.com / User@123 (requester)');
console.log('  ITIL personas (all password Persona@123): morgan.itil@itsm.ai, riley.itiladmin@itsm.ai,');
console.log('    casey.incidentmgr@itsm.ai, drew.problemmgr@itsm.ai, taylor.changemgr@itsm.ai,');
console.log('    jordan.knowledge@itsm.ai, avery.catalogadmin@itsm.ai, quinn.impersonator@itsm.ai,');
console.log('    morgan.approver@itsm.ai (CAB group manager, gets Change Manager via group membership)');
