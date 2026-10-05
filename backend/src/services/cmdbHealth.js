// CMDB health: how much of the record can actually be trusted.
//
// Most tools report this as a single percentage, which tells you nothing you
// can act on. A score of 68% does not say what to fix. So every dimension
// here resolves to a LIST OF CIs with the specific gap, and the percentage is
// just the headline over the top of it.
//
// The four dimensions are the four ways a CMDB goes wrong in practice:
//
//   completeness  required attributes left empty
//   staleness     nothing has confirmed this CI exists for a long time
//   orphans       no relationships, so it contributes nothing to impact analysis
//   ownership     nobody is accountable for it
//
// Computed on read. There is no stored score to go stale, and nothing here
// needs a scheduler -- the same reasoning the rest of this codebase applies
// to SLA clocks and escalations.
import { db } from '../db.js';
import { listClasses, effectiveAttributes, resolveClass } from './ciClasses.js';

// A CI not seen for this long is probably decommissioned kit nobody removed.
export const DEFAULT_STALE_DAYS = 90;

// Weights reflect how badly each failure damages the thing a CMDB is for.
// An orphaned CI breaks impact analysis outright, which is worse than a
// missing field, so it carries more.
const WEIGHTS = { completeness: 0.35, relationships: 0.30, ownership: 0.20, freshness: 0.15 };

const pct = (part, whole) => (whole === 0 ? 100 : Math.round((part / whole) * 1000) / 10);

export function healthReport(workspaceId, { staleDays = DEFAULT_STALE_DAYS, limit = 50 } = {}) {
  const cis = db.prepare(
    'SELECT id, tag, name, class_id, owner_id, status, lifecycle_state, created_at FROM assets WHERE workspace_id = ?'
  ).all(workspaceId);

  if (!cis.length) {
    return {
      scanned: 0,
      score: null,
      // A CMDB with nothing in it is not 100% healthy, and saying so would be
      // the most misleading number this module could produce.
      message: 'No CIs recorded yet, so there is nothing to score.',
      dimensions: [],
    };
  }

  const classes = new Map(listClasses(workspaceId, { includeDisabled: true }).map((c) => [c.id, c]));

  // Required attributes per class, resolved once rather than per CI.
  const requiredByClass = new Map();
  const requiredFor = (classId) => {
    if (!classId) return [];
    if (!requiredByClass.has(classId)) {
      requiredByClass.set(classId, effectiveAttributes(workspaceId, classId).filter((a) => a.required));
    }
    return requiredByClass.get(classId);
  };

  // Every stored value, in one query.
  const valuesByCi = new Map();
  for (const row of db.prepare(
    `SELECT v.ci_id, a.attr_key, v.value FROM ci_attribute_values v
     JOIN ci_class_attributes a ON a.id = v.attribute_id
     JOIN assets ci ON ci.id = v.ci_id WHERE ci.workspace_id = ?`
  ).all(workspaceId)) {
    if (!valuesByCi.has(row.ci_id)) valuesByCi.set(row.ci_id, new Map());
    valuesByCi.get(row.ci_id).set(row.attr_key, row.value);
  }

  // Degree per CI, counting both directions -- a CI that only ever appears as
  // a dependency target is still connected.
  const degree = new Map();
  for (const row of db.prepare(
    `SELECT r.asset_id, r.related_asset_id FROM asset_relationships r
     JOIN assets a ON a.id = r.asset_id WHERE a.workspace_id = ?`
  ).all(workspaceId)) {
    degree.set(row.asset_id, (degree.get(row.asset_id) || 0) + 1);
    degree.set(row.related_asset_id, (degree.get(row.related_asset_id) || 0) + 1);
  }

  const lastSeen = new Map();
  for (const row of db.prepare(
    `SELECT v.ci_id, v.value FROM ci_attribute_values v
     JOIN ci_class_attributes a ON a.id = v.attribute_id
     JOIN assets ci ON ci.id = v.ci_id
     WHERE a.attr_key = 'last_seen_at' AND ci.workspace_id = ?`
  ).all(workspaceId)) {
    lastSeen.set(row.ci_id, row.value);
  }

  const staleBefore = new Date(Date.now() - staleDays * 86400000).toISOString().slice(0, 10);

  const incomplete = []; const orphaned = []; const ownerless = []; const stale = []; const unclassified = [];

  for (const ci of cis) {
    const cls = classes.get(ci.class_id) || resolveClass(workspaceId, ci);
    const label = { id: ci.id, tag: ci.tag, name: ci.name, ci_class: cls ? cls.label : null };

    if (!ci.class_id) unclassified.push(label);

    const required = requiredFor(cls?.id);
    const values = valuesByCi.get(ci.id) || new Map();
    const missing = required
      .filter((a) => {
        const v = values.get(a.attr_key);
        return v === undefined || v === null || String(v).trim() === '';
      })
      .map((a) => a.label);
    if (missing.length) incomplete.push({ ...label, missing });

    if (!degree.get(ci.id)) orphaned.push(label);
    if (!ci.owner_id) ownerless.push(label);

    // Only CIs that have EVER been seen by discovery are judged on staleness.
    // A hand-entered CI has no last_seen date and calling it stale would
    // punish the estate for not having discovery pointed at it yet.
    const seen = lastSeen.get(ci.id);
    if (seen && String(seen).slice(0, 10) < staleBefore) {
      stale.push({ ...label, last_seen_at: seen });
    }
  }

  const total = cis.length;
  const dimensions = [
    {
      key: 'completeness',
      label: 'Completeness',
      question: 'Do CIs have the fields their class says they must have?',
      score: pct(total - incomplete.length, total),
      failing: incomplete.length,
      total,
      items: incomplete.slice(0, limit),
      fix: 'Fill in the missing fields, or relax the requirement on the class if it is not really mandatory.',
    },
    {
      key: 'relationships',
      label: 'Relationships',
      question: 'Is each CI connected to anything? An isolated CI contributes nothing to impact analysis.',
      score: pct(total - orphaned.length, total),
      failing: orphaned.length,
      total,
      items: orphaned.slice(0, limit),
      fix: 'Map what each CI runs on or supports. This is what makes change risk and outage impact mean anything.',
    },
    {
      key: 'ownership',
      label: 'Ownership',
      question: 'Is somebody accountable for this CI?',
      score: pct(total - ownerless.length, total),
      failing: ownerless.length,
      total,
      items: ownerless.slice(0, limit),
      fix: 'Assign an owner, or check it out to the person actually holding it.',
    },
    {
      key: 'freshness',
      label: 'Freshness',
      question: `Has anything confirmed these CIs exist in the last ${staleDays} days?`,
      score: pct(total - stale.length, total),
      failing: stale.length,
      total,
      items: stale.slice(0, limit),
      fix: 'Check whether these still exist. A CI nothing has seen for months is usually kit that was decommissioned without anyone telling the CMDB.',
    },
  ];

  const score = Math.round(dimensions.reduce((sum, d) => sum + d.score * WEIGHTS[d.key], 0) * 10) / 10;

  return {
    scanned: total,
    score,
    grade: score >= 90 ? 'good' : score >= 70 ? 'fair' : score >= 50 ? 'poor' : 'critical',
    stale_days: staleDays,
    dimensions,
    unclassified: {
      count: unclassified.length,
      items: unclassified.slice(0, limit),
      // Not one of the four scored dimensions: a CI with no class predates the
      // model rather than failing it, and scoring it would make an upgrade
      // look like a regression.
      note: 'These CIs predate the class model. Assigning a class lets everything else be judged properly.',
    },
    // The single most useful sentence the report can produce.
    headline: headlineFor(dimensions, total),
  };
}

function headlineFor(dimensions, total) {
  const worst = [...dimensions].sort((a, b) => a.score - b.score)[0];
  if (worst.failing === 0) return `All ${total} CIs pass every check.`;
  return `${worst.failing} of ${total} CIs fail on ${worst.label.toLowerCase()} — the weakest dimension.`;
}

// A per-class breakdown, so "our servers are well kept and our applications
// are not" is visible rather than averaged away.
export function healthByClass(workspaceId, { staleDays = DEFAULT_STALE_DAYS } = {}) {
  const classes = listClasses(workspaceId, { includeDisabled: true });
  const counts = new Map(
    db.prepare('SELECT class_id, COUNT(*) c FROM assets WHERE workspace_id = ? AND class_id IS NOT NULL GROUP BY class_id')
      .all(workspaceId).map((r) => [r.class_id, r.c])
  );

  const report = healthReport(workspaceId, { staleDays, limit: 100000 });
  if (!report.dimensions.length) return [];

  const failingByClass = new Map();
  for (const dim of report.dimensions) {
    for (const item of dim.items) {
      const key = item.ci_class || 'Unclassified';
      if (!failingByClass.has(key)) failingByClass.set(key, new Set());
      failingByClass.get(key).add(item.id);
    }
  }

  return classes
    .filter((c) => (counts.get(c.id) || 0) > 0)
    .map((c) => {
      const total = counts.get(c.id) || 0;
      const failing = failingByClass.get(c.label)?.size || 0;
      return {
        id: c.id, key: c.key, label: c.label, color: c.color,
        total,
        clean: total - failing,
        score: pct(total - failing, total),
      };
    })
    .sort((a, b) => a.score - b.score);
}
