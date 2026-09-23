import { db } from '../db.js';

// Delegable admin-configuration areas. A custom role grants some subset of
// these to an agent so they can manage a specific area (e.g. SLA policies)
// without being promoted to full admin. Anything not in this catalog --
// user/workspace management, AI provider credentials, procurement, HR case
// templates -- stays hard admin-only and can never be granted through a
// custom role, since those are either security-sensitive or financial.
//
// The four `*.manage`/`tickets.delete`/`users.impersonate` keys below are the
// ITIL-persona layer (itil_admin, incident/problem/change_manager,
// impersonator, knowledge_admin -- seeded as custom_roles in seed.js): each
// grants ONE new, real, additive capability that didn't previously have any
// gate (deleting a ticket, an admin-configured lifecycle transition scoped to
// one process, logging in as another user) -- none of them take anything
// away from the existing plain agent/admin split, so seeding these personas
// can't regress a currently-working capability for an existing user.
// `users.impersonate` is a deliberate, audited exception to the "stays hard
// admin-only" rule above -- impersonation is exactly the kind of thing a
// support-lead persona needs without being made a full admin, and every use
// of it is logged (see routes/auth.js's /impersonate route).
export const PERMISSIONS = [
  { key: 'sla.manage', group: 'Service Levels', label: 'Manage SLA policies & business hours' },
  { key: 'escalations.manage', group: 'Service Levels', label: 'Manage escalation rules' },
  // Operational routing. Delegable for the same reason SLA policies are: a
  // service-desk lead owning the rota and the alert pipeline is exactly the
  // person who should configure them, and none of these three can grant a
  // permission or reach a credential. Alert *sources* hold a webhook secret,
  // so that secret is write-only over the API (see routes/alerts.js).
  { key: 'alerts.manage', group: 'Operations', label: 'Manage alert sources, rules & monitors' },
  { key: 'oncall.manage', group: 'Operations', label: 'Manage on-call schedules, rotations & overrides' },
  { key: 'assignment.manage', group: 'Operations', label: 'Manage assignment policies & agent availability' },
  { key: 'automations.manage', group: 'Automation', label: 'Manage workflow automations' },
  { key: 'business_rules.manage', group: 'Automation', label: 'Manage business rules' },
  { key: 'lifecycles.manage', group: 'Automation', label: 'Manage ticket lifecycles & stages' },
  { key: 'catalog.manage', group: 'Service Catalog', label: 'Manage service catalog categories & items' },
  { key: 'custom_fields.manage', group: 'Service Catalog', label: 'Manage custom fields' },
  { key: 'groups.manage', group: 'People', label: 'Manage teams & group membership' },
  { key: 'notifications.manage', group: 'Communication', label: 'Manage email configuration, templates & notification templates' },
  { key: 'integrations.manage', group: 'Integrations', label: 'Manage integrations & external connections' },
  { key: 'ticket_numbering.manage', group: 'Workspace', label: 'Manage ticket number prefixes' },
  { key: 'audit_log.view', group: 'Compliance', label: 'View the audit log & export compliance reports' },
  { key: 'tickets.delete', group: 'Tickets', label: 'Delete (archive) tickets' },
  { key: 'ticket_categories.manage', group: 'Tickets', label: 'Manage ticket categories & subcategories' },
  { key: 'incident.manage', group: 'Tickets', label: 'Incident Manager — process ownership for incidents' },
  { key: 'problem.manage', group: 'Tickets', label: 'Problem Manager — process ownership for problems' },
  { key: 'change.manage', group: 'Tickets', label: 'Change Manager — process ownership, closure approval & change configuration' },
  { key: 'kb.manage', group: 'Knowledge', label: 'Author, publish & retire knowledge articles' },
  { key: 'users.impersonate', group: 'People', label: 'Log in as another user (audited)' },
];

const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key));

export function sanitizePermissions(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((k) => PERMISSION_KEYS.has(k)))];
}

export function resolvePermissions(customRoleId) {
  if (!customRoleId) return [];
  const row = db.prepare('SELECT permissions FROM custom_roles WHERE id = ?').get(customRoleId);
  if (!row) return [];
  try {
    return sanitizePermissions(JSON.parse(row.permissions));
  } catch {
    return [];
  }
}

// Effective permissions = the member's own delegated custom role UNION every
// group's default grant (groups.default_custom_role_id) for groups they
// belong to in this workspace -- this is what makes a group able to grant
// rights ("group_roles" in ServiceNow terms) without a second permission
// system: a group's default grant is just another custom_roles bundle,
// resolved and unioned in the same way a personal one already is.
export function resolveEffectivePermissions(userId, workspaceId, personalCustomRoleId) {
  const personal = resolvePermissions(personalCustomRoleId);
  const groupRoleIds = db.prepare(
    `SELECT DISTINCT g.default_custom_role_id AS id FROM group_members gm
     JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id = ? AND g.workspace_id = ? AND g.default_custom_role_id IS NOT NULL`
  ).all(userId, workspaceId).map((r) => r.id);
  const fromGroups = groupRoleIds.flatMap((id) => resolvePermissions(id));
  return sanitizePermissions([...personal, ...fromGroups]);
}
