// The seed catalog for email_templates -- one row per lifecycle event this
// app actually sends mail for (see the sendTemplatedEmail() call sites in
// routes/tickets.js, routes/catalog.js, routes/approvals.js,
// services/approvalEngine.js, services/escalationEngine.js and
// services/directorySync.js). Kept as a static list rather than only living
// in seed.js so services/emailService.js's ensureDefaultTemplates() can
// lazily backfill any workspace -- old or brand new -- the first time it's
// needed, the same "self-healing at read/write time" philosophy already
// used for SLA legacy synthesis and lifecycle stage sync elsewhere in this
// codebase.
//
// `variables` drives two things in the UI: the clickable variable-insert
// palette in the template editor, and the sample data used by "Preview" and
// "Send test" so an admin can see real-looking output without waiting for a
// real ticket to hit that code path.

const WRAPPER_NOTE = 'The workspace footer (configured in Email Settings) is appended automatically below this content — do not repeat a signature here.';

export const DEFAULT_EMAIL_TEMPLATES = [
  {
    key: 'ticket_created',
    name: 'Ticket Created — Confirmation',
    audience: 'requester',
    category: 'Ticket Lifecycle',
    subject: "We've received your request — {{ticket.number}}",
    body_html: `<p>Hi {{requester.name}},</p><p>Thanks for reaching out. We've logged your request as <strong>{{ticket.number}} — {{ticket.title}}</strong> and a member of our team will pick it up shortly.</p><p><a href="{{ticket.link}}">View your ticket</a></p>`,
    variables: ['requester.name', 'ticket.number', 'ticket.title', 'ticket.priority', 'ticket.link'],
  },
  {
    key: 'ticket_assigned',
    name: 'Ticket Assigned To You',
    audience: 'agent',
    category: 'Ticket Lifecycle',
    subject: '[{{ticket.number}}] Assigned to you — {{ticket.title}}',
    body_html: `<p>Hi {{agent.name}},</p><p><strong>{{ticket.number}} — {{ticket.title}}</strong> (priority: {{ticket.priority}}) has just been assigned to you.</p><p><a href="{{ticket.link}}">Open the ticket</a></p>`,
    variables: ['agent.name', 'ticket.number', 'ticket.title', 'ticket.priority', 'ticket.link'],
  },
  {
    key: 'ticket_comment_reply',
    name: 'New Reply From an Agent',
    audience: 'requester',
    category: 'Ticket Lifecycle',
    subject: 'Re: [{{ticket.number}}] {{ticket.title}}',
    body_html: `<p>Hi {{requester.name}},</p><p><strong>{{agent.name}}</strong> just replied to your ticket <strong>{{ticket.number}}</strong>:</p><blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #cbd5e1;color:#475569;background:#f8fafc;">{{comment.body}}</blockquote><p><a href="{{ticket.link}}">View and reply</a></p>`,
    variables: ['requester.name', 'agent.name', 'ticket.number', 'ticket.title', 'comment.body', 'ticket.link'],
  },
  {
    key: 'ticket_resolved',
    name: 'Ticket Resolved',
    audience: 'requester',
    category: 'Ticket Lifecycle',
    subject: 'Resolved — {{ticket.number}} {{ticket.title}}',
    body_html: `<p>Hi {{requester.name}},</p><p>Good news — <strong>{{ticket.number}} — {{ticket.title}}</strong> has been marked resolved. Let us know if this didn't fully address the issue.</p><p><a href="{{ticket.link}}">View the ticket</a></p>`,
    variables: ['requester.name', 'ticket.number', 'ticket.title', 'ticket.link'],
  },
  {
    key: 'ticket_closed',
    name: 'Ticket Closed',
    audience: 'requester',
    category: 'Ticket Lifecycle',
    subject: 'Closed — {{ticket.number}} {{ticket.title}}',
    body_html: `<p>Hi {{requester.name}},</p><p><strong>{{ticket.number}} — {{ticket.title}}</strong> has been closed. If you need anything further, just reply to reopen the conversation or open a new ticket.</p><p><a href="{{ticket.link}}">View the ticket</a></p>`,
    variables: ['requester.name', 'ticket.number', 'ticket.title', 'ticket.link'],
  },
  {
    key: 'approval_requested',
    name: 'Approval Requested',
    audience: 'approver',
    category: 'Approvals',
    subject: 'Approval needed — {{ticket.number}} {{ticket.title}}',
    body_html: `<p>Hi {{approver.name}},</p><p><strong>{{requester.name}}</strong> has requested <strong>{{ticket.title}}</strong> ({{ticket.number}}), which needs your approval before it can proceed.</p><p><a href="{{ticket.link}}">Review and decide</a></p>`,
    variables: ['approver.name', 'requester.name', 'ticket.number', 'ticket.title', 'ticket.link'],
  },
  {
    key: 'cab_approval_requested',
    name: 'CAB Approval Requested',
    audience: 'approver',
    category: 'Approvals',
    subject: 'CAB review needed — {{ticket.number}} {{ticket.title}}',
    body_html: `<p>Hi {{approver.name}},</p><p>A change is awaiting Change Advisory Board review: <strong>{{ticket.number}} — {{ticket.title}}</strong>, requested by {{requester.name}}.</p><p><a href="{{ticket.link}}">Review this change</a></p>`,
    variables: ['approver.name', 'requester.name', 'ticket.number', 'ticket.title', 'ticket.link'],
  },
  {
    key: 'approval_approved',
    name: 'Request Approved',
    audience: 'requester',
    category: 'Approvals',
    subject: 'Approved — {{ticket.number}} {{ticket.title}}',
    body_html: `<p>Hi {{requester.name}},</p><p>Your request <strong>{{ticket.number}} — {{ticket.title}}</strong> has been approved and is moving forward.</p><p><a href="{{ticket.link}}">View the ticket</a></p>`,
    variables: ['requester.name', 'ticket.number', 'ticket.title', 'ticket.link'],
  },
  {
    key: 'approval_rejected',
    name: 'Request Rejected',
    audience: 'requester',
    category: 'Approvals',
    subject: 'Rejected — {{ticket.number}} {{ticket.title}}',
    body_html: `<p>Hi {{requester.name}},</p><p>Unfortunately <strong>{{ticket.number}} — {{ticket.title}}</strong> was not approved.</p><blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #fca5a5;color:#7f1d1d;background:#fef2f2;">{{comment.body}}</blockquote><p><a href="{{ticket.link}}">View the ticket</a></p>`,
    variables: ['requester.name', 'ticket.number', 'ticket.title', 'comment.body', 'ticket.link'],
  },
  {
    key: 'task_assigned',
    name: 'Task Assigned To You',
    audience: 'agent',
    category: 'Tasks',
    subject: 'New task on {{ticket.number}}: {{task.title}}',
    body_html: `<p>Hi {{agent.name}},</p><p>You've been assigned a task on <strong>{{ticket.number}} — {{ticket.title}}</strong>:</p><p style="padding:10px 14px;border-left:3px solid #a5b4fc;background:#eef2ff;">{{task.title}}</p><p><a href="{{ticket.link}}">Open the ticket</a></p>`,
    variables: ['agent.name', 'ticket.number', 'ticket.title', 'task.title', 'ticket.link'],
  },
  {
    key: 'escalation_alert',
    name: 'SLA Escalation Alert',
    audience: 'agent',
    category: 'SLA & Escalation',
    subject: 'Escalation: {{ticket.number}} — {{escalation.detail}}',
    body_html: `<p>Hi {{agent.name}},</p><p><strong>{{ticket.number}} — {{ticket.title}}</strong> (priority: {{ticket.priority}}) has reached escalation level {{escalation.level}}.</p><p>{{escalation.detail}}</p><p><a href="{{ticket.link}}">Open the ticket</a></p>`,
    variables: ['agent.name', 'ticket.number', 'ticket.title', 'ticket.priority', 'escalation.level', 'escalation.detail', 'ticket.link'],
  },
  {
    key: 'directory_sync_failed',
    name: 'Directory Sync Failed',
    audience: 'admin',
    category: 'Directory & Admin',
    subject: 'Directory sync failed — {{provider.name}}',
    body_html: `<p>Hi {{admin.name}},</p><p>A sync run against directory provider <strong>{{provider.name}}</strong> failed:</p><blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #fca5a5;color:#7f1d1d;background:#fef2f2;">{{error.message}}</blockquote><p>Open Admin Settings → Directory Sync to review the connection.</p>`,
    variables: ['admin.name', 'provider.name', 'error.message'],
  },
];

export const SAMPLE_VARS = {
  'ticket.number': 'INC-1042', 'ticket.title': 'VPN drops every few minutes', 'ticket.priority': 'high',
  'ticket.link': 'https://your-workspace.example/tickets/tkt_sample',
  'requester.name': 'Jordan Lee', 'agent.name': 'Avery Chen', 'approver.name': 'Morgan Blake', 'admin.name': 'Alex Admin',
  'comment.body': "I've restarted the VPN client and updated the driver — please let us know if it drops again.",
  'task.title': 'Provision replacement laptop',
  'escalation.level': '2', 'escalation.detail': 'Escalation level 2 (75% of SLA elapsed) — priority raised to critical',
  'provider.name': 'Corporate Active Directory', 'error.message': 'Connection timed out after 10s (ldap://dc01.corp.local:389)',
};

export function findTemplateDefault(key) {
  return DEFAULT_EMAIL_TEMPLATES.find((t) => t.key === key) || null;
}
