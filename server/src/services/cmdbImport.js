// CSV import for CIs, with a dry run that has to be looked at before anything
// is written.
//
// Bulk import is how most CMDBs get their first thousand rows and also how
// most of them get their first thousand duplicates. So the import runs the
// same identification engine discovery does: every row is matched against the
// existing estate first, and the preview says plainly how many rows would be
// created, how many would update something that already exists, and which
// ones cannot be processed at all -- before the commit button appears.
//
// The parser is written here rather than pulled in: this codebase carries no
// native dependencies on purpose, and CSV is small enough to do properly.
import { db } from '../db.js';
import { getClass, effectiveAttributes, coerceValue, ConfigError } from './ciClasses.js';
import { identify, reconcile } from './ciIdentity.js';
import { getDiscoverySource } from './discoverySources.js';

export const MAX_ROWS = 5000;

// ------------------------------------------------------------------ parse --

/**
 * RFC 4180 CSV: quoted fields may contain commas, newlines and doubled quotes.
 * Written as a character scanner rather than a line split, because a split on
 * newlines corrupts any export containing a multi-line description field --
 * which every real asset export does.
 */
export function parseCsv(text, { delimiter = ',' } = {}) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let started = false; // distinguishes an empty final line from a real empty field

  const endField = () => { row.push(field); field = ''; started = false; };
  const endRow = () => { endField(); rows.push(row); row = []; };

  // A UTF-8 BOM in front of the first header would otherwise become part of
  // the first column's name, and nothing would map to it.
  const src = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else { inQuotes = false; }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !started) { inQuotes = true; started = true; continue; }
    if (ch === delimiter) { endField(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { endRow(); continue; }
    field += ch;
    started = true;
  }
  // A trailing newline must not produce a phantom empty row.
  if (field !== '' || row.length) endRow();

  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

// Splits a parsed grid into headers and data, and reports the shape problems
// worth stopping for before any row is examined.
export function readSheet(text, { delimiter = ',' } = {}) {
  const grid = parseCsv(text, { delimiter });
  if (!grid.length) throw new ConfigError('That file has no rows in it');

  const headers = grid[0].map((h) => String(h).trim());
  if (!headers.some(Boolean)) throw new ConfigError('The first row must be a header row naming each column');

  const duplicates = headers.filter((h, i) => h && headers.indexOf(h) !== i);
  if (duplicates.length) {
    throw new ConfigError(`These column names appear more than once: ${[...new Set(duplicates)].join(', ')}`);
  }

  const rows = grid.slice(1);
  if (rows.length > MAX_ROWS) throw new ConfigError(`That file has ${rows.length} rows. Import at most ${MAX_ROWS} at a time.`);

  return { headers, rows };
}

// ------------------------------------------------------------------ map ----

// Core columns an import may set directly, alongside class attributes.
const CORE_FIELDS = [
  { key: 'tag', label: 'Asset tag' },
  { key: 'name', label: 'Name' },
  { key: 'status', label: 'Status' },
  { key: 'location', label: 'Location' },
  { key: 'vendor', label: 'Vendor' },
  { key: 'purchase_date', label: 'Purchase date' },
  { key: 'warranty_expiry', label: 'Warranty expiry' },
  { key: 'notes', label: 'Notes' },
];

/**
 * What a column could be mapped to, plus a guess for each header.
 *
 * The guess matters more than it looks: an admin facing forty unmapped
 * columns usually gives up, and an admin facing thirty-six correct guesses
 * fixes the other four. Matching is on the attribute key, its label, and the
 * same with spaces and underscores swapped, which covers nearly every export.
 */
export function mappingOptions(workspaceId, classId) {
  const cls = getClass(workspaceId, classId);
  if (!cls) throw new ConfigError('Class not found', 404);
  const attrs = effectiveAttributes(workspaceId, cls.id);
  return {
    core: CORE_FIELDS,
    attributes: attrs.map((a) => ({
      key: a.attr_key, label: a.label, data_type: a.data_type, required: a.required,
      is_identifier: a.is_identifier, options: a.options,
    })),
  };
}

const normalise = (s) => String(s || '').toLowerCase().replace(/[\s_-]+/g, '');

export function guessMapping(workspaceId, classId, headers) {
  const { core, attributes } = mappingOptions(workspaceId, classId);
  const candidates = [
    ...core.map((f) => ({ target: `core.${f.key}`, keys: [f.key, f.label] })),
    ...attributes.map((a) => ({ target: `attr.${a.key}`, keys: [a.key, a.label] })),
  ];
  const index = new Map();
  for (const c of candidates) {
    for (const k of c.keys) if (!index.has(normalise(k))) index.set(normalise(k), c.target);
  }
  return Object.fromEntries(headers.map((h) => [h, index.get(normalise(h)) || '']));
}

// ---------------------------------------------------------------- preview --

function rowToPayload(headers, cells, mapping, classKey) {
  const payload = { ci_class: classKey, attributes: {} };
  headers.forEach((header, i) => {
    const target = mapping[header];
    if (!target) return;
    const raw = cells[i];
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === undefined || value === '') return;
    if (target.startsWith('core.')) payload[target.slice(5)] = value;
    else if (target.startsWith('attr.')) payload.attributes[target.slice(5)] = value;
  });
  return payload;
}

/**
 * Examine every row without writing anything.
 *
 * Each row is reported as create / update / error, with the reason. Duplicate
 * identifiers WITHIN the file are flagged too -- a spreadsheet listing the
 * same serial twice will otherwise import cleanly and leave one CI silently
 * overwritten by the other, which is much harder to notice afterwards than an
 * up-front warning.
 */
export function previewImport(workspaceId, { headers, rows }, { classId, mapping, sourceId = null }) {
  const cls = getClass(workspaceId, classId);
  if (!cls) throw new ConfigError('Class not found', 404);
  if (cls.is_abstract) throw new ConfigError(`${cls.label} is a grouping class and cannot hold CIs`);

  const attrs = new Map(effectiveAttributes(workspaceId, cls.id).map((a) => [a.attr_key, a]));
  const mapped = Object.values(mapping || {}).filter(Boolean);
  if (!mapped.length) throw new ConfigError('Map at least one column before importing');

  // A required attribute with no column behind it will fail every single row,
  // so say it once here instead of five thousand times below.
  const missingRequired = [...attrs.values()]
    .filter((a) => a.required && !mapped.includes(`attr.${a.attr_key}`))
    .map((a) => a.label);

  const identifierColumns = [...attrs.values()]
    .filter((a) => a.is_identifier && mapped.includes(`attr.${a.attr_key}`))
    .map((a) => a.attr_key);

  const seen = new Map(); // identifier fingerprint -> first row number
  const results = [];
  const counts = { create: 0, update: 0, error: 0, duplicate_in_file: 0 };

  rows.forEach((cells, i) => {
    const rowNumber = i + 2; // 1-based, and the header is row 1
    const payload = rowToPayload(headers, cells, mapping, cls.key);
    const problems = [];

    // Validate the values themselves before asking whether the CI exists:
    // "8GB is not a number" is more useful than "could not identify".
    for (const [key, value] of Object.entries(payload.attributes)) {
      const attr = attrs.get(key);
      if (!attr) { problems.push(`Unknown field: ${key}`); continue; }
      const { error } = coerceValue(workspaceId, attr, value);
      if (error) problems.push(error);
    }
    for (const attr of attrs.values()) {
      if (!attr.required) continue;
      const v = payload.attributes[attr.attr_key];
      if (v === undefined || String(v).trim() === '') problems.push(`${attr.label} is required`);
    }

    // Each identifier is checked on its own, not as one combined fingerprint.
    // Identification rules match on a single attribute, so two rows sharing
    // just a serial number WILL resolve to the same CI even when every other
    // column differs -- one would silently overwrite the other.
    let duplicateOf = null;
    for (const key of identifierColumns) {
      const value = String(payload.attributes[key] ?? '').trim().toLowerCase();
      if (!value) continue;
      const fingerprint = `${key}=${value}`;
      if (seen.has(fingerprint)) { duplicateOf = seen.get(fingerprint); break; }
      seen.set(fingerprint, rowNumber);
    }

    if (problems.length) {
      counts.error += 1;
      results.push({ row: rowNumber, action: 'error', problems, payload });
      return;
    }
    if (duplicateOf) {
      counts.duplicate_in_file += 1;
      results.push({ row: rowNumber, action: 'duplicate_in_file', duplicate_of_row: duplicateOf, payload });
      return;
    }

    const match = identify(workspaceId, cls.id, payload.attributes, { tag: payload.tag });
    if (match.ci) {
      counts.update += 1;
      results.push({
        row: rowNumber, action: 'update', ci: { id: match.ci.id, name: match.ci.name, tag: match.ci.tag },
        matched_by: match.matched_by, payload,
      });
    } else {
      counts.create += 1;
      results.push({
        row: rowNumber, action: 'create', payload,
        ambiguous: match.ambiguous?.length ? match.ambiguous : undefined,
      });
    }
  });

  return {
    ci_class: { id: cls.id, key: cls.key, label: cls.label },
    source: sourceId ? getDiscoverySource(workspaceId, sourceId) : null,
    total: rows.length,
    counts,
    warnings: [
      ...(identifierColumns.length ? [] : ['No identifying column is mapped, so every row will create a new CI even if it already exists.']),
      ...missingRequired.map((label) => `${label} is required on this class but no column is mapped to it — every row will fail.`),
    ],
    // Capped: the point of the preview is the counts and the problems, and
    // shipping five thousand rows back to a browser helps nobody.
    rows: results.slice(0, 200),
    truncated: results.length > 200,
    // Kept in full so a commit can run exactly what was previewed.
    all: results,
  };
}

// ----------------------------------------------------------------- commit --

/**
 * Apply a previewed import.
 *
 * Rows that failed the preview are skipped rather than attempted: the admin
 * has already been shown them. Everything else goes through reconcile(), so
 * an import obeys identification and source trust exactly as discovery does.
 */
export function commitImport(workspaceId, sheet, { classId, mapping, sourceId = null, skipDuplicates = true }) {
  const preview = previewImport(workspaceId, sheet, { classId, mapping, sourceId });
  const source = sourceId ? getDiscoverySource(workspaceId, sourceId) : null;

  const summary = { created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
  const failures = [];

  for (const row of preview.all) {
    if (row.action === 'error') { summary.skipped += 1; continue; }
    if (row.action === 'duplicate_in_file' && skipDuplicates) { summary.skipped += 1; continue; }

    try {
      const result = reconcile(workspaceId, row.payload, { source });
      if (result.action === 'created') summary.created += 1;
      else if (result.action === 'updated') summary.updated += 1;
      else if (result.action === 'unchanged') summary.unchanged += 1;
      else { summary.failed += 1; failures.push({ row: row.row, error: result.error || result.reason }); }
    } catch (err) {
      // One bad row must not abandon the rest of the file.
      summary.failed += 1;
      failures.push({ row: row.row, error: 'Could not import this row' });
      console.error('[cmdb-import] row failed', err);
    }
  }

  return { ci_class: preview.ci_class, total: preview.total, summary, failures: failures.slice(0, 100) };
}

// --------------------------------------------------------------- template --

// A starter CSV for a class, so an admin can export the right shape rather
// than guess at column names and then fight the mapping screen.
export function templateFor(workspaceId, classId) {
  const cls = getClass(workspaceId, classId);
  if (!cls) throw new ConfigError('Class not found', 404);
  const attrs = effectiveAttributes(workspaceId, cls.id);
  const headers = ['tag', 'name', ...attrs.map((a) => a.attr_key)];
  const example = [
    `${cls.key.toUpperCase().slice(0, 3)}-0001`,
    `Example ${cls.label}`,
    ...attrs.map((a) => exampleValue(a)),
  ];
  return [headers, example].map((r) => r.map(csvCell).join(',')).join('\n');
}

// The example row has to be VALID, not merely illustrative: an admin who
// downloads the template, adds their rows underneath and imports it would
// otherwise be met with an error on row 2 that they did not write. Required
// text fields therefore get an obvious placeholder rather than a blank.
function exampleValue(attr) {
  if (attr.data_type === 'select' || attr.data_type === 'multiselect') return attr.options?.[0] || '';
  if (attr.data_type === 'boolean') return 'yes';
  if (attr.data_type === 'integer' || attr.data_type === 'number') return attr.min_value ?? 1;
  if (attr.data_type === 'date') return '2026-01-31';
  if (attr.data_type === 'datetime') return '2026-01-31 09:00:00';
  if (attr.data_type === 'ip') return '10.0.0.1';
  if (attr.data_type === 'url') return 'https://example.com';
  if (attr.data_type === 'email') return 'owner@example.com';
  // A reference needs a real CI id, which a blank template cannot know.
  if (attr.data_type === 'reference') return '';
  return attr.required ? `example-${attr.attr_key.replace(/_/g, '-')}` : '';
}

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Exporting the estate back out, same shape the importer accepts, so a
// round trip is possible and an export can be edited and re-imported.
export function exportClass(workspaceId, classId) {
  const cls = getClass(workspaceId, classId);
  if (!cls) throw new ConfigError('Class not found', 404);
  const attrs = effectiveAttributes(workspaceId, cls.id);
  const cis = db.prepare('SELECT * FROM assets WHERE workspace_id = ? AND class_id = ? ORDER BY tag').all(workspaceId, cls.id);

  const values = new Map();
  for (const row of db.prepare(
    `SELECT v.ci_id, a.attr_key, v.value FROM ci_attribute_values v
     JOIN ci_class_attributes a ON a.id = v.attribute_id
     JOIN assets ci ON ci.id = v.ci_id
     WHERE ci.workspace_id = ? AND ci.class_id = ?`
  ).all(workspaceId, cls.id)) {
    if (!values.has(row.ci_id)) values.set(row.ci_id, {});
    values.get(row.ci_id)[row.attr_key] = row.value;
  }

  const headers = ['tag', 'name', 'status', ...attrs.map((a) => a.attr_key)];
  const lines = [headers.map(csvCell).join(',')];
  for (const ci of cis) {
    const v = values.get(ci.id) || {};
    lines.push([ci.tag, ci.name, ci.status, ...attrs.map((a) => v[a.attr_key] ?? '')].map(csvCell).join(','));
  }
  return lines.join('\n');
}
