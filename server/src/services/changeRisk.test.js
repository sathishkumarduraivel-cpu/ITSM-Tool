import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  ensureDefaultRiskConfig, listRiskRules, listRiskBands,
  resolveSignals, scoreChange, bandForScore, saveAssessment, getAssessment,
} from './changeRisk.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

function newChange(workspaceId, fields = {}) {
  const id = uid('tkt');
  const f = {
    change_type: 'normal', priority: 'medium', impact: 'medium', category: 'Software',
    rollback_plan: 'restore snapshot', test_plan: 'smoke test',
    planned_start: null, planned_end: null, ...fields,
  };
  db.prepare(
    `INSERT INTO tickets (id, workspace_id, number, type, title, status, change_type, priority, impact, category,
       rollback_plan, test_plan, planned_start, planned_end)
     VALUES (?,?,?,'change','Risk test','open',?,?,?,?,?,?,?,?)`
  ).run(id, workspaceId, `CHG-${id.slice(-5)}`, f.change_type, f.priority, f.impact, f.category,
    f.rollback_plan, f.test_plan, f.planned_start, f.planned_end);
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}

let assetSeq = 0;
function newAsset(workspaceId, name = 'srv') {
  const id = uid('ast');
  assetSeq += 1;
  db.prepare('INSERT INTO assets (id, workspace_id, tag, name, type, status) VALUES (?,?,?,?,?,?)').run(
    id, workspaceId, `TAG-${assetSeq}`, `${name}-${assetSeq}`, 'server', 'active'
  );
  return id;
}

function linkAsset(ticketId, assetId) {
  db.prepare('INSERT INTO ticket_assets (id, ticket_id, asset_id) VALUES (?,?,?)').run(uid('ta'), ticketId, assetId);
}

// dependent depends on dependency: if dependency goes down, dependent is hit.
function dependsOn(dependentId, dependencyId) {
  db.prepare('INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type) VALUES (?,?,?,?)').run(
    uid('ar'), dependentId, dependencyId, 'depends_on'
  );
}

function clearRules(workspaceId) {
  ensureDefaultRiskConfig(workspaceId);
  db.prepare('DELETE FROM change_risk_rules WHERE workspace_id = ?').run(workspaceId);
}

function addRule(workspaceId, signal, operator, value, points, name = 'rule') {
  db.prepare(
    'INSERT INTO change_risk_rules (id, workspace_id, name, signal, operator, value, points) VALUES (?,?,?,?,?,?,?)'
  ).run(uid('crr'), workspaceId, name, signal, operator, value, points);
}

describe('changeRisk: default configuration', () => {
  test('rules and bands seed themselves on first read, idempotently', () => {
    const ws = newWorkspace();
    const rules = listRiskRules(ws);
    assert.ok(rules.length >= 10, `expected a default rule set, got ${rules.length}`);
    ensureDefaultRiskConfig(ws);
    ensureDefaultRiskConfig(ws);
    assert.equal(listRiskRules(ws).length, rules.length, 're-seeding must not duplicate');
  });

  test('the four bands exist in ascending threshold order', () => {
    const ws = newWorkspace();
    const bands = listRiskBands(ws);
    assert.deepEqual(bands.map((b) => b.band), ['low', 'medium', 'high', 'critical']);
    for (let i = 1; i < bands.length; i += 1) {
      assert.ok(bands[i].min_score > bands[i - 1].min_score);
    }
  });

  test('configuration is per workspace', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    clearRules(wsA);
    addRule(wsA, 'priority', 'equals', 'critical', 99, 'A-only');
    assert.ok(listRiskRules(wsA).some((r) => r.name === 'A-only'));
    assert.ok(!listRiskRules(wsB).some((r) => r.name === 'A-only'));
  });
});

describe('changeRisk: band boundaries', () => {
  test('a score lands in the highest band it reaches', () => {
    const ws = newWorkspace();
    // Defaults: low 0, medium 25, high 50, critical 80.
    assert.equal(bandForScore(ws, 0), 'low');
    assert.equal(bandForScore(ws, 24), 'low');
    assert.equal(bandForScore(ws, 25), 'medium', 'exactly at a threshold belongs to that band');
    assert.equal(bandForScore(ws, 49), 'medium');
    assert.equal(bandForScore(ws, 50), 'high');
    assert.equal(bandForScore(ws, 79), 'high');
    assert.equal(bandForScore(ws, 80), 'critical');
    assert.equal(bandForScore(ws, 5000), 'critical');
  });
});

describe('changeRisk: signal resolution', () => {
  test('counts affected CIs from the ticket_assets links', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    linkAsset(change.id, newAsset(ws));
    linkAsset(change.id, newAsset(ws));
    const signals = resolveSignals(ws, change);
    assert.equal(signals.affected_ci_count, 2);
  });

  // The addition the flow diagram does not have: a change to one CI that
  // many others depend on is not low risk.
  test('blast radius counts downstream CIs from the CMDB graph', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    const database = newAsset(ws, 'db');
    linkAsset(change.id, database);
    // Three services depend on the database, and one depends on a service.
    const app1 = newAsset(ws, 'app');
    const app2 = newAsset(ws, 'app');
    const app3 = newAsset(ws, 'app');
    dependsOn(app1, database);
    dependsOn(app2, database);
    dependsOn(app3, database);
    const report = newAsset(ws, 'report');
    dependsOn(report, app1);

    const signals = resolveSignals(ws, change);
    assert.ok(signals.blast_radius >= 4, `expected the multi-hop graph to be walked, got ${signals.blast_radius}`);
  });

  test('blast radius is zero when no CI is linked', () => {
    const ws = newWorkspace();
    assert.equal(resolveSignals(ws, newChange(ws)).blast_radius, 0);
  });

  // The second addition: do not change something that is already broken.
  test('counts open incidents on the affected CIs', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    const server = newAsset(ws, 'srv');
    linkAsset(change.id, server);

    const openIncident = uid('tkt');
    db.prepare(`INSERT INTO tickets (id, workspace_id, number, type, title, status) VALUES (?,?,?,'incident','Disk full','open')`)
      .run(openIncident, ws, 'INC-9001');
    linkAsset(openIncident, server);

    const closedIncident = uid('tkt');
    db.prepare(`INSERT INTO tickets (id, workspace_id, number, type, title, status) VALUES (?,?,?,'incident','Old','closed')`)
      .run(closedIncident, ws, 'INC-9002');
    linkAsset(closedIncident, server);

    const signals = resolveSignals(ws, change);
    assert.equal(signals.open_incidents_on_ci, 1, 'only the open one counts');
  });

  test('plan presence is reported as booleans, blank-safe', () => {
    const ws = newWorkspace();
    const withPlans = resolveSignals(ws, newChange(ws));
    assert.equal(withPlans.has_backout_plan, true);
    assert.equal(withPlans.has_test_plan, true);

    const without = resolveSignals(ws, newChange(ws, { rollback_plan: '   ', test_plan: '' }));
    assert.equal(without.has_backout_plan, false, 'whitespace is not a plan');
    assert.equal(without.has_test_plan, false);
  });

  test('window duration and lead time are derived from the planned window', () => {
    const ws = newWorkspace();
    const start = new Date(Date.now() + 72 * 3600000).toISOString();
    const end = new Date(Date.now() + 78 * 3600000).toISOString();
    const signals = resolveSignals(ws, newChange(ws, { planned_start: start, planned_end: end }));
    assert.ok(Math.abs(signals.window_duration_hours - 6) < 0.1, `got ${signals.window_duration_hours}`);
    assert.ok(signals.lead_time_hours > 70 && signals.lead_time_hours < 74, `got ${signals.lead_time_hours}`);
  });

  test('an inverted or missing window yields zero rather than a negative', () => {
    const ws = newWorkspace();
    const inverted = resolveSignals(ws, newChange(ws, {
      planned_start: '2026-12-02T00:00:00.000Z', planned_end: '2026-12-01T00:00:00.000Z',
    }));
    assert.equal(inverted.window_duration_hours, 0);
    assert.equal(resolveSignals(ws, newChange(ws)).window_duration_hours, 0);
  });
});

describe('changeRisk: scoring', () => {
  test('only matching rules contribute, and each contribution is explained', () => {
    const ws = newWorkspace();
    clearRules(ws);
    addRule(ws, 'priority', 'equals', 'critical', 25, 'Critical priority');
    addRule(ws, 'impact', 'equals', 'high', 20, 'High impact');

    const result = scoreChange(ws, newChange(ws, { priority: 'critical', impact: 'medium' }));
    assert.equal(result.score, 25);
    assert.equal(result.contributions.length, 1);
    assert.equal(result.contributions[0].rule, 'Critical priority');
    assert.equal(result.contributions[0].points, 25);
    assert.equal(result.contributions[0].signal_value, 'critical');
  });

  test('points accumulate across rules and set the band', () => {
    const ws = newWorkspace();
    clearRules(ws);
    addRule(ws, 'priority', 'equals', 'critical', 25);
    addRule(ws, 'impact', 'equals', 'high', 20);
    addRule(ws, 'change_type', 'equals', 'emergency', 30);

    const result = scoreChange(ws, newChange(ws, { priority: 'critical', impact: 'high', change_type: 'emergency' }));
    assert.equal(result.score, 75);
    assert.equal(result.band, 'high');
  });

  test('gte and lte operators work on numeric signals', () => {
    const ws = newWorkspace();
    clearRules(ws);
    addRule(ws, 'affected_ci_count', 'gte', '3', 10, 'Several CIs');

    const change = newChange(ws);
    linkAsset(change.id, newAsset(ws));
    linkAsset(change.id, newAsset(ws));
    assert.equal(scoreChange(ws, change).score, 0, 'two CIs does not reach the threshold of three');

    linkAsset(change.id, newAsset(ws));
    assert.equal(scoreChange(ws, change).score, 10, 'three does');
  });

  test('boolean signals match on the strings true and false', () => {
    const ws = newWorkspace();
    clearRules(ws);
    addRule(ws, 'has_backout_plan', 'equals', 'false', 25, 'No backout plan');

    assert.equal(scoreChange(ws, newChange(ws, { rollback_plan: '' })).score, 25);
    assert.equal(scoreChange(ws, newChange(ws, { rollback_plan: 'restore' })).score, 0);
  });

  test('a negative rule cannot drive the score below zero', () => {
    const ws = newWorkspace();
    clearRules(ws);
    addRule(ws, 'change_type', 'equals', 'standard', -50, 'Standard discount');
    const result = scoreChange(ws, newChange(ws, { change_type: 'standard' }));
    assert.equal(result.score, 0);
    assert.equal(result.band, 'low');
  });

  test('a disabled rule does not contribute', () => {
    const ws = newWorkspace();
    clearRules(ws);
    addRule(ws, 'priority', 'equals', 'critical', 40, 'Off');
    db.prepare('UPDATE change_risk_rules SET enabled = 0 WHERE workspace_id = ?').run(ws);
    assert.equal(scoreChange(ws, newChange(ws, { priority: 'critical' })).score, 0);
  });

  test('no rules configured scores zero rather than throwing', () => {
    const ws = newWorkspace();
    clearRules(ws);
    const result = scoreChange(ws, newChange(ws, { priority: 'critical' }));
    assert.equal(result.score, 0);
    assert.equal(result.band, 'low');
    assert.deepEqual(result.contributions, []);
  });

  test('scoring is deterministic across repeated runs', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { priority: 'critical', impact: 'high', change_type: 'emergency', rollback_plan: '' });
    linkAsset(change.id, newAsset(ws));
    const first = scoreChange(ws, change);
    for (let i = 0; i < 5; i += 1) {
      const again = scoreChange(ws, change);
      assert.equal(again.score, first.score);
      assert.equal(again.band, first.band);
      assert.deepEqual(again.contributions, first.contributions);
    }
  });

  test('the freeze-window signal is supplied by the caller', () => {
    const ws = newWorkspace();
    clearRules(ws);
    addRule(ws, 'in_freeze_window', 'equals', 'true', 30, 'In freeze');
    const change = newChange(ws);
    assert.equal(scoreChange(ws, change).score, 0);
    assert.equal(scoreChange(ws, change, { inFreezeWindow: true }).score, 30);
  });

  test('the default rule set rates a reckless emergency change far above a standard one', () => {
    const ws = newWorkspace();
    const reckless = newChange(ws, {
      change_type: 'emergency', priority: 'critical', impact: 'high', rollback_plan: '', test_plan: '',
    });
    const routine = newChange(ws, { change_type: 'standard', priority: 'low', impact: 'low' });

    const recklessResult = scoreChange(ws, reckless);
    const routineResult = scoreChange(ws, routine);
    assert.ok(recklessResult.score > routineResult.score);
    assert.ok(['high', 'critical'].includes(recklessResult.band), `got ${recklessResult.band}`);
    assert.equal(routineResult.band, 'low');
  });
});

describe('changeRisk: persistence', () => {
  test('saving an assessment stamps the ticket and keeps the breakdown', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { priority: 'critical' });
    const assessment = scoreChange(ws, change);
    saveAssessment(ws, change.id, assessment);

    const ticket = db.prepare('SELECT risk_score, risk_band FROM tickets WHERE id = ?').get(change.id);
    assert.equal(ticket.risk_score, assessment.score);
    assert.equal(ticket.risk_band, assessment.band);

    const stored = getAssessment(change.id);
    assert.equal(stored.score, assessment.score);
    assert.ok(Array.isArray(stored.contributions));
    assert.deepEqual(stored.advisory, [], 'no AI advisory by default');
    assert.equal(stored.ai_used, false);
  });

  test('re-assessing updates in place rather than accumulating rows', () => {
    const ws = newWorkspace();
    const change = newChange(ws, { priority: 'low' });
    saveAssessment(ws, change.id, scoreChange(ws, change));

    db.prepare("UPDATE tickets SET priority = 'critical' WHERE id = ?").run(change.id);
    const updated = db.prepare('SELECT * FROM tickets WHERE id = ?').get(change.id);
    saveAssessment(ws, change.id, scoreChange(ws, updated));

    const { c } = db.prepare('SELECT COUNT(*) c FROM change_risk_assessments WHERE ticket_id = ?').get(change.id);
    assert.equal(c, 1);
    assert.ok(getAssessment(change.id).score > 0);
  });

  test('Sona advisory findings are stored alongside but never alter the score', () => {
    const ws = newWorkspace();
    const change = newChange(ws);
    const assessment = scoreChange(ws, change);
    const advisory = {
      findings: [{ severity: 'warning', area: 'backout', message: 'The backout plan has no verification step.' }],
      aiUsed: true,
    };
    saveAssessment(ws, change.id, assessment, advisory);

    const stored = getAssessment(change.id);
    assert.equal(stored.score, assessment.score, 'advice must not move the number');
    assert.equal(stored.ai_used, true);
    assert.equal(stored.advisory.length, 1);
    assert.equal(stored.advisory[0].area, 'backout');
  });

  test('getAssessment returns null for a change never assessed', () => {
    const ws = newWorkspace();
    assert.equal(getAssessment(newChange(ws).id), null);
  });
});
