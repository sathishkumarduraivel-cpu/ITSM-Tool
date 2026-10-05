// Standard change templates -- the flow diagram's Standard branch.
//
// A Standard change is only standard if it actually matches a pre-approved
// recipe. Match, and it auto-approves and inherits the template's plans;
// miss, and the diagram is explicit about the fallback: "Route as Normal
// Change". That fallback is the safety property here, so it is the caller's
// only option when matchTemplate returns null.
import { db, uid } from '../db.js';

const DEFAULTS = [
  {
    name: 'Standard laptop replacement',
    description: 'Like-for-like replacement of a user laptop from stock.',
    match_category: 'Hardware',
    match_subcategory: 'Laptop',
    implementation_plan: '1. Image the replacement from the current build.\n2. Migrate the user profile and verify data.\n3. Swap the device and confirm the user can sign in.\n4. Wipe and return the old unit to stock.',
    backout_plan: 'Return the original device to the user; it is retained un-wiped until they confirm.',
    test_plan: 'User signs in, reaches email and the company drive.',
    default_risk_band: 'low',
    max_duration_minutes: 120,
  },
  {
    name: 'Approved software install',
    description: 'Install a package already on the approved software list.',
    match_category: 'Software',
    match_subcategory: 'Installation',
    implementation_plan: '1. Confirm the package is on the approved list and a licence is free.\n2. Deploy through the management tool.\n3. Verify the application launches for the user.',
    backout_plan: 'Uninstall through the same management tool and release the licence.',
    test_plan: 'Application launches and authenticates.',
    default_risk_band: 'low',
    max_duration_minutes: 60,
  },
  {
    name: 'Password policy group membership',
    description: 'Add or remove a user from a pre-approved access group.',
    match_category: 'Access & Identity',
    match_subcategory: 'Permissions change',
    implementation_plan: '1. Confirm the request carries line-manager approval.\n2. Apply the group membership change.\n3. Confirm effective access with the user.',
    backout_plan: 'Revert the group membership to its prior state.',
    test_plan: 'User confirms they can (or can no longer) reach the resource.',
    default_risk_band: 'low',
    max_duration_minutes: 30,
  },
];

export function ensureDefaultTemplates(workspaceId) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM standard_change_templates WHERE workspace_id = ?').get(workspaceId);
  if (c > 0) return;
  for (const t of DEFAULTS) {
    db.prepare(
      `INSERT INTO standard_change_templates (id, workspace_id, name, description, match_category, match_subcategory,
         implementation_plan, backout_plan, test_plan, default_risk_band, max_duration_minutes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      uid('sct'), workspaceId, t.name, t.description, t.match_category, t.match_subcategory,
      t.implementation_plan, t.backout_plan, t.test_plan, t.default_risk_band, t.max_duration_minutes
    );
  }
}

export function listTemplates(workspaceId, { includeDisabled = false } = {}) {
  ensureDefaultTemplates(workspaceId);
  return db.prepare(
    `SELECT * FROM standard_change_templates WHERE workspace_id = ?${includeDisabled ? '' : ' AND enabled = 1'}
     ORDER BY name ASC`
  ).all(workspaceId);
}

// Most-specific-wins, the same scoring shape as findSlaPolicy and
// findAssignmentPolicy: every criterion a template declares AND that agrees
// scores a point, and the template matching on the most criteria wins. A
// template that declares nothing matches everything and is the weakest
// possible match, which is the right precedence for a catch-all.
//
// Subcategory is multi-value on a ticket (a comma-separated list -- see
// ticketCategories.js), so a template's single match_subcategory is
// satisfied if it appears anywhere in that list.
export function matchTemplate(workspaceId, ticket) {
  const templates = listTemplates(workspaceId);
  const subcategories = String(ticket.subcategory || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const title = String(ticket.title || '').toLowerCase();

  let best = null;
  let bestScore = -1;
  for (const t of templates) {
    let score = 0;

    if (t.match_category) {
      if (String(t.match_category).toLowerCase() !== String(ticket.category || '').toLowerCase()) continue;
      score += 1;
    }
    if (t.match_subcategory) {
      if (!subcategories.includes(String(t.match_subcategory).toLowerCase())) continue;
      score += 1;
    }
    if (t.match_title_contains) {
      if (!title.includes(String(t.match_title_contains).toLowerCase())) continue;
      score += 1;
    }
    if (t.match_asset_type) {
      const types = db.prepare(
        `SELECT DISTINCT a.type FROM ticket_assets ta JOIN assets a ON a.id = ta.asset_id WHERE ta.ticket_id = ?`
      ).all(ticket.id).map((r) => String(r.type || '').toLowerCase());
      if (!types.includes(String(t.match_asset_type).toLowerCase())) continue;
      score += 1;
    }

    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

// Applies a matched template's plans to a change, filling only what the
// requester left blank -- their own implementation notes are more specific
// than a generic recipe and must not be overwritten.
export function applyTemplate(workspaceId, ticket, template) {
  const sets = ['standard_template_id = ?'];
  const params = [template.id];

  if (!String(ticket.implementation_plan || '').trim() && template.implementation_plan) {
    sets.push('implementation_plan = ?'); params.push(template.implementation_plan);
  }
  if (!String(ticket.rollback_plan || '').trim() && template.backout_plan) {
    sets.push('rollback_plan = ?'); params.push(template.backout_plan);
  }
  if (!String(ticket.test_plan || '').trim() && template.test_plan) {
    sets.push('test_plan = ?'); params.push(template.test_plan);
  }

  sets.push("updated_at = datetime('now')");
  db.prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = ?`).run(...params, ticket.id);
  db.prepare('UPDATE standard_change_templates SET usage_count = usage_count + 1 WHERE id = ?').run(template.id);

  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'updated', `Matched standard change template "${template.name}"`
  );
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(ticket.id);
}
