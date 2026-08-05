import bcrypt from 'bcryptjs';
import { db, uid, DEFAULT_WORKSPACE_ID } from './db.js';
import { nextTicketNumber } from './services/ticketNumbering.js';

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

console.log('\nSeed complete. Login with:');
console.log('  admin@itsm.ai / Admin@123 (admin)');
console.log('  priya@itsm.ai / Agent@123 (agent)');
console.log('  sam@company.com / User@123 (requester)');
