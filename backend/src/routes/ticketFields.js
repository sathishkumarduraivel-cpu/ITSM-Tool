import { Router } from 'express';
import { db, uid } from '../db.js';
import { requireAuth, requireWorkspace, requirePermission } from '../middleware/auth.js';
import {
  FIELD_REGISTRY, COLORS, builtinFieldsFor, listFieldOptions, allFieldOptions,
  isManagedEnum, valuesAreLocked, slugifyValue, ensureDefaultFieldOptions,
} from '../services/ticketFields.js';
import { listTaxonomy } from '../services/ticketCategories.js';
import { logAudit } from '../services/auditLog.js';

const router = Router();
router.use(requireAuth, requireWorkspace);

const TICKET_TYPES = ['incident', 'request', 'problem', 'change'];

// The whole field picture for one ticket type: built-in fields with whatever
// is configurable about each, the custom fields, and the live option lists.
// Readable by anyone signed in because the ticket forms need the option
// labels and colours; every mutation below is gated.
router.get('/:ticketType', (req, res) => {
  const ticketType = req.params.ticketType;
  if (!TICKET_TYPES.includes(ticketType)) return res.status(400).json({ error: 'Unknown ticket type' });

  const canManage = req.user.role === 'admin' || (req.user.permissions || []).includes('custom_fields.manage');
  const includeInactive = req.query.all === '1' && canManage;

  const options = allFieldOptions(req.workspaceId, { includeInactive });
  const taxonomy = listTaxonomy(req.workspaceId, { includeInactive });

  const builtins = builtinFieldsFor(ticketType).map((field) => ({
    ...field,
    // Only ever the shape the UI needs -- the registry's own prose stays
    // server-side so there is one copy of it.
    options: isManagedEnum(field.key) ? options[field.key] : undefined,
    taxonomy: field.manage === 'taxonomy' ? taxonomy : undefined,
    valuesLocked: !!field.valuesLocked,
  }));

  const custom = db.prepare(
    'SELECT * FROM ticket_custom_fields WHERE workspace_id = ? AND ticket_type = ? ORDER BY sort_order ASC, created_at ASC'
  ).all(req.workspaceId, ticketType).map((f) => ({
    ...f,
    options: (() => { try { return JSON.parse(f.options || '[]'); } catch { return []; } })(),
  }));

  res.json({ ticket_type: ticketType, builtin: builtins, custom, colors: COLORS });
});

router.use(requirePermission('custom_fields.manage'));

function guardEnum(fieldKey) {
  if (!isManagedEnum(fieldKey)) {
    return `"${FIELD_REGISTRY[fieldKey]?.label || fieldKey}" has no editable options here.`;
  }
  return null;
}

router.post('/options/:fieldKey', (req, res) => {
  const { fieldKey } = req.params;
  const guard = guardEnum(fieldKey);
  if (guard) return res.status(400).json({ error: guard });
  if (valuesAreLocked(fieldKey)) {
    return res.status(400).json({ error: FIELD_REGISTRY[fieldKey].lockedReason });
  }

  const label = String(req.body?.label || '').trim();
  if (!label) return res.status(400).json({ error: 'Label is required' });
  const color = COLORS.includes(req.body?.color) ? req.body.color : 'slate';

  ensureDefaultFieldOptions(req.workspaceId);
  const existing = listFieldOptions(req.workspaceId, fieldKey, { includeInactive: true });
  if (existing.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
    return res.status(400).json({ error: 'An option with that label already exists' });
  }

  const value = slugifyValue(label, existing.map((o) => o.value));
  const nextOrder = existing.length ? Math.max(...existing.map((o) => o.sort_order)) + 1 : 0;
  db.prepare(
    'INSERT INTO ticket_field_options (id, workspace_id, field_key, value, label, color, sort_order) VALUES (?,?,?,?,?,?,?)'
  ).run(uid('tfo'), req.workspaceId, fieldKey, value, label, color, nextOrder);
  logAudit(req, { action: 'field_option.create', entityType: 'ticket_field', entityId: fieldKey, entityLabel: label });
  res.status(201).json({ options: listFieldOptions(req.workspaceId, fieldKey, { includeInactive: true }) });
});

router.patch('/options/:id', (req, res) => {
  const option = db.prepare('SELECT * FROM ticket_field_options WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!option) return res.status(404).json({ error: 'Not found' });

  const { label, color, sort_order, active } = req.body || {};
  const nextLabel = label !== undefined ? String(label).trim() : option.label;
  if (!nextLabel) return res.status(400).json({ error: 'Label cannot be empty' });

  // Reordering or deactivating a locked field's options would misrepresent
  // reality: PRIORITY_RANK is fixed, and a ticket cannot have no priority.
  // Renaming and recolouring are safe, so those are allowed.
  if (valuesAreLocked(option.field_key) && (sort_order !== undefined || active !== undefined)) {
    return res.status(400).json({ error: FIELD_REGISTRY[option.field_key].lockedReason });
  }

  db.prepare('UPDATE ticket_field_options SET label = ?, color = ?, sort_order = ?, active = ? WHERE id = ?').run(
    nextLabel,
    COLORS.includes(color) ? color : option.color,
    sort_order !== undefined ? Number(sort_order) || 0 : option.sort_order,
    active !== undefined ? (active ? 1 : 0) : option.active,
    option.id
  );
  logAudit(req, { action: 'field_option.update', entityType: 'ticket_field', entityId: option.field_key, entityLabel: nextLabel });
  res.json({ options: listFieldOptions(req.workspaceId, option.field_key, { includeInactive: true }) });
});

router.delete('/options/:id', (req, res) => {
  const option = db.prepare('SELECT * FROM ticket_field_options WHERE id = ? AND workspace_id = ?').get(req.params.id, req.workspaceId);
  if (!option) return res.status(404).json({ error: 'Not found' });
  if (valuesAreLocked(option.field_key)) {
    return res.status(400).json({ error: FIELD_REGISTRY[option.field_key].lockedReason });
  }

  const remaining = listFieldOptions(req.workspaceId, option.field_key).filter((o) => o.id !== option.id);
  if (remaining.length === 0) {
    return res.status(400).json({ error: 'A field needs at least one option — rename this one instead of removing it.' });
  }

  // Tickets store the value, so a value still in use is deactivated rather
  // than deleted: it stops appearing in the picker while existing tickets
  // keep a resolvable label.
  const inUse = db.prepare(`SELECT COUNT(*) c FROM tickets WHERE workspace_id = ? AND ${option.field_key} = ?`)
    .get(req.workspaceId, option.value).c;
  if (inUse > 0) {
    db.prepare('UPDATE ticket_field_options SET active = 0 WHERE id = ?').run(option.id);
    logAudit(req, { action: 'field_option.deactivate', entityType: 'ticket_field', entityId: option.field_key, entityLabel: option.label, details: { tickets: inUse } });
    return res.json({ deactivated: true, tickets: inUse, options: listFieldOptions(req.workspaceId, option.field_key, { includeInactive: true }) });
  }

  db.prepare('DELETE FROM ticket_field_options WHERE id = ?').run(option.id);
  logAudit(req, { action: 'field_option.delete', entityType: 'ticket_field', entityId: option.field_key, entityLabel: option.label });
  res.json({ deactivated: false, options: listFieldOptions(req.workspaceId, option.field_key, { includeInactive: true }) });
});

// Whole-list reorder in one call, so dragging three rows is one request and
// cannot leave a half-applied order behind.
router.put('/options/:fieldKey/order', (req, res) => {
  const { fieldKey } = req.params;
  const guard = guardEnum(fieldKey);
  if (guard) return res.status(400).json({ error: guard });
  if (valuesAreLocked(fieldKey)) {
    return res.status(400).json({ error: FIELD_REGISTRY[fieldKey].lockedReason });
  }

  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (!ids) return res.status(400).json({ error: 'ids array is required' });

  const owned = new Set(
    listFieldOptions(req.workspaceId, fieldKey, { includeInactive: true }).map((o) => o.id)
  );
  if (!ids.every((id) => owned.has(id))) return res.status(400).json({ error: 'That order references an option from another field' });

  ids.forEach((id, i) => db.prepare('UPDATE ticket_field_options SET sort_order = ? WHERE id = ?').run(i, id));
  res.json({ options: listFieldOptions(req.workspaceId, fieldKey, { includeInactive: true }) });
});

export default router;
