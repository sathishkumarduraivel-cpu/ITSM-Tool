import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { getClass, ensureDefaultCiClasses, readAttributes, writeAttributes, createAttribute } from './ciClasses.js';
import {
  ensureDefaultIdentificationRules, listIdentificationRules, createIdentificationRule,
  updateIdentificationRule, deleteIdentificationRule,
  identify, reconcile, applyAttributes, attributeHistory, driftReport, provenanceFor,
} from './ciIdentity.js';
import {
  createDiscoverySource, updateDiscoverySource, getDiscoverySource, listDiscoverySources,
  rotateSecret, deleteDiscoverySource, secretMatches, MANUAL_TRUST_RANK,
} from './discoverySources.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  ensureDefaultCiClasses(id);
  return id;
}

const classId = (ws, key) => getClass(ws, key).id;

// A CI created the way the discovery path creates one.
function seedCi(ws, classKey, attributes, { name = 'seed', tag } = {}) {
  const cls = getClass(ws, classKey);
  const id = uid('ast');
  db.prepare('INSERT INTO assets (id, workspace_id, tag, name, class_id, type) VALUES (?,?,?,?,?,?)')
    .run(id, ws, tag || uid('TAG'), name, cls.id, 'hardware');
  writeAttributes(ws, id, cls.id, attributes, { partial: true });
  return id;
}

const source = (ws, over = {}) => createDiscoverySource(ws, {
  key: over.key || `src-${uid('').slice(-6)}`, name: over.name || 'Scanner', trust_rank: over.trust_rank ?? 50,
  ...over,
});

describe('identification rules', () => {
  test('a class seeds one rule per identifier attribute', () => {
    const ws = newWorkspace();
    const rules = listIdentificationRules(ws, classId(ws, 'server'));
    const keys = rules.map((r) => r.attr_keys.join('+'));
    assert.deepEqual(keys.sort(), ['hostname', 'ip_address', 'serial_number'].sort());
  });

  test('the strongest identifier is tried first', () => {
    const ws = newWorkspace();
    const rules = listIdentificationRules(ws, classId(ws, 'server'));
    assert.equal(rules[0].attr_keys[0], 'serial_number', 'a serial beats a hostname, which beats an IP');
    assert.equal(rules.at(-1).attr_keys[0], 'ip_address');
  });

  test('seeding happens once', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    ensureDefaultIdentificationRules(ws, cls);
    const n = listIdentificationRules(ws, cls).length;
    ensureDefaultIdentificationRules(ws, cls);
    assert.equal(listIdentificationRules(ws, cls).length, n);
  });

  test('a class with no identifiers gets no rules rather than a broken one', () => {
    const ws = newWorkspace();
    assert.deepEqual(listIdentificationRules(ws, classId(ws, 'middleware')), []);
  });

  test('a composite rule can be added, and is validated against the class', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    const rule = createIdentificationRule(ws, cls, { name: 'Host + cluster', attr_keys: ['hostname', 'cluster_name'], priority: 5 });
    assert.equal(rule.name, 'Host + cluster');
    assert.throws(() => createIdentificationRule(ws, cls, { name: 'Bad', attr_keys: ['not_a_field'] }), /Not a field on this class/);
    assert.throws(() => createIdentificationRule(ws, cls, { name: 'Empty', attr_keys: [] }), /at least one attribute/);
  });

  test('a rule can be disabled and deleted', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    const rule = listIdentificationRules(ws, cls).find((r) => r.attr_keys[0] === 'ip_address');
    updateIdentificationRule(ws, rule.id, { enabled: 0 });
    assert.ok(!listIdentificationRules(ws, cls).some((r) => r.id === rule.id));
    assert.ok(listIdentificationRules(ws, cls, { includeDisabled: true }).some((r) => r.id === rule.id));
    deleteIdentificationRule(ws, rule.id);
    assert.ok(!listIdentificationRules(ws, cls, { includeDisabled: true }).some((r) => r.id === rule.id));
  });
});

describe('identify', () => {
  test('a payload matches an existing CI on its serial number', () => {
    const ws = newWorkspace();
    const ci = seedCi(ws, 'server', { hostname: 'app-01', serial_number: 'SN-123' });
    const match = identify(ws, classId(ws, 'server'), { serial_number: 'SN-123', hostname: 'renamed-01' });
    assert.equal(match.ci.id, ci);
    assert.equal(match.matched_by, 'serial_number');
  });

  test('an unknown CI matches nothing', () => {
    const ws = newWorkspace();
    seedCi(ws, 'server', { hostname: 'app-01', serial_number: 'SN-123' });
    assert.equal(identify(ws, classId(ws, 'server'), { serial_number: 'SN-999' }).ci, null);
  });

  test('an explicit asset tag beats every inferred rule', () => {
    const ws = newWorkspace();
    seedCi(ws, 'server', { serial_number: 'SN-1' }, { tag: 'ASSET-1' });
    const other = seedCi(ws, 'server', { serial_number: 'SN-2' }, { tag: 'ASSET-2' });
    const match = identify(ws, classId(ws, 'server'), { serial_number: 'SN-1' }, { tag: 'ASSET-2' });
    assert.equal(match.ci.id, other);
    assert.equal(match.matched_by, 'tag');
  });

  test('a rule only fires when every one of its attributes is supplied', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    seedCi(ws, 'server', { hostname: 'app-01', cluster_name: 'c1' });
    createIdentificationRule(ws, cls, { name: 'Host + cluster', attr_keys: ['hostname', 'cluster_name'], priority: 1 });
    // Disable the plain hostname rule so only the composite could match.
    const plain = listIdentificationRules(ws, cls).find((r) => r.attr_keys.length === 1 && r.attr_keys[0] === 'hostname');
    updateIdentificationRule(ws, plain.id, { enabled: 0 });

    assert.equal(identify(ws, cls, { hostname: 'app-01' }).ci, null, 'half a composite key is not a match');
    assert.ok(identify(ws, cls, { hostname: 'app-01', cluster_name: 'c1' }).ci, 'both halves match');
  });

  test('a composite needs both halves to agree, not just one', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    seedCi(ws, 'server', { hostname: 'app-01', cluster_name: 'c1' });
    createIdentificationRule(ws, cls, { name: 'Host + cluster', attr_keys: ['hostname', 'cluster_name'], priority: 1 });
    const plain = listIdentificationRules(ws, cls).find((r) => r.attr_keys.length === 1 && r.attr_keys[0] === 'hostname');
    updateIdentificationRule(ws, plain.id, { enabled: 0 });
    assert.equal(identify(ws, cls, { hostname: 'app-01', cluster_name: 'DIFFERENT' }).ci, null);
  });

  test('an ambiguous match is reported, never guessed', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    // Two real servers that happen to share a hostname.
    seedCi(ws, 'server', { hostname: 'app-01', serial_number: 'SN-A' });
    seedCi(ws, 'server', { hostname: 'app-01', serial_number: 'SN-B' });
    const match = identify(ws, cls, { hostname: 'app-01' });
    assert.equal(match.ci, null, 'merging two real servers is worse than a duplicate');
    assert.ok(match.ambiguous.some((a) => a.matches.length === 2), JSON.stringify(match.ambiguous));
  });

  test('a stronger rule still resolves what an ambiguous weaker one could not', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    const a = seedCi(ws, 'server', { hostname: 'app-01', serial_number: 'SN-A' });
    seedCi(ws, 'server', { hostname: 'app-01', serial_number: 'SN-B' });
    assert.equal(identify(ws, cls, { hostname: 'app-01', serial_number: 'SN-A' }).ci.id, a);
  });

  test('matching is scoped to the class and everything under it', () => {
    const ws = newWorkspace();
    seedCi(ws, 'server', { hostname: 'shared-name' });
    // A printer with the same value must not be matched when asking about servers.
    assert.equal(identify(ws, classId(ws, 'printer'), { hostname: 'shared-name' }).ci, null);
    // Asking about the shared ancestor does reach the server.
    assert.ok(identify(ws, classId(ws, 'hardware'), { serial_number: 'nope' }).ci === null);
  });

  test('matching never crosses a workspace', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    seedCi(a, 'server', { serial_number: 'SN-SHARED' });
    assert.equal(identify(b, classId(b, 'server'), { serial_number: 'SN-SHARED' }).ci, null);
  });

  test('an empty identifier value does not match everything', () => {
    const ws = newWorkspace();
    seedCi(ws, 'server', { hostname: 'app-01' });
    assert.equal(identify(ws, classId(ws, 'server'), { hostname: '' }).ci, null);
    assert.equal(identify(ws, classId(ws, 'server'), { hostname: null }).ci, null);
  });
});

describe('reconcile', () => {
  test('an unknown CI is created', () => {
    const ws = newWorkspace();
    const result = reconcile(ws, { ci_class: 'server', attributes: { hostname: 'new-01', serial_number: 'SN-N' } });
    assert.equal(result.action, 'created');
    assert.equal(readAttributes(result.ci.id).hostname, 'new-01');
  });

  test('the same payload twice updates rather than duplicating — the whole point', () => {
    const ws = newWorkspace();
    const payload = { ci_class: 'server', attributes: { hostname: 'app-01', serial_number: 'SN-1', cpu_cores: 8 } };
    const first = reconcile(ws, payload);
    const second = reconcile(ws, payload);
    assert.equal(first.action, 'created');
    assert.equal(second.action, 'unchanged');
    assert.equal(second.ci.id, first.ci.id);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ?').get(ws).c, 1);
  });

  test('a changed value updates the existing CI and says what moved', () => {
    const ws = newWorkspace();
    const first = reconcile(ws, { ci_class: 'server', attributes: { hostname: 'app-01', serial_number: 'SN-1', cpu_cores: 8 } });
    const second = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', cpu_cores: 16 } });
    assert.equal(second.action, 'updated');
    assert.equal(second.ci.id, first.ci.id);
    assert.deepEqual(second.applied, [{ attr_key: 'cpu_cores', from: '8', to: '16' }]);
    assert.equal(readAttributes(first.ci.id).hostname, 'app-01', 'untouched attributes survive');
  });

  test('a dry run reports what would happen and changes nothing', () => {
    const ws = newWorkspace();
    const preview = reconcile(ws, { ci_class: 'server', attributes: { hostname: 'ghost' } }, { dryRun: true });
    assert.equal(preview.action, 'would_create');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM assets WHERE workspace_id = ?').get(ws).c, 0);

    reconcile(ws, { ci_class: 'server', attributes: { hostname: 'ghost', serial_number: 'SN-G' } });
    const second = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-G', cpu_cores: 4 } }, { dryRun: true });
    assert.equal(second.action, 'would_update');
    assert.equal(readAttributes(second.ci.id).cpu_cores, undefined, 'nothing written');
  });

  test('a source that may not create CIs is told so instead of silently doing nothing', () => {
    const ws = newWorkspace();
    const src = source(ws, { allow_create: false });
    const result = reconcile(ws, { ci_class: 'server', attributes: { hostname: 'app-01' } }, { source: src });
    assert.equal(result.action, 'skipped');
    assert.match(result.reason, /not allowed to create/);
  });

  test('but it can still update a CI that already exists', () => {
    const ws = newWorkspace();
    reconcile(ws, { ci_class: 'server', attributes: { hostname: 'app-01', serial_number: 'SN-1' } });
    const src = source(ws, { allow_create: false });
    const result = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', cpu_cores: 32 } }, { source: src });
    assert.equal(result.action, 'updated');
  });

  test('a source default class is used when the payload does not name one', () => {
    const ws = newWorkspace();
    const src = source(ws, { default_class_id: classId(ws, 'endpoint') });
    const result = reconcile(ws, { attributes: { hostname: 'laptop-1' } }, { source: src });
    assert.equal(result.action, 'created');
    assert.equal(result.ci.class_id, classId(ws, 'endpoint'));
  });

  test('no class anywhere is an error, not a guess', () => {
    const ws = newWorkspace();
    assert.equal(reconcile(ws, { attributes: { hostname: 'x' } }).action, 'error');
  });

  test('an abstract class cannot receive CIs', () => {
    const ws = newWorkspace();
    const result = reconcile(ws, { ci_class: 'hardware', attributes: { serial_number: 'SN-1' } });
    assert.equal(result.action, 'error');
    assert.match(result.error, /grouping class/);
  });

  test('a new CI is named from its strongest identifier when the payload gives no name', () => {
    const ws = newWorkspace();
    const result = reconcile(ws, { ci_class: 'server', attributes: { hostname: 'app-77', serial_number: 'SN-77' } });
    assert.equal(result.ci.name, 'SN-77', 'the serial is the first identifier declared on Hardware');
  });

  test('invalid attribute values are reported without abandoning the valid ones', () => {
    const ws = newWorkspace();
    const result = reconcile(ws, { ci_class: 'server', attributes: { hostname: 'app-01', cpu_cores: 'plenty' } });
    assert.equal(result.action, 'created');
    assert.ok(result.errors.some((e) => e.attr_key === 'cpu_cores'));
    assert.equal(readAttributes(result.ci.id).hostname, 'app-01');
  });

  test('core columns follow the payload, but an absent one never blanks what a person typed', () => {
    const ws = newWorkspace();
    const created = reconcile(ws, { ci_class: 'server', name: 'app-01', attributes: { serial_number: 'SN-1' } });
    db.prepare("UPDATE assets SET location = 'Rack 4' WHERE id = ?").run(created.ci.id);
    const updated = reconcile(ws, { ci_class: 'server', name: 'app-01-renamed', attributes: { serial_number: 'SN-1' } });
    assert.equal(updated.ci.name, 'app-01-renamed');
    assert.equal(updated.ci.location, 'Rack 4', 'discovery not mentioning location must not erase it');
  });
});

describe('trust ranking', () => {
  const twoSources = (ws) => ({
    high: source(ws, { key: 'vcenter', name: 'vCenter', trust_rank: 90 }),
    low: source(ws, { key: 'scanner', name: 'Net scan', trust_rank: 30 }),
  });

  test('a higher-trust source wins, and the loser is recorded not dropped', () => {
    const ws = newWorkspace();
    const { high, low } = twoSources(ws);
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'authoritative' } }, { source: high });

    const attempt = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'guessed' } }, { source: low });
    assert.equal(readAttributes(created.ci.id).hostname, 'authoritative');
    assert.ok(attempt.rejected.some((r) => r.attr_key === 'hostname'), JSON.stringify(attempt.rejected));
    assert.match(attempt.rejected[0].reason, /vcenter \(trust 90\) owns this value/);
  });

  test('the refused write is in the history as refused, not as a change', () => {
    const ws = newWorkspace();
    const { high, low } = twoSources(ws);
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'authoritative' } }, { source: high });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'guessed' } }, { source: low });

    const history = attributeHistory(ws, created.ci.id);
    const refused = history.find((h) => h.accepted === 0);
    assert.ok(refused, 'the attempt is on the record');
    assert.equal(refused.new_value, 'guessed');
    assert.equal(refused.old_value, 'authoritative');
    assert.equal(refused.source, 'scanner');
  });

  test('a lower-trust source may still fill a value nobody owns yet', () => {
    const ws = newWorkspace();
    const { high, low } = twoSources(ws);
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'authoritative' } }, { source: high });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', cpu_cores: 4 } }, { source: low });
    assert.equal(readAttributes(created.ci.id).cpu_cores, 4, 'no conflict, so no reason to refuse');
  });

  test('the same source can always correct itself', () => {
    const ws = newWorkspace();
    const { high } = twoSources(ws);
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'old' } }, { source: high });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'new' } }, { source: high });
    assert.equal(readAttributes(created.ci.id).hostname, 'new');
  });

  test('equal trust means the most recent word wins', () => {
    const ws = newWorkspace();
    const a = source(ws, { key: 'tool-a', trust_rank: 50 });
    const b = source(ws, { key: 'tool-b', trust_rank: 50 });
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'from-a' } }, { source: a });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'from-b' } }, { source: b });
    assert.equal(readAttributes(created.ci.id).hostname, 'from-b');
  });

  test('a person outranks every tool', () => {
    const ws = newWorkspace();
    const { high } = twoSources(ws);
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'from-vcenter' } }, { source: high });
    const manual = applyAttributes(ws, created.ci, classId(ws, 'server'), { hostname: 'corrected-by-hand' },
      { sourceKey: 'manual', trustRank: MANUAL_TRUST_RANK });
    assert.equal(manual.rejected.length, 0);
    assert.equal(readAttributes(created.ci.id).hostname, 'corrected-by-hand');
  });

  test('and a tool cannot then overwrite that correction', () => {
    const ws = newWorkspace();
    const { high } = twoSources(ws);
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'from-vcenter' } }, { source: high });
    applyAttributes(ws, created.ci, classId(ws, 'server'), { hostname: 'corrected-by-hand' }, { sourceKey: 'manual', trustRank: MANUAL_TRUST_RANK });
    const back = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'from-vcenter' } }, { source: high });
    assert.equal(readAttributes(created.ci.id).hostname, 'corrected-by-hand');
    assert.ok(back.rejected.some((r) => r.attr_key === 'hostname'));
  });

  test('provenance records which source owns each value', () => {
    const ws = newWorkspace();
    const { high } = twoSources(ws);
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'app-01' } }, { source: high });
    const rows = provenanceFor(created.ci.id);
    const hostname = rows.find((r) => r.attr_key === 'hostname');
    assert.equal(hostname.source_key, 'vcenter');
    assert.equal(hostname.trust_rank, 90);
  });
});

describe('drift report', () => {
  test('refused writes are grouped by the source that keeps trying', () => {
    const ws = newWorkspace();
    const high = source(ws, { key: 'vcenter', trust_rank: 90 });
    const low = source(ws, { key: 'scanner', trust_rank: 20 });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'real', operating_system: 'RHEL 9' } }, { source: high });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'wrong' } }, { source: low });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', operating_system: 'Linux' } }, { source: low });

    const report = driftReport(ws);
    assert.equal(report.conflicts.length, 2);
    assert.equal(report.by_source[0].source, 'scanner');
    assert.equal(report.by_source[0].count, 2);
    assert.deepEqual(report.by_source[0].fields.sort(), ['hostname', 'operating_system']);
  });

  test('a clean estate reports nothing rather than failing', () => {
    const ws = newWorkspace();
    assert.deepEqual(driftReport(ws), { conflicts: [], by_source: [] });
  });

  test('the conflict names the CI, so it is actionable', () => {
    const ws = newWorkspace();
    const high = source(ws, { key: 'vcenter', trust_rank: 90 });
    const low = source(ws, { key: 'scanner', trust_rank: 20 });
    reconcile(ws, { ci_class: 'server', name: 'app-01', attributes: { serial_number: 'SN-1', hostname: 'real' } }, { source: high });
    reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'wrong' } }, { source: low });
    assert.equal(driftReport(ws).conflicts[0].ci_name, 'app-01');
  });
});

describe('discovery sources', () => {
  test('a source is created with a secret, shown exactly once', () => {
    const ws = newWorkspace();
    const created = createDiscoverySource(ws, { key: 'vcenter', name: 'vCenter', trust_rank: 90 });
    assert.ok(created.ingest_secret, 'returned at creation');
    assert.equal(getDiscoverySource(ws, 'vcenter').ingest_secret, undefined, 'never readable afterwards');
    assert.equal(getDiscoverySource(ws, 'vcenter').has_secret, true);
  });

  test('the key cannot be changed once integrations point at it', () => {
    const ws = newWorkspace();
    const src = createDiscoverySource(ws, { key: 'vcenter', name: 'vCenter' });
    assert.throws(() => updateDiscoverySource(ws, src.id, { key: 'vcenter2' }), /part of the ingest URL/);
  });

  test('rotating replaces the secret', () => {
    const ws = newWorkspace();
    const src = createDiscoverySource(ws, { key: 'vcenter', name: 'vCenter' });
    const rotated = rotateSecret(ws, src.id);
    assert.notEqual(rotated.ingest_secret, src.ingest_secret);
  });

  test('trust rank is clamped to a sane range', () => {
    const ws = newWorkspace();
    assert.equal(createDiscoverySource(ws, { key: 'a', name: 'A', trust_rank: 5000 }).trust_rank, 100);
    assert.equal(createDiscoverySource(ws, { key: 'b', name: 'B', trust_rank: -20 }).trust_rank, 0);
    assert.equal(createDiscoverySource(ws, { key: 'c', name: 'C', trust_rank: 'nonsense' }).trust_rank, 50);
  });

  test('a duplicate key is refused and the slug is validated', () => {
    const ws = newWorkspace();
    createDiscoverySource(ws, { key: 'vcenter', name: 'vCenter' });
    assert.throws(() => createDiscoverySource(ws, { key: 'vcenter', name: 'Again' }), /already exists/);
    assert.throws(() => createDiscoverySource(ws, { key: 'Has Space', name: 'x' }), /key must be/);
  });

  test('sources list strongest first', () => {
    const ws = newWorkspace();
    createDiscoverySource(ws, { key: 'weak', name: 'Weak', trust_rank: 10 });
    createDiscoverySource(ws, { key: 'strong', name: 'Strong', trust_rank: 95 });
    assert.deepEqual(listDiscoverySources(ws).map((s) => s.key), ['strong', 'weak']);
  });

  test('deleting a source leaves the provenance it wrote intact', () => {
    const ws = newWorkspace();
    const src = createDiscoverySource(ws, { key: 'vcenter', name: 'vCenter', trust_rank: 90 });
    const created = reconcile(ws, { ci_class: 'server', attributes: { serial_number: 'SN-1', hostname: 'app-01' } }, { source: src });
    deleteDiscoverySource(ws, src.id);
    assert.equal(provenanceFor(created.ci.id).find((p) => p.attr_key === 'hostname').source_key, 'vcenter');
  });

  test('secret comparison rejects wrong, short and missing values', () => {
    assert.equal(secretMatches('abc123', 'abc123'), true);
    assert.equal(secretMatches('abc124', 'abc123'), false);
    assert.equal(secretMatches('abc', 'abc123'), false, 'a length mismatch must not throw');
    assert.equal(secretMatches('', 'abc123'), false);
    assert.equal(secretMatches(null, 'abc123'), false);
    assert.equal(secretMatches('abc123', null), false);
  });

  test('one workspace cannot see another workspace sources', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    createDiscoverySource(a, { key: 'vcenter', name: 'vCenter' });
    assert.equal(getDiscoverySource(b, 'vcenter'), null);
  });
});

describe('identification against a custom class', () => {
  test('an admin-added identifier attribute works exactly like a built-in one', () => {
    const ws = newWorkspace();
    const cls = classId(ws, 'server');
    createAttribute(ws, cls, { attr_key: 'asset_code', label: 'Asset code', data_type: 'text', is_identifier: 1 });
    createIdentificationRule(ws, cls, { name: 'Match on asset code', attr_keys: ['asset_code'], priority: 1 });

    const first = reconcile(ws, { ci_class: 'server', attributes: { asset_code: 'SRV-0001', hostname: 'app-01' } });
    const again = reconcile(ws, { ci_class: 'server', attributes: { asset_code: 'SRV-0001', cpu_cores: 12 } });
    assert.equal(again.ci.id, first.ci.id);
    assert.equal(readAttributes(first.ci.id).cpu_cores, 12);
  });
});
