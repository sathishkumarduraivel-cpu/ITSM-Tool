import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  ingestAlert, normalizePayload, normalizeSeverity, isResolutionSignal,
  computeDedupeKey, resolveFieldMap, acknowledgeAlert, resolveAlert, alertEvents,
} from './alertIngest.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

function newSource(workspaceId, opts = {}) {
  const {
    source_type = 'generic', default_severity = 'medium',
    dedupe_window_minutes = 60, max_per_minute = 0, enabled = 1, field_map = null,
    name = 'Test source',
  } = opts;
  const id = uid('alsrc');
  db.prepare(
    `INSERT INTO alert_sources (id, workspace_id, name, source_type, webhook_secret, field_map, default_severity, dedupe_window_minutes, max_per_minute, enabled)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, workspaceId, name, source_type, 'secret-' + id, field_map, default_severity, dedupe_window_minutes, max_per_minute, enabled);
  return db.prepare('SELECT * FROM alert_sources WHERE id = ?').get(id);
}

describe('alertIngest: severity normalization', () => {
  test('maps each vendor vocabulary onto our five levels', () => {
    assert.equal(normalizeSeverity('CRITICAL'), 'critical');
    assert.equal(normalizeSeverity('disaster'), 'critical');   // Zabbix
    assert.equal(normalizeSeverity('error'), 'high');
    assert.equal(normalizeSeverity('warning'), 'medium');      // Prometheus/Nagios
    assert.equal(normalizeSeverity('average'), 'medium');      // Zabbix
    assert.equal(normalizeSeverity('minor'), 'low');
    assert.equal(normalizeSeverity('alerting'), 'high');       // Grafana
  });

  test('an unrecognized severity falls back to the source default, not a guess', () => {
    assert.equal(normalizeSeverity('purple', 'low'), 'low');
    assert.equal(normalizeSeverity(undefined, 'critical'), 'critical');
    assert.equal(normalizeSeverity('', 'high'), 'high');
  });

  test('a nonsense fallback still yields a valid level', () => {
    assert.equal(normalizeSeverity('purple', 'not-a-severity'), 'medium');
  });
});

describe('alertIngest: recovery detection', () => {
  test('recognizes the common recovery tokens', () => {
    for (const token of ['ok', 'OK', 'resolved', 'Recovery', 'up', 'normal', 'cleared']) {
      assert.equal(isResolutionSignal(token), true, `${token} should read as a recovery`);
    }
  });

  test('does not treat a firing or empty status as a recovery', () => {
    for (const token of ['firing', 'alerting', 'problem', 'critical', '', null, undefined]) {
      assert.equal(isResolutionSignal(token), false, `${JSON.stringify(token)} must not read as a recovery`);
    }
  });
});

describe('alertIngest: payload normalization', () => {
  test('reads a Prometheus-shaped payload through its preset, including dotted paths', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { source_type: 'prometheus' });
    const normalized = normalizePayload(source, {
      labels: { alertname: 'HighMemory', severity: 'critical', instance: 'web-01:9100' },
      annotations: { description: 'Memory above 95% for 10 minutes' },
      fingerprint: 'abc123',
      status: 'firing',
    });
    assert.equal(normalized.title, 'HighMemory');
    assert.equal(normalized.severity, 'critical');
    assert.equal(normalized.entity, 'web-01:9100');
    assert.equal(normalized.description, 'Memory above 95% for 10 minutes');
    assert.equal(normalized.dedupeKey, 'k:abc123', 'an explicit vendor key should be preferred');
  });

  test('a custom field_map overrides the preset for just the fields it names', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { source_type: 'generic', field_map: JSON.stringify({ title: 'incident.subject' }) });
    const map = resolveFieldMap(source);
    assert.equal(map.title, 'incident.subject');
    assert.equal(map.entity, 'entity', 'unnamed fields keep the preset path');

    const normalized = normalizePayload(source, { incident: { subject: 'Disk full' }, entity: 'db-02' });
    assert.equal(normalized.title, 'Disk full');
    assert.equal(normalized.entity, 'db-02');
  });

  test('a malformed field_map falls back to the preset instead of breaking ingestion', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { source_type: 'generic', field_map: 'not json{{{' });
    const normalized = normalizePayload(source, { title: 'Still works' });
    assert.equal(normalized.title, 'Still works');
  });

  test('a payload with no recognizable title is still ingestable', () => {
    const ws = newWorkspace();
    const source = newSource(ws);
    const normalized = normalizePayload(source, { something: 'unexpected' });
    assert.equal(normalized.title, 'Untitled alert');
  });

  test('without a vendor key, the same host and title hash to one key and a different host to another', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { source_type: 'nagios' }); // preset has no dedupe_key path
    const map = resolveFieldMap(source);
    const keyFor = (host) => {
      const normalized = { title: 'CPU high', entity: host };
      return computeDedupeKey(source, {}, map, normalized);
    };
    assert.equal(keyFor('web-01'), keyFor('web-01'));
    assert.notEqual(keyFor('web-01'), keyFor('web-02'));
    assert.match(keyFor('web-01'), /^h:/);
  });
});

describe('alertIngest: deduplication', () => {
  test('a repeated alert inside the window bumps the occurrence count instead of creating another', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { dedupe_window_minutes: 60 });
    const payload = { title: 'Disk full', entity: 'db-01', severity: 'high' };

    const first = ingestAlert(source, payload);
    assert.equal(first.action, 'created');

    const second = ingestAlert(source, payload);
    assert.equal(second.action, 'deduped');
    assert.equal(second.alertId, first.alertId);
    assert.equal(second.occurrenceCount, 2);

    const third = ingestAlert(source, payload);
    assert.equal(third.occurrenceCount, 3);

    const { c } = db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(ws);
    assert.equal(c, 1, 'three identical notifications must produce exactly one alert');
  });

  test('two different entities are never deduped together', () => {
    const ws = newWorkspace();
    const source = newSource(ws);
    ingestAlert(source, { title: 'Disk full', entity: 'db-01' });
    ingestAlert(source, { title: 'Disk full', entity: 'db-02' });
    const { c } = db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(ws);
    assert.equal(c, 2);
  });

  test('a zero-length dedupe window means every notification is its own alert', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { dedupe_window_minutes: 0 });
    ingestAlert(source, { title: 'Flap', entity: 'sw-01' });
    ingestAlert(source, { title: 'Flap', entity: 'sw-01' });
    const { c } = db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(ws);
    assert.equal(c, 2);
  });

  test('a resolved alert is not revived — the problem returning is a new alert', () => {
    const ws = newWorkspace();
    const source = newSource(ws);
    const first = ingestAlert(source, { title: 'Disk full', entity: 'db-01' });
    resolveAlert(first.alertId, ws, null);

    const second = ingestAlert(source, { title: 'Disk full', entity: 'db-01' });
    assert.equal(second.action, 'created');
    assert.notEqual(second.alertId, first.alertId);
  });

  test('an acknowledged alert still dedupes, since the problem is the same one', () => {
    const ws = newWorkspace();
    const source = newSource(ws);
    const first = ingestAlert(source, { title: 'Disk full', entity: 'db-01' });
    acknowledgeAlert(first.alertId, ws, null);

    const second = ingestAlert(source, { title: 'Disk full', entity: 'db-01' });
    assert.equal(second.action, 'deduped');
    assert.equal(second.alertId, first.alertId);
  });

  test('alerts never dedupe across workspaces', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    const sourceA = newSource(wsA);
    const sourceB = newSource(wsB);
    // Identical explicit keys, different workspaces.
    ingestAlert(sourceA, { title: 'Shared', dedupe_key: 'same-key' });
    ingestAlert(sourceB, { title: 'Shared', dedupe_key: 'same-key' });

    assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(wsA).c, 1);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(wsB).c, 1);
  });
});

describe('alertIngest: recovery and lifecycle', () => {
  test('a recovery notification resolves the matching open alert', () => {
    const ws = newWorkspace();
    const source = newSource(ws);
    const created = ingestAlert(source, { title: 'Host down', entity: 'web-01', status: 'firing' });
    assert.equal(created.action, 'created');

    const recovery = ingestAlert(source, { title: 'Host down', entity: 'web-01', status: 'resolved' });
    assert.equal(recovery.action, 'resolved');
    assert.equal(recovery.alertId, created.alertId);

    const row = db.prepare('SELECT status, resolved_at FROM alerts WHERE id = ?').get(created.alertId);
    assert.equal(row.status, 'resolved');
    assert.ok(row.resolved_at);
  });

  test('a recovery for something we never saw open is ignored rather than opening an alert', () => {
    const ws = newWorkspace();
    const source = newSource(ws);
    const result = ingestAlert(source, { title: 'Never fired', entity: 'ghost', status: 'ok' });
    assert.equal(result.action, 'ignored_recovery');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(ws).c, 0);
  });

  test('a disabled source accepts nothing', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { enabled: 0 });
    const result = ingestAlert(source, { title: 'Ignored' });
    assert.equal(result.accepted, false);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(ws).c, 0);
  });

  test('every state change leaves an event trail', () => {
    const ws = newWorkspace();
    const source = newSource(ws);
    const { alertId } = ingestAlert(source, { title: 'Trail', entity: 'x' });
    ingestAlert(source, { title: 'Trail', entity: 'x' });
    acknowledgeAlert(alertId, ws, null);
    resolveAlert(alertId, ws, null);

    const events = alertEvents(alertId).map((e) => e.event);
    assert.ok(events.includes('received'));
    assert.ok(events.includes('deduped'));
    assert.ok(events.includes('acknowledged'));
    assert.ok(events.includes('resolved'));
  });

  test('acknowledging a resolved alert does not reopen it', () => {
    const ws = newWorkspace();
    const source = newSource(ws);
    const { alertId } = ingestAlert(source, { title: 'Closed already', entity: 'x' });
    resolveAlert(alertId, ws, null);
    acknowledgeAlert(alertId, ws, null);
    assert.equal(db.prepare('SELECT status FROM alerts WHERE id = ?').get(alertId).status, 'resolved');
  });
});

describe('alertIngest: flood protection', () => {
  test('a source past its per-minute cap stops creating new alerts', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { max_per_minute: 3, dedupe_window_minutes: 0 });

    const actions = [];
    for (let i = 0; i < 6; i += 1) {
      // Distinct entities so dedupe never absorbs them -- this isolates the
      // rate cap from the dedupe behaviour tested above.
      actions.push(ingestAlert(source, { title: 'Storm', entity: `host-${i}` }).action);
    }
    assert.ok(actions.includes('rate_limited'), `expected the cap to engage, got ${JSON.stringify(actions)}`);
    const created = db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(ws).c;
    assert.ok(created <= 3, `cap of 3 should not be exceeded, got ${created}`);
  });

  test('a cap of zero means unlimited', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { max_per_minute: 0, dedupe_window_minutes: 0 });
    for (let i = 0; i < 5; i += 1) ingestAlert(source, { title: 'Fine', entity: `h-${i}` });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM alerts WHERE workspace_id = ?').get(ws).c, 5);
  });

  test('deduped repeats still count toward the cap, since the write cost is what is being limited', () => {
    const ws = newWorkspace();
    const source = newSource(ws, { max_per_minute: 2, dedupe_window_minutes: 60 });
    ingestAlert(source, { title: 'Same', entity: 'h1' });      // received
    ingestAlert(source, { title: 'Same', entity: 'h1' });      // deduped
    const third = ingestAlert(source, { title: 'Other', entity: 'h2' });
    assert.equal(third.action, 'rate_limited');
  });
});
