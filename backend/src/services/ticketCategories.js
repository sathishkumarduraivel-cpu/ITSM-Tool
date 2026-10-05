// The ticket category/subcategory taxonomy.
//
// Before this existed, `category` was a free-text input in the ticket view
// while services/aiClient.js's categorizeTicket() carried its own hardcoded
// list in its prompt -- so the AI would confidently tag a ticket "Access &
// Identity" while an agent typed "access", and reporting split the two.
// There is now one source of truth, and both read from it.
import { db, uid } from '../db.js';

// The default set is deliberately the same vocabulary categorizeTicket() was
// already using, so turning this on does not reclassify existing tickets or
// change what the AI produces -- it just makes the list editable and makes
// everything agree on it.
const DEFAULT_TAXONOMY = [
  ['Hardware', ['Laptop', 'Desktop', 'Monitor', 'Printer', 'Mobile device', 'Peripherals']],
  ['Software', ['Installation', 'Licensing', 'Bug or error', 'Update or patch', 'Performance']],
  ['Network', ['Wi-Fi', 'VPN', 'LAN or cabling', 'Firewall', 'DNS', 'Internet outage']],
  ['Access & Identity', ['Password reset', 'Account lockout', 'New account', 'Permissions change', 'MFA', 'Offboarding']],
  ['Email', ['Mailbox access', 'Distribution list', 'Spam or phishing', 'Storage quota', 'Calendar']],
  ['Facilities', ['Desk or seating', 'Meeting room', 'Access card', 'Power', 'Air conditioning']],
  ['HR', ['Onboarding', 'Offboarding', 'Payroll', 'Leave', 'Policy question']],
  ['Security', ['Suspected breach', 'Malware', 'Phishing report', 'Data loss', 'Vulnerability']],
  ['Other', ['Uncategorised']],
];

// Lazily materialized per workspace, like emailService.js's
// ensureDefaultTemplates -- called at the top of every read below, so a
// workspace that predates this feature is filled in on first use rather than
// needing a migration.
export function ensureDefaultTaxonomy(workspaceId) {
  const { c } = db.prepare('SELECT COUNT(*) c FROM ticket_categories WHERE workspace_id = ?').get(workspaceId);
  if (c > 0) return;

  DEFAULT_TAXONOMY.forEach(([name, subs], i) => {
    const categoryId = uid('tcat');
    db.prepare('INSERT INTO ticket_categories (id, workspace_id, name, sort_order) VALUES (?,?,?,?)').run(
      categoryId, workspaceId, name, i
    );
    subs.forEach((sub, j) => {
      db.prepare('INSERT INTO ticket_subcategories (id, category_id, name, sort_order) VALUES (?,?,?,?)').run(
        uid('tsub'), categoryId, sub, j
      );
    });
  });
}

export function listTaxonomy(workspaceId, { includeInactive = false } = {}) {
  ensureDefaultTaxonomy(workspaceId);
  const categories = db.prepare(
    `SELECT * FROM ticket_categories WHERE workspace_id = ?${includeInactive ? '' : ' AND active = 1'}
     ORDER BY sort_order ASC, name ASC`
  ).all(workspaceId);
  for (const category of categories) {
    category.subcategories = db.prepare(
      `SELECT * FROM ticket_subcategories WHERE category_id = ?${includeInactive ? '' : ' AND active = 1'}
       ORDER BY sort_order ASC, name ASC`
    ).all(category.id);
  }
  return categories;
}

export function categoryNames(workspaceId) {
  return listTaxonomy(workspaceId).map((c) => c.name);
}

// ---- multi-value subcategory --------------------------------------------
// A ticket can carry several subcategories ("VPN" and "Wi-Fi" on one
// connectivity incident), but `tickets.subcategory` is a single TEXT column
// that SLA matching, business rules, the public API and the report builder
// all already read as a plain string.
//
// So the stored form is a comma-separated list rather than JSON: a single
// existing value is already a valid one-item list (nothing to migrate), the
// `contains` operator those consumers offer keeps working correctly for "has
// this subcategory", and the raw value stays readable in an export. JSON
// would have been the tidier representation but would have silently broken
// every one of those consumers.
export function parseSubcategories(value) {
  if (!value) return [];
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function serializeSubcategories(value) {
  const list = Array.isArray(value) ? value : parseSubcategories(value);
  const seen = new Set();
  const cleaned = [];
  for (const raw of list) {
    const name = String(raw).trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    cleaned.push(name);
  }
  return cleaned.length ? cleaned.join(', ') : null;
}

// Subcategories are only meaningful under their category, so changing the
// category drops any that no longer belong. Unknown names are kept when the
// category itself is unknown (a free-text legacy value, or one the admin has
// since renamed) -- silently erasing historical data would be worse than
// carrying a value that no longer appears in the picker.
export function reconcileSubcategories(workspaceId, categoryName, subcategories) {
  const selected = Array.isArray(subcategories) ? subcategories : parseSubcategories(subcategories);
  if (!selected.length) return null;
  if (!categoryName) return null;

  const category = db.prepare(
    'SELECT id FROM ticket_categories WHERE workspace_id = ? AND name = ?'
  ).get(workspaceId, categoryName);
  if (!category) return serializeSubcategories(selected);

  const valid = new Set(
    db.prepare('SELECT name FROM ticket_subcategories WHERE category_id = ?').all(category.id).map((r) => r.name.toLowerCase())
  );
  return serializeSubcategories(selected.filter((s) => valid.has(String(s).trim().toLowerCase())));
}
