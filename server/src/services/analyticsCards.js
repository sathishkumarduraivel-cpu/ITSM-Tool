import { db, uid } from '../db.js';
import {
  GROUP_BY_DIMENSIONS, METRICS,
  runGrouped, runTotals, runPivotReport, runBacklogAging,
  previousPeriod, periodsBetween,
} from './reportBuilder.js';

export class AnalyticsError extends Error {
  constructor(message, status = 400, field_errors) {
    super(message);
    this.status = status;
    if (field_errors) this.field_errors = field_errors;
  }
}

const METRIC_KEYS = METRICS.map((m) => m.key);
const DIMENSION_KEYS = Object.keys(GROUP_BY_DIMENSIONS);
const TIME_DIMENSIONS = ['day', 'week', 'month'];

// A metric that is an average or a percentage cannot be summed, and totalling
// it is the single easiest way to publish a confidently wrong number. Each
// metric says how it may be rolled up so the card layer never has to guess.
export const METRIC_KINDS = {
  count: 'sum',
  resolved: 'sum',
  breached: 'sum',
  avg_resolution_hours: 'average',
  first_response_on_time_pct: 'percentage',
  avg_csat: 'average',
  mtta_hours: 'average',
  mttr_hours: 'average',
  first_contact_resolution_pct: 'percentage',
  reopen_rate_pct: 'percentage',
  sla_compliance_pct: 'percentage',
};

// For most metrics bigger is better; for these it is the opposite, and a
// scorecard that colours a rising breach count green is worse than one with
// no colour at all.
export const LOWER_IS_BETTER = new Set([
  'breached', 'avg_resolution_hours', 'mtta_hours', 'mttr_hours', 'reopen_rate_pct',
]);

// The six card types a report is built from. Each one exists because it
// answers a shape of question the others answer badly: a single number, a
// movement over time, a comparison across a dimension, a composition, the
// detail behind a chart, and two dimensions crossed.
export const CARD_TYPES = {
  scorecard: {
    label: 'Scorecard',
    description: 'One number, and how it moved against the previous period.',
    defaultSpan: 3,
    defaultTitle: 'Key figure',
  },
  trend: {
    label: 'Trend',
    description: 'A metric over time, optionally split into series.',
    defaultSpan: 12,
    defaultTitle: 'Trend over time',
  },
  bar: {
    label: 'Bar chart',
    description: 'Compare one or more metrics across a dimension.',
    defaultSpan: 6,
    defaultTitle: 'Comparison',
  },
  donut: {
    label: 'Donut',
    description: 'How a total breaks down into its parts.',
    defaultSpan: 4,
    defaultTitle: 'Breakdown',
  },
  table: {
    label: 'Table',
    description: 'Rows with several metrics side by side, sortable.',
    defaultSpan: 6,
    defaultTitle: 'Detail',
  },
  pivot: {
    label: 'Heatmap',
    description: 'Two dimensions crossed, shaded by volume.',
    defaultSpan: 6,
    defaultTitle: 'Crosstab',
  },
};

export const DATE_PRESETS = {
  last_7_days: { label: 'Last 7 days', days: 7 },
  last_30_days: { label: 'Last 30 days', days: 30 },
  last_90_days: { label: 'Last 90 days', days: 90 },
  last_12_months: { label: 'Last 12 months', days: 365 },
  this_month: { label: 'This month' },
  last_month: { label: 'Last month' },
  this_year: { label: 'This year' },
  all_time: { label: 'All time' },
  custom: { label: 'Custom range' },
};

const iso = (d) => d.toISOString().slice(0, 10);

// A board's period, turned into the {from,to} the query layer understands.
// all_time deliberately returns no bounds rather than a very old date, so the
// query has no date predicate at all.
export function resolveRange(range) {
  const r = range || { preset: 'last_30_days' };
  const preset = r.preset || 'custom';
  const now = new Date();
  if (preset === 'all_time') return {};
  if (preset === 'custom') {
    const out = {};
    if (r.from) out.from = r.from;
    if (r.to) out.to = r.to;
    return out;
  }
  if (preset === 'this_month') {
    return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))), to: iso(now) };
  }
  if (preset === 'last_month') {
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return { from: iso(first), to: iso(last) };
  }
  if (preset === 'this_year') {
    return { from: iso(new Date(Date.UTC(now.getUTCFullYear(), 0, 1))), to: iso(now) };
  }
  const days = DATE_PRESETS[preset]?.days;
  if (!days) throw new AnalyticsError(`Unknown date preset: ${preset}`);
  return { from: iso(new Date(now.getTime() - days * 86400000)), to: iso(now) };
}

const asMetric = (v, field, fallback) => {
  if (v === undefined || v === null || v === '') {
    if (fallback) return fallback;
    throw new AnalyticsError('Choose a metric for this card.', 400, [{ field, message: 'Required' }]);
  }
  if (!METRIC_KEYS.includes(v)) throw new AnalyticsError(`Unknown metric: ${v}`, 400, [{ field, message: 'Not a metric this report can show' }]);
  return v;
};

const asDimension = (v, field, { allow = DIMENSION_KEYS, optional = false } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    throw new AnalyticsError('Choose what to group this card by.', 400, [{ field, message: 'Required' }]);
  }
  if (!allow.includes(v)) throw new AnalyticsError(`Unknown grouping: ${v}`, 400, [{ field, message: 'Not a grouping this report can use' }]);
  return v;
};

const asMetricList = (v, field) => {
  const list = Array.isArray(v) ? v.filter(Boolean) : [];
  if (!list.length) throw new AnalyticsError('Pick at least one metric.', 400, [{ field, message: 'Pick at least one' }]);
  for (const m of list) asMetric(m, field);
  return [...new Set(list)].slice(0, 4);
};

// Only the filters the query layer actually honours are kept. Anything else a
// client sends is dropped rather than stored, so a card's saved config can
// never drift into containing a key that silently does nothing.
const CARD_FILTERS = ['type', 'priority', 'team', 'category', 'status', 'assignee_id'];
function cleanFilters(raw) {
  const out = {};
  for (const k of CARD_FILTERS) {
    const v = raw?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim();
  }
  return out;
}

const clampLimit = (v, fallback = 10) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(50, Math.max(3, Math.round(n)));
};

// Validates and normalises a card's configuration for its type. Returns the
// stored shape, so what goes into the database is always already correct and
// the run path never has to defend against a malformed card.
export function validateCardConfig(cardType, raw = {}) {
  const type = CARD_TYPES[cardType];
  if (!type) throw new AnalyticsError(`Unknown card type: ${cardType}`, 400, [{ field: 'card_type', message: 'Not a card type' }]);
  const filters = cleanFilters(raw.filters);
  const range = raw.date_range ? normaliseRange(raw.date_range) : null;
  const base = { filters, ...(range ? { date_range: range } : {}) };

  switch (cardType) {
    case 'scorecard':
      return { ...base, metric: asMetric(raw.metric, 'metric'), compare: raw.compare !== false };
    case 'trend':
      return {
        ...base,
        metric: asMetric(raw.metric, 'metric'),
        time_dim: asDimension(raw.time_dim || 'month', 'time_dim', { allow: TIME_DIMENSIONS }),
        series_dim: asDimension(raw.series_dim, 'series_dim', { optional: true }),
        style: raw.style === 'area' ? 'area' : 'line',
      };
    case 'bar':
      return {
        ...base,
        group_by: asDimension(raw.group_by, 'group_by'),
        metrics: asMetricList(raw.metrics?.length ? raw.metrics : [raw.metric].filter(Boolean), 'metrics'),
        orientation: raw.orientation === 'horizontal' ? 'horizontal' : 'vertical',
        limit: clampLimit(raw.limit),
      };
    case 'donut':
      return {
        ...base,
        group_by: asDimension(raw.group_by, 'group_by'),
        metric: asMetric(raw.metric, 'metric', 'count'),
        limit: clampLimit(raw.limit, 8),
      };
    case 'table': {
      const metrics = asMetricList(raw.metrics?.length ? raw.metrics : ['count'], 'metrics');
      const sortBy = raw.sort_by && metrics.includes(raw.sort_by) ? raw.sort_by : metrics[0];
      return {
        ...base,
        group_by: asDimension(raw.group_by, 'group_by'),
        metrics,
        sort_by: sortBy,
        sort_dir: raw.sort_dir === 'asc' ? 'asc' : 'desc',
        limit: clampLimit(raw.limit, 10),
      };
    }
    case 'pivot': {
      const row = asDimension(raw.row_dim, 'row_dim');
      const col = asDimension(raw.col_dim, 'col_dim');
      if (row === col) {
        throw new AnalyticsError('A heatmap needs two different dimensions.', 400, [{ field: 'col_dim', message: 'Pick a different dimension from the rows' }]);
      }
      return { ...base, row_dim: row, col_dim: col };
    }
    default:
      throw new AnalyticsError(`Unknown card type: ${cardType}`);
  }
}

export function normaliseRange(raw) {
  const preset = raw?.preset || 'last_30_days';
  if (!DATE_PRESETS[preset]) throw new AnalyticsError(`Unknown date preset: ${preset}`, 400, [{ field: 'date_range', message: 'Not a period this report offers' }]);
  const out = { preset };
  if (preset === 'custom') {
    const ok = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!ok(raw.from) || !ok(raw.to)) {
      throw new AnalyticsError('A custom period needs a start and an end date.', 400, [{ field: 'date_range', message: 'Give both dates as YYYY-MM-DD' }]);
    }
    if (raw.from > raw.to) throw new AnalyticsError('The start of the period is after its end.', 400, [{ field: 'date_range', message: 'Start must come first' }]);
    out.from = raw.from;
    out.to = raw.to;
  }
  return out;
}

const trimTop = (rows, metric, limit) => {
  const sorted = [...rows].sort((a, b) => (b[metric] ?? 0) - (a[metric] ?? 0));
  if (sorted.length <= limit) return sorted;
  // Everything past the cut is kept as one row rather than dropped: a donut
  // whose slices do not add up to the total it claims is a lie by omission.
  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit);
  const other = { group_key: `Other (${tail.length})`, is_other: true };
  for (const key of METRIC_KEYS) {
    if (METRIC_KINDS[key] === 'sum') other[key] = tail.reduce((s, r) => s + (r[key] ?? 0), 0);
    else other[key] = null;
  }
  return [...head, other];
};

// Runs one card and returns only what its renderer needs. The board's period
// applies unless the card overrides it, which is what lets one board mix
// "this month" panels with a twelve-month trend.
export function runCard(workspaceId, card, boardRange) {
  const config = typeof card.config === 'string' ? JSON.parse(card.config) : card.config;
  const range = resolveRange(config.date_range || boardRange);
  const filters = { ...config.filters, ...range };

  switch (card.card_type) {
    case 'scorecard': {
      const totals = runTotals(workspaceId, filters);
      const value = totals[config.metric] ?? null;
      const out = { metric: config.metric, value, kind: METRIC_KINDS[config.metric], lower_is_better: LOWER_IS_BETTER.has(config.metric) };
      if (config.compare !== false) {
        const { previous } = previousPeriod(range);
        const prev = runTotals(workspaceId, { ...config.filters, ...previous });
        out.previous = prev[config.metric] ?? null;
        out.previous_period = previous;
      }
      return out;
    }
    case 'trend': {
      const dims = config.series_dim ? [config.time_dim, config.series_dim] : [config.time_dim];
      const rows = runGrouped(workspaceId, { dims, filters });
      const metric = config.metric;
      const periods = range.from && range.to ? periodsBetween(config.time_dim, range.from, range.to) : null;
      const keys = periods?.length
        ? periods
        : [...new Set(rows.map((r) => r.group_key))].sort();

      if (!config.series_dim) {
        return {
          metric, style: config.style, series: ['value'],
          rows: keys.map((k) => {
            const hit = rows.find((r) => r.group_key === k);
            return { period: k, value: hit ? hit[metric] ?? 0 : 0 };
          }),
        };
      }
      const series = [...new Set(rows.map((r) => r.series_key))].sort();
      return {
        metric, style: config.style, series,
        rows: keys.map((k) => {
          const point = { period: k };
          for (const s of series) {
            const hit = rows.find((r) => r.group_key === k && r.series_key === s);
            point[s] = hit ? hit[metric] ?? 0 : 0;
          }
          return point;
        }),
      };
    }
    case 'bar': {
      const rows = runGrouped(workspaceId, { dims: [config.group_by], filters });
      return {
        metrics: config.metrics,
        orientation: config.orientation,
        dimension_label: GROUP_BY_DIMENSIONS[config.group_by].label,
        rows: trimTop(rows, config.metrics[0], config.limit),
      };
    }
    case 'donut': {
      const rows = runGrouped(workspaceId, { dims: [config.group_by], filters });
      const trimmed = trimTop(rows, config.metric, config.limit);
      const total = trimmed.reduce((s, r) => s + (r[config.metric] ?? 0), 0);
      return {
        metric: config.metric,
        dimension_label: GROUP_BY_DIMENSIONS[config.group_by].label,
        total,
        rows: trimmed.map((r) => ({ group_key: r.group_key, value: r[config.metric] ?? 0 })),
      };
    }
    case 'table': {
      const rows = runGrouped(workspaceId, { dims: [config.group_by], filters });
      const dir = config.sort_dir === 'asc' ? 1 : -1;
      const sorted = [...rows].sort((a, b) => {
        const av = a[config.sort_by] ?? -Infinity;
        const bv = b[config.sort_by] ?? -Infinity;
        return (av - bv) * dir;
      });
      return {
        metrics: config.metrics,
        dimension_label: GROUP_BY_DIMENSIONS[config.group_by].label,
        sort_by: config.sort_by,
        sort_dir: config.sort_dir,
        total_rows: rows.length,
        rows: sorted.slice(0, config.limit).map((r) => ({
          group_key: r.group_key,
          ...Object.fromEntries(config.metrics.map((m) => [m, r[m]])),
        })),
      };
    }
    case 'pivot':
      return runPivotReport(workspaceId, { rowDim: config.row_dim, colDim: config.col_dim, filters });
    default:
      throw new AnalyticsError(`Unknown card type: ${card.card_type}`);
  }
}

// ---- Boards --------------------------------------------------------------

const parseBoard = (row) => ({
  ...row,
  date_range: row.date_range ? JSON.parse(row.date_range) : { preset: 'last_30_days' },
});
const parseCard = (row) => ({ ...row, config: JSON.parse(row.config) });

// A private board is invisible to everyone but its author -- returned as
// "not found" rather than "forbidden", since confirming that a board exists
// is itself something its author did not share.
export function getBoard(workspaceId, id, user) {
  const row = db.prepare(
    `SELECT * FROM analytics_dashboards WHERE id = ? AND workspace_id = ? AND (visibility != 'private' OR created_by = ?)`
  ).get(id, workspaceId, user.id);
  if (!row) throw new AnalyticsError('That report no longer exists.', 404);
  const cards = db.prepare('SELECT * FROM analytics_cards WHERE dashboard_id = ? ORDER BY position, created_at').all(id).map(parseCard);
  return { ...parseBoard(row), cards, mine: row.created_by === user.id };
}

export function listBoards(workspaceId, user) {
  const rows = db.prepare(
    `SELECT b.*, (SELECT COUNT(*) FROM analytics_cards c WHERE c.dashboard_id = b.id) AS card_count,
            u.name AS author_name
     FROM analytics_dashboards b
     LEFT JOIN users u ON u.id = b.created_by
     WHERE b.workspace_id = ? AND (b.visibility != 'private' OR b.created_by = ?)
     ORDER BY b.updated_at DESC`
  ).all(workspaceId, user.id);
  return rows.map((r) => ({ ...parseBoard(r), mine: r.created_by === user.id }));
}

function assertCanEdit(row, user) {
  if (row.created_by !== user.id && user.role !== 'admin') {
    throw new AnalyticsError("Only this report's author, or an admin, can change it.", 403);
  }
}

export function createBoard(workspaceId, user, body) {
  const name = String(body.name || '').trim();
  if (!name) throw new AnalyticsError('Give the report a name.', 400, [{ field: 'name', message: 'Required' }]);
  if (body.visibility && !['private', 'shared'].includes(body.visibility)) {
    throw new AnalyticsError('Visibility must be private or shared.', 400, [{ field: 'visibility', message: 'private or shared' }]);
  }
  const id = uid('adb');
  db.prepare(
    `INSERT INTO analytics_dashboards (id, workspace_id, name, description, folder, visibility, date_range, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id, workspaceId, name,
    String(body.description || '').trim() || null,
    String(body.folder || '').trim() || null,
    body.visibility || 'shared',
    JSON.stringify(normaliseRange(body.date_range)),
    user.id
  );
  // Cards can travel with the create call, which is what makes a template a
  // single request rather than one per card.
  if (Array.isArray(body.cards)) {
    body.cards.forEach((card, i) => addCard(workspaceId, id, user, card, i));
  }
  return getBoard(workspaceId, id, user);
}

export function updateBoard(workspaceId, id, user, body) {
  const row = db.prepare('SELECT * FROM analytics_dashboards WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new AnalyticsError('That report no longer exists.', 404);
  assertCanEdit(row, user);
  const fields = []; const params = [];
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) throw new AnalyticsError('Give the report a name.', 400, [{ field: 'name', message: 'Required' }]);
    fields.push('name = ?'); params.push(name);
  }
  if (body.description !== undefined) { fields.push('description = ?'); params.push(String(body.description).trim() || null); }
  if (body.folder !== undefined) { fields.push('folder = ?'); params.push(String(body.folder).trim() || null); }
  if (body.visibility !== undefined) {
    if (!['private', 'shared'].includes(body.visibility)) throw new AnalyticsError('Visibility must be private or shared.', 400, [{ field: 'visibility', message: 'private or shared' }]);
    fields.push('visibility = ?'); params.push(body.visibility);
  }
  if (body.date_range !== undefined) { fields.push('date_range = ?'); params.push(JSON.stringify(normaliseRange(body.date_range))); }
  if (!fields.length) throw new AnalyticsError('Nothing to update.', 400);
  fields.push("updated_at = datetime('now')");
  params.push(id);
  db.prepare(`UPDATE analytics_dashboards SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  return getBoard(workspaceId, id, user);
}

export function deleteBoard(workspaceId, id, user) {
  const row = db.prepare('SELECT * FROM analytics_dashboards WHERE id = ? AND workspace_id = ?').get(id, workspaceId);
  if (!row) throw new AnalyticsError('That report no longer exists.', 404);
  assertCanEdit(row, user);
  // The cards go with it through the foreign key's ON DELETE CASCADE.
  db.prepare('DELETE FROM analytics_dashboards WHERE id = ?').run(id);
  return { ok: true };
}

const touch = (id) => db.prepare("UPDATE analytics_dashboards SET updated_at = datetime('now') WHERE id = ?").run(id);

export function addCard(workspaceId, boardId, user, body, forcedPosition) {
  const board = db.prepare('SELECT * FROM analytics_dashboards WHERE id = ? AND workspace_id = ?').get(boardId, workspaceId);
  if (!board) throw new AnalyticsError('That report no longer exists.', 404);
  assertCanEdit(board, user);
  const cardType = body.card_type;
  const config = validateCardConfig(cardType, body.config || body);
  const position = forcedPosition ?? (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS next FROM analytics_cards WHERE dashboard_id = ?').get(boardId).next);
  const span = Math.min(12, Math.max(3, Number(body.span) || CARD_TYPES[cardType].defaultSpan));
  const id = uid('acd');
  db.prepare(
    'INSERT INTO analytics_cards (id, dashboard_id, workspace_id, title, card_type, config, span, position) VALUES (?,?,?,?,?,?,?,?)'
  ).run(
    id, boardId, workspaceId,
    String(body.title || '').trim() || CARD_TYPES[cardType].defaultTitle,
    cardType, JSON.stringify(config), span, position
  );
  touch(boardId);
  return parseCard(db.prepare('SELECT * FROM analytics_cards WHERE id = ?').get(id));
}

function loadCardForEdit(workspaceId, cardId, user) {
  const card = db.prepare('SELECT * FROM analytics_cards WHERE id = ? AND workspace_id = ?').get(cardId, workspaceId);
  if (!card) throw new AnalyticsError('That card no longer exists.', 404);
  const board = db.prepare('SELECT * FROM analytics_dashboards WHERE id = ?').get(card.dashboard_id);
  if (!board) throw new AnalyticsError('That card no longer exists.', 404);
  assertCanEdit(board, user);
  return card;
}

export function updateCard(workspaceId, cardId, user, body) {
  const card = loadCardForEdit(workspaceId, cardId, user);
  const cardType = body.card_type || card.card_type;
  const fields = []; const params = [];
  if (body.title !== undefined) {
    const title = String(body.title).trim();
    if (!title) throw new AnalyticsError('Give the card a title.', 400, [{ field: 'title', message: 'Required' }]);
    fields.push('title = ?'); params.push(title);
  }
  // Changing the type revalidates against the NEW type's contract, so a card
  // can never keep configuration that its current type does not understand.
  if (body.config !== undefined || body.card_type !== undefined) {
    const raw = body.config || JSON.parse(card.config);
    fields.push('card_type = ?', 'config = ?');
    params.push(cardType, JSON.stringify(validateCardConfig(cardType, raw)));
  }
  if (body.span !== undefined) { fields.push('span = ?'); params.push(Math.min(12, Math.max(3, Number(body.span) || 6))); }
  if (!fields.length) throw new AnalyticsError('Nothing to update.', 400);
  params.push(cardId);
  db.prepare(`UPDATE analytics_cards SET ${fields.join(', ')} WHERE id = ?`).run(...params);
  touch(card.dashboard_id);
  return parseCard(db.prepare('SELECT * FROM analytics_cards WHERE id = ?').get(cardId));
}

export function deleteCard(workspaceId, cardId, user) {
  const card = loadCardForEdit(workspaceId, cardId, user);
  db.prepare('DELETE FROM analytics_cards WHERE id = ?').run(cardId);
  touch(card.dashboard_id);
  return { ok: true };
}

// Reordering sends the whole order rather than one card's new index: a single
// index is ambiguous the moment two people move cards at once, whereas the
// full list is the complete intent and lands as one transaction.
export function reorderCards(workspaceId, boardId, user, order) {
  const board = db.prepare('SELECT * FROM analytics_dashboards WHERE id = ? AND workspace_id = ?').get(boardId, workspaceId);
  if (!board) throw new AnalyticsError('That report no longer exists.', 404);
  assertCanEdit(board, user);
  if (!Array.isArray(order) || !order.length) throw new AnalyticsError('Send the cards in their new order.', 400);
  const owned = new Set(db.prepare('SELECT id FROM analytics_cards WHERE dashboard_id = ?').all(boardId).map((r) => r.id));
  for (const id of order) {
    if (!owned.has(id)) throw new AnalyticsError('That card is not on this report.', 400);
  }
  const stmt = db.prepare('UPDATE analytics_cards SET position = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    order.forEach((id, i) => stmt.run(i, id));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  touch(boardId);
  return getBoard(workspaceId, boardId, user);
}

// Every card on the board, run in one request. Six cards would otherwise be
// six round trips, and the board would paint raggedly as they landed.
// One card failing returns that card's error in place rather than failing the
// whole board -- a single bad card should not blank out the other five.
export function runBoard(workspaceId, board) {
  return board.cards.map((card) => {
    try {
      return { id: card.id, data: runCard(workspaceId, card, board.date_range) };
    } catch (e) {
      return { id: card.id, error: e.message };
    }
  });
}

export function analyticsMeta() {
  return {
    card_types: Object.entries(CARD_TYPES).map(([key, t]) => ({ key, ...t })),
    dimensions: Object.entries(GROUP_BY_DIMENSIONS).map(([key, d]) => ({ key, label: d.label, is_time: TIME_DIMENSIONS.includes(key) })),
    metrics: METRICS.map((m) => ({ ...m, kind: METRIC_KINDS[m.key], lower_is_better: LOWER_IS_BETTER.has(m.key) })),
    date_presets: Object.entries(DATE_PRESETS).map(([key, p]) => ({ key, label: p.label })),
    time_dimensions: TIME_DIMENSIONS,
  };
}

export { runBacklogAging };
