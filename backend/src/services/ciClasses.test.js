import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  ensureDefaultCiClasses, listClasses, getClass, classTree, ancestryOf, descendantsOf,
  effectiveAttributes, identifierAttributes, resolveClass, isAssetClass,
  coerceValue, validateAttributes, readAttributes, readAttributeDetail,
  writeAttributes, reconcileValuesForClass,
  createClass, updateClass, deleteClass,
  createAttribute, updateAttribute, deleteAttribute,
} from './ciClasses.js';
import { DEFAULT_CLASSES } from './ciClassDefaults.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

function newCi(workspaceId, classKey, name = 'thing') {
  const cls = classKey ? getClass(workspaceId, classKey) : null;
  const id = uid('ast');
  db.prepare('INSERT INTO assets (id, workspace_id, tag, name, class_id, type) VALUES (?,?,?,?,?,?)')
    .run(id, workspaceId, uid('TAG'), name, cls ? cls.id : null, 'hardware');
  return id;
}

const attrOf = (ws, classKey, key) => effectiveAttributes(ws, getClass(ws, classKey).id)
  .find((a) => a.attr_key === key);

describe('ciClasses: seeding', () => {
  test('a workspace gets the whole default model on first read', () => {
    const ws = newWorkspace();
    const classes = listClasses(ws);
    assert.equal(classes.length, DEFAULT_CLASSES.length);
    assert.ok(classes.every((c) => c.system === 1), 'seeded classes are marked built-in');
  });

  test('seeding is idempotent — reading twice does not double it', () => {
    const ws = newWorkspace();
    ensureDefaultCiClasses(ws);
    ensureDefaultCiClasses(ws);
    const { c } = db.prepare('SELECT COUNT(*) c FROM ci_classes WHERE workspace_id = ?').get(ws);
    assert.equal(c, DEFAULT_CLASSES.length);
  });

  test('one workspace cannot see another workspace model', () => {
    const a = newWorkspace();
    const b = newWorkspace();
    createClass(a, { key: 'only_in_a', label: 'Only in A' });
    assert.ok(getClass(a, 'only_in_a'));
    assert.equal(getClass(b, 'only_in_a'), null);
  });

  test('every seeded parent pointer resolves, and the tree has a single root', () => {
    const ws = newWorkspace();
    const roots = classTree(ws);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].key, 'configuration_item');
  });

  test('a reference attribute is wired to a real class, not left dangling', () => {
    const ws = newWorkspace();
    const hypervisor = attrOf(ws, 'virtual_machine', 'hypervisor_host');
    assert.equal(hypervisor.data_type, 'reference');
    assert.equal(getClass(ws, hypervisor.reference_class_id).key, 'server');
  });
});

describe('ciClasses: the class tree', () => {
  test('ancestry runs root-first and ends at the class itself', () => {
    const ws = newWorkspace();
    const chain = ancestryOf(ws, getClass(ws, 'server').id).map((c) => c.key);
    assert.deepEqual(chain, ['configuration_item', 'hardware', 'server']);
  });

  test('descendants include the class and everything under it', () => {
    const ws = newWorkspace();
    const keys = descendantsOf(ws, getClass(ws, 'software').id).map((c) => c.key).sort();
    assert.deepEqual(keys, ['application', 'database', 'middleware', 'operating_system', 'software', 'software_product']);
  });

  test('a corrupted parent pointer cannot hang the ancestry walk', () => {
    const ws = newWorkspace();
    const root = getClass(ws, 'configuration_item');
    const hardware = getClass(ws, 'hardware');
    // Force a ring directly in the table, past the API guards.
    db.prepare('UPDATE ci_classes SET parent_class_id = ? WHERE id = ?').run(hardware.id, root.id);
    const chain = ancestryOf(ws, getClass(ws, 'server').id);
    assert.ok(chain.length > 0 && chain.length < 20, 'terminates rather than spinning');
  });
});

describe('ciClasses: attribute inheritance', () => {
  test('a class sees its own attributes and every ancestor attribute', () => {
    const ws = newWorkspace();
    const keys = effectiveAttributes(ws, getClass(ws, 'server').id).map((a) => a.attr_key);
    assert.ok(keys.includes('environment'), 'from the root Configuration Item');
    assert.ok(keys.includes('serial_number'), 'from Hardware');
    assert.ok(keys.includes('hostname'), 'its own');
  });

  test('inherited attributes are labelled with the class that owns them', () => {
    const ws = newWorkspace();
    const attrs = effectiveAttributes(ws, getClass(ws, 'server').id);
    const env = attrs.find((a) => a.attr_key === 'environment');
    const host = attrs.find((a) => a.attr_key === 'hostname');
    assert.equal(env.inherited, 1);
    assert.equal(env.owner_class_key, 'configuration_item');
    assert.equal(host.inherited, 0);
  });

  test('a child redeclaring a key overrides the parent, and appears only once', () => {
    const ws = newWorkspace();
    const attrs = effectiveAttributes(ws, getClass(ws, 'cloud_account').id);
    const matches = attrs.filter((a) => a.attr_key === 'account_identifier');
    assert.equal(matches.length, 1, 'not duplicated by inheritance');
    assert.equal(matches[0].required, 1, 'the child tightened it');
    assert.equal(matches[0].is_identifier, 1);
    assert.equal(matches[0].inherited, 0);
  });

  test('a sibling that does not redeclare still sees the loose parent version', () => {
    const ws = newWorkspace();
    const attr = attrOf(ws, 'cloud_resource', 'account_identifier');
    assert.equal(attr.required, 0);
    assert.equal(attr.owner_class_key, 'cloud');
  });

  test('an attribute added to an ancestor immediately reaches every descendant', () => {
    const ws = newWorkspace();
    createAttribute(ws, getClass(ws, 'configuration_item').id, {
      attr_key: 'cost_centre', label: 'Cost centre', data_type: 'text',
    });
    for (const key of ['server', 'application', 'business_service', 'rack']) {
      assert.ok(effectiveAttributes(ws, getClass(ws, key).id).some((a) => a.attr_key === 'cost_centre'), key);
    }
  });

  test('a disabled attribute drops out of the resolved schema', () => {
    const ws = newWorkspace();
    const attr = attrOf(ws, 'server', 'fqdn');
    updateAttribute(ws, attr.id, { enabled: 0 });
    assert.ok(!effectiveAttributes(ws, getClass(ws, 'server').id).some((a) => a.attr_key === 'fqdn'));
    assert.ok(effectiveAttributes(ws, getClass(ws, 'server').id, { includeDisabled: true }).some((a) => a.attr_key === 'fqdn'));
  });

  test('identifier attributes are collected across the whole chain', () => {
    const ws = newWorkspace();
    const keys = identifierAttributes(ws, getClass(ws, 'server').id).map((a) => a.attr_key).sort();
    assert.deepEqual(keys, ['hostname', 'ip_address', 'serial_number']);
  });
});

describe('ciClasses: is_asset', () => {
  test('hardware classes are assets, services and applications are not', () => {
    const ws = newWorkspace();
    assert.equal(isAssetClass(ws, getClass(ws, 'server').id), true);
    assert.equal(isAssetClass(ws, getClass(ws, 'endpoint').id), true);
    assert.equal(isAssetClass(ws, getClass(ws, 'business_service').id), false);
    assert.equal(isAssetClass(ws, getClass(ws, 'application').id), false);
  });

  test('a new class inherits its parent nature rather than defaulting to asset', () => {
    const ws = newWorkspace();
    const child = createClass(ws, { key: 'payment_service', label: 'Payment Service', parent_class_id: getClass(ws, 'business_service').id });
    assert.equal(child.is_asset, 0, 'a child of a service is not something that depreciates');
    const hw = createClass(ws, { key: 'kvm_switch', label: 'KVM Switch', parent_class_id: getClass(ws, 'hardware').id });
    assert.equal(hw.is_asset, 1);
  });

  test('an explicit is_asset still wins over the inherited default', () => {
    const ws = newWorkspace();
    const child = createClass(ws, { key: 'leased_service', label: 'Leased Service', parent_class_id: getClass(ws, 'business_service').id, is_asset: 1 });
    assert.equal(child.is_asset, 1);
  });
});

describe('ciClasses: legacy assets without a class', () => {
  test('an unclassified asset resolves through its old type column', () => {
    const ws = newWorkspace();
    ensureDefaultCiClasses(ws);
    const id = uid('ast');
    db.prepare('INSERT INTO assets (id, workspace_id, tag, name, type) VALUES (?,?,?,?,?)')
      .run(id, ws, 'OLD-1', 'Legacy laptop', 'hardware');
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    assert.equal(resolveClass(ws, asset).key, 'endpoint');
  });

  test('an explicit class beats the legacy type', () => {
    const ws = newWorkspace();
    const id = newCi(ws, 'server');
    const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
    assert.equal(asset.type, 'hardware');
    assert.equal(resolveClass(ws, asset).key, 'server');
  });

  test('an unrecognised legacy type resolves to nothing rather than guessing', () => {
    const ws = newWorkspace();
    ensureDefaultCiClasses(ws);
    const asset = { type: 'something_else', class_id: null };
    assert.equal(resolveClass(ws, asset), null);
  });
});

describe('ciClasses: value coercion', () => {
  const setup = () => {
    const ws = newWorkspace();
    return { ws, server: getClass(ws, 'server').id };
  };

  test('numbers are parsed and range-checked', () => {
    const { ws } = setup();
    const cores = attrOf(ws, 'server', 'cpu_cores');
    assert.equal(coerceValue(ws, cores, '16').value, '16');
    assert.ok(coerceValue(ws, cores, 'sixteen').error);
    assert.ok(coerceValue(ws, cores, '2.5').error, 'an integer field rejects a fraction');
    assert.ok(coerceValue(ws, cores, '0').error, 'below the minimum');
    assert.ok(coerceValue(ws, cores, '99999').error, 'above the maximum');
  });

  test('a decimal is fine on a number field but not on an integer one', () => {
    const { ws } = setup();
    assert.equal(coerceValue(ws, attrOf(ws, 'server', 'memory_gb'), '7.5').value, '7.5');
  });

  test('booleans accept the spellings a CSV or an agent will actually send', () => {
    const { ws } = setup();
    const attr = attrOf(ws, 'endpoint', 'disk_encrypted');
    for (const yes of [true, 'true', 'TRUE', 'yes', '1', 'on']) assert.equal(coerceValue(ws, attr, yes).value, '1', String(yes));
    for (const no of [false, 'false', 'no', '0', 'off']) assert.equal(coerceValue(ws, attr, no).value, '0', String(no));
    assert.ok(coerceValue(ws, attr, 'maybe').error);
  });

  test('a choice field only accepts a configured option', () => {
    const { ws } = setup();
    const attr = attrOf(ws, 'server', 'environment');
    assert.equal(coerceValue(ws, attr, 'production').value, 'production');
    assert.ok(coerceValue(ws, attr, 'prod').error, 'a near miss is still a miss');
  });

  test('a multiselect stores JSON, deduplicates, and rejects unknown members', () => {
    const { ws } = setup();
    const attr = attrOf(ws, 'server', 'compliance_scope');
    assert.equal(coerceValue(ws, attr, ['pci_dss', 'gdpr', 'pci_dss']).value, JSON.stringify(['pci_dss', 'gdpr']));
    assert.equal(coerceValue(ws, attr, 'pci_dss, gdpr').value, JSON.stringify(['pci_dss', 'gdpr']), 'a comma string works too');
    assert.ok(coerceValue(ws, attr, ['pci_dss', 'nonsense']).error);
  });

  test('dates must be a real calendar date in the stored shape', () => {
    const { ws } = setup();
    const attr = attrOf(ws, 'endpoint', 'last_patched_at');
    assert.equal(coerceValue(ws, attr, '2026-09-23').value, '2026-09-23');
    assert.ok(coerceValue(ws, attr, '23/09/2026').error);
    assert.ok(coerceValue(ws, attr, 'not a date').error);
  });

  test('IP addresses are shape-checked, both families', () => {
    const { ws } = setup();
    const attr = attrOf(ws, 'server', 'ip_address');
    assert.equal(coerceValue(ws, attr, '10.0.4.21').value, '10.0.4.21');
    assert.equal(coerceValue(ws, attr, '2001:db8::1').value, '2001:db8::1');
    assert.ok(coerceValue(ws, attr, '10.0.4.999').error);
    assert.ok(coerceValue(ws, attr, 'server-01').error);
  });

  test('URLs must carry a real scheme', () => {
    const { ws } = setup();
    const attr = attrOf(ws, 'application', 'app_url');
    assert.equal(coerceValue(ws, attr, 'https://pay.example.com').value, 'https://pay.example.com');
    assert.ok(coerceValue(ws, attr, 'pay.example.com').error);
    assert.ok(coerceValue(ws, attr, 'javascript:alert(1)').error);
  });

  test('an empty value is "not set", never the string "null"', () => {
    const { ws } = setup();
    const attr = attrOf(ws, 'server', 'fqdn');
    for (const empty of ['', null, undefined, '   ', []]) {
      assert.equal(coerceValue(ws, attr, empty).value, null, JSON.stringify(empty));
    }
  });
});

describe('ciClasses: reference attributes', () => {
  test('a reference must point at an existing CI in the same workspace', () => {
    const ws = newWorkspace();
    const other = newWorkspace();
    const attr = attrOf(ws, 'virtual_machine', 'hypervisor_host');
    const foreign = newCi(other, 'server');
    assert.ok(coerceValue(ws, attr, 'ast_nope').error);
    assert.ok(coerceValue(ws, attr, foreign).error, 'another workspace CI is not visible');
  });

  test('a reference is confined to its declared class', () => {
    const ws = newWorkspace();
    const attr = attrOf(ws, 'virtual_machine', 'hypervisor_host');
    const server = newCi(ws, 'server');
    const printer = newCi(ws, 'printer');
    assert.equal(coerceValue(ws, attr, server).value, server);
    assert.ok(coerceValue(ws, attr, printer).error, 'a printer is not a hypervisor');
  });

  test('a subclass of the referenced class is accepted', () => {
    const ws = newWorkspace();
    const attr = attrOf(ws, 'hardware', 'installed_rack');
    const rack = newCi(ws, 'rack');
    assert.equal(coerceValue(ws, attr, rack).value, rack);

    // A class created under Rack must also satisfy a reference to Rack.
    const bladeRack = createClass(ws, { key: 'blade_rack', label: 'Blade Rack', parent_class_id: getClass(ws, 'rack').id });
    const blade = newCi(ws, bladeRack.key);
    assert.equal(coerceValue(ws, attr, blade).value, blade, 'inheritance applies to references too');
  });
});

describe('ciClasses: payload validation', () => {
  test('a create rejects a missing required attribute and names it', () => {
    const ws = newWorkspace();
    const result = validateAttributes(ws, getClass(ws, 'database').id, { db_engine: 'postgresql' });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.attr_key === 'instance_name'));
  });

  test('every problem is reported, not just the first', () => {
    const ws = newWorkspace();
    const result = validateAttributes(ws, getClass(ws, 'database').id, { db_engine: 'cassandra', db_port: 'abc' });
    const keys = result.errors.map((e) => e.attr_key).sort();
    assert.ok(keys.includes('db_engine') && keys.includes('db_port') && keys.includes('instance_name'), JSON.stringify(keys));
  });

  test('an unknown attribute is rejected rather than silently dropped', () => {
    const ws = newWorkspace();
    const result = validateAttributes(ws, getClass(ws, 'server').id, { hostname: 'app-01', nonsense: 'x' }, { partial: true });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((e) => e.attr_key === 'nonsense'));
  });

  test('a partial update does not demand attributes it was not given', () => {
    const ws = newWorkspace();
    const result = validateAttributes(ws, getClass(ws, 'database').id, { size_gb: 40 }, { partial: true });
    assert.equal(result.ok, true, JSON.stringify(result.errors));
  });

  test('defaults are applied on a create when the field is absent', () => {
    const ws = newWorkspace();
    const crit = attrOf(ws, 'server', 'business_criticality');
    const result = validateAttributes(ws, getClass(ws, 'server').id, { hostname: 'app-01' });
    assert.equal(result.values.get(crit.id), 'medium');
  });

  test('a supplied value beats the default', () => {
    const ws = newWorkspace();
    const crit = attrOf(ws, 'server', 'business_criticality');
    const result = validateAttributes(ws, getClass(ws, 'server').id, { hostname: 'app-01', business_criticality: 'critical' });
    assert.equal(result.values.get(crit.id), 'critical');
  });

  test('a required field explicitly blanked on a create is still an error', () => {
    const ws = newWorkspace();
    const result = validateAttributes(ws, getClass(ws, 'server').id, { hostname: '' });
    assert.ok(result.errors.some((e) => e.attr_key === 'hostname'));
  });
});

describe('ciClasses: reading and writing values', () => {
  test('a written value comes back typed, not as text', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    const result = writeAttributes(ws, ci, getClass(ws, 'server').id, {
      hostname: 'app-01', cpu_cores: '16', memory_gb: '64.5', environment: 'production',
      compliance_scope: ['pci_dss', 'gdpr'],
    });
    assert.equal(result.ok, true, JSON.stringify(result.errors));

    const values = readAttributes(ci);
    assert.equal(values.hostname, 'app-01');
    assert.equal(values.cpu_cores, 16);
    assert.equal(values.memory_gb, 64.5);
    assert.deepEqual(values.compliance_scope, ['pci_dss', 'gdpr']);
  });

  test('booleans round-trip as booleans', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'endpoint');
    writeAttributes(ws, ci, getClass(ws, 'endpoint').id, { disk_encrypted: 'yes' });
    assert.equal(readAttributes(ci).disk_encrypted, true);
    writeAttributes(ws, ci, getClass(ws, 'endpoint').id, { disk_encrypted: false });
    assert.equal(readAttributes(ci).disk_encrypted, false);
  });

  test('a rejected payload writes nothing at all', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    const result = writeAttributes(ws, ci, getClass(ws, 'server').id, { hostname: 'app-01', cpu_cores: 'lots' });
    assert.equal(result.ok, false);
    assert.deepEqual(readAttributes(ci), {}, 'the valid half must not land either');
  });

  test('writing the same attribute twice updates rather than duplicating', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, getClass(ws, 'server').id, { hostname: 'app-01' });
    writeAttributes(ws, ci, getClass(ws, 'server').id, { hostname: 'app-02' });
    const { c } = db.prepare('SELECT COUNT(*) c FROM ci_attribute_values WHERE ci_id = ?').get(ci);
    assert.equal(c, 1);
    assert.equal(readAttributes(ci).hostname, 'app-02');
  });

  test('blanking a value removes it rather than storing an empty string', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, getClass(ws, 'server').id, { fqdn: 'app-01.corp' });
    writeAttributes(ws, ci, getClass(ws, 'server').id, { fqdn: '' });
    assert.equal(readAttributes(ci).fqdn, undefined);
    const { c } = db.prepare('SELECT COUNT(*) c FROM ci_attribute_values WHERE ci_id = ?').get(ci);
    assert.equal(c, 0);
  });

  test('the write source is recorded, so drift can be attributed later', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, getClass(ws, 'server').id, { hostname: 'app-01' }, { source: 'discovery:vcenter' });
    const detail = readAttributeDetail(ws, ci, getClass(ws, 'server').id).find((a) => a.attr_key === 'hostname');
    assert.equal(detail.source, 'discovery:vcenter');
  });

  test('the detail view shows unset attributes too, so a gap is visible', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, getClass(ws, 'server').id, { hostname: 'app-01' });
    const detail = readAttributeDetail(ws, ci, getClass(ws, 'server').id);
    const fqdn = detail.find((a) => a.attr_key === 'fqdn');
    assert.ok(fqdn, 'still listed');
    assert.equal(fqdn.value, null);
  });

  test('deleting a CI takes its attribute values with it', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, getClass(ws, 'server').id, { hostname: 'app-01' });
    db.prepare('DELETE FROM assets WHERE id = ?').run(ci);
    const { c } = db.prepare('SELECT COUNT(*) c FROM ci_attribute_values WHERE ci_id = ?').get(ci);
    assert.equal(c, 0);
  });
});

describe('ciClasses: reclassifying a CI', () => {
  test('a value whose key exists on both classes is carried across', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, getClass(ws, 'server').id, { hostname: 'box-01', environment: 'production', cluster_name: 'c1' });

    const moved = reconcileValuesForClass(ws, ci, getClass(ws, 'virtual_machine').id);
    assert.ok(moved.moved >= 1);
    const values = readAttributes(ci);
    assert.equal(values.hostname, 'box-01', 'both classes declare hostname');
    assert.equal(values.environment, 'production', 'inherited from the shared ancestor');
    assert.equal(values.cluster_name, undefined, 'server-only, so dropped');
  });

  test('nothing is dropped when the new class is a descendant of the old one', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'hardware');
    writeAttributes(ws, ci, getClass(ws, 'hardware').id, { serial_number: 'SN-1', environment: 'production' });
    const result = reconcileValuesForClass(ws, ci, getClass(ws, 'server').id);
    assert.equal(result.dropped, 0);
    assert.equal(readAttributes(ci).serial_number, 'SN-1');
  });
});

describe('ciClasses: class administration', () => {
  test('a class key must be a usable slug', () => {
    const ws = newWorkspace();
    ensureDefaultCiClasses(ws);
    for (const bad of ['Has Space', '9lives', '', 'with-dash', 'trailing!']) {
      assert.throws(() => createClass(ws, { key: bad, label: 'x' }), /key must be/i, `accepted ${bad}`);
    }
  });

  test('but a key typed in capitals is normalised rather than rejected', () => {
    const ws = newWorkspace();
    const cls = createClass(ws, { key: 'LoadBalancer', label: 'Load Balancer' });
    assert.equal(cls.key, 'loadbalancer');
  });

  test('a duplicate key is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => createClass(ws, { key: 'server', label: 'Another Server' }), /already exists/);
  });

  test('a built-in class key cannot be changed and the class cannot be deleted', () => {
    const ws = newWorkspace();
    const server = getClass(ws, 'server');
    assert.throws(() => updateClass(ws, server.id, { key: 'box' }), /built-in/i);
    assert.throws(() => deleteClass(ws, server.id), /built-in/i);
  });

  test('but a built-in class can be relabelled and disabled', () => {
    const ws = newWorkspace();
    const printer = getClass(ws, 'printer');
    const updated = updateClass(ws, printer.id, { label: 'MFD', enabled: 0 });
    assert.equal(updated.label, 'MFD');
    assert.ok(!listClasses(ws).some((c) => c.key === 'printer'));
  });

  test('a class cannot be re-parented underneath itself', () => {
    const ws = newWorkspace();
    const hardware = getClass(ws, 'hardware');
    const server = getClass(ws, 'server');
    assert.throws(() => updateClass(ws, hardware.id, { parent_class_id: server.id }), /underneath itself/);
    assert.throws(() => updateClass(ws, hardware.id, { parent_class_id: hardware.id }), /own parent/);
  });

  test('a class holding CIs cannot become an abstract grouping', () => {
    const ws = newWorkspace();
    newCi(ws, 'server');
    assert.throws(() => updateClass(ws, getClass(ws, 'server').id, { is_abstract: 1 }), /cannot become an abstract/);
  });

  test('a custom class with children or CIs cannot be deleted', () => {
    const ws = newWorkspace();
    const parent = createClass(ws, { key: 'appliance', label: 'Appliance', parent_class_id: getClass(ws, 'hardware').id });
    const child = createClass(ws, { key: 'firewall_appliance', label: 'Firewall Appliance', parent_class_id: parent.id });
    assert.throws(() => deleteClass(ws, parent.id), /inherit from this one/);

    newCi(ws, child.key);
    assert.throws(() => deleteClass(ws, child.id), /still on this class/);
  });

  test('an empty custom class deletes cleanly', () => {
    const ws = newWorkspace();
    const cls = createClass(ws, { key: 'temporary', label: 'Temporary' });
    assert.deepEqual(deleteClass(ws, cls.id), { ok: true });
    assert.equal(getClass(ws, 'temporary'), null);
  });
});

describe('ciClasses: attribute administration', () => {
  test('a choice field must ship with options', () => {
    const ws = newWorkspace();
    const cls = getClass(ws, 'server').id;
    assert.throws(() => createAttribute(ws, cls, { attr_key: 'tier', label: 'Tier', data_type: 'select' }), /at least one option/);
    assert.throws(() => createAttribute(ws, cls, { attr_key: 'tier', label: 'Tier', data_type: 'select', options: [] }), /at least one option/);
  });

  test('a reference field must say what it points at, and it must exist', () => {
    const ws = newWorkspace();
    const cls = getClass(ws, 'server').id;
    assert.throws(() => createAttribute(ws, cls, { attr_key: 'runs_on', label: 'Runs on', data_type: 'reference' }), /which class/);
    assert.throws(() => createAttribute(ws, cls, { attr_key: 'runs_on', label: 'Runs on', data_type: 'reference', reference_class_id: 'cic_nope' }), /not found/);
  });

  test('an unsupported field type is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => createAttribute(ws, getClass(ws, 'server').id, { attr_key: 'x', label: 'X', data_type: 'blob' }), /Unsupported field type/);
  });

  test('a broken validation pattern is caught at configuration time', () => {
    const ws = newWorkspace();
    assert.throws(() => createAttribute(ws, getClass(ws, 'server').id, {
      attr_key: 'code', label: 'Code', data_type: 'text', pattern: '([unclosed',
    }), /not a valid regular expression/);
  });

  test('a min above the max is refused', () => {
    const ws = newWorkspace();
    assert.throws(() => createAttribute(ws, getClass(ws, 'server').id, {
      attr_key: 'weight', label: 'Weight', data_type: 'number', min_value: 10, max_value: 2,
    }), /minimum cannot be greater/);
  });

  test('a class cannot declare the same key twice', () => {
    const ws = newWorkspace();
    const cls = getClass(ws, 'server').id;
    createAttribute(ws, cls, { attr_key: 'patch_group', label: 'Patch group', data_type: 'text' });
    assert.throws(() => createAttribute(ws, cls, { attr_key: 'patch_group', label: 'Again', data_type: 'text' }), /already declares/);
  });

  test('a custom attribute validates like a built-in one', () => {
    const ws = newWorkspace();
    const cls = getClass(ws, 'server').id;
    createAttribute(ws, cls, {
      attr_key: 'asset_code', label: 'Asset code', data_type: 'text', pattern: '^SRV-[0-9]{4}$',
      help_text: 'Asset code looks like SRV-0001',
    });
    const attr = attrOf(ws, 'server', 'asset_code');
    assert.equal(coerceValue(ws, attr, 'SRV-0042').value, 'SRV-0042');
    assert.equal(coerceValue(ws, attr, 'SRV-42').error, 'Asset code looks like SRV-0001');
  });

  test('retyping a field that already holds data is refused', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, getClass(ws, 'server').id, { cluster_name: 'c1' });
    const attr = attrOf(ws, 'server', 'cluster_name');
    assert.throws(() => updateAttribute(ws, attr.id, { data_type: 'integer' }), /cannot change/);
  });

  test('retyping an empty field is allowed', () => {
    const ws = newWorkspace();
    const attr = attrOf(ws, 'server', 'cluster_name');
    const updated = updateAttribute(ws, attr.id, { data_type: 'textarea' });
    assert.equal(updated.data_type, 'textarea');
  });

  test('removing an option still in use names the values that would break', () => {
    const ws = newWorkspace();
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, getClass(ws, 'server').id, { environment: 'staging' });
    const attr = attrOf(ws, 'server', 'environment');
    assert.throws(
      () => updateAttribute(ws, attr.id, { options: ['production', 'development'] }),
      /Still in use by existing CIs: staging/
    );
  });

  test('adding options to a live choice field is fine', () => {
    const ws = newWorkspace();
    const attr = attrOf(ws, 'server', 'environment');
    const updated = updateAttribute(ws, attr.id, { options: ['production', 'staging', 'test', 'development', 'dr', 'sandbox'] });
    assert.deepEqual(JSON.parse(updated.options).at(-1), 'sandbox');
  });

  test('a built-in field cannot be deleted or rekeyed, only disabled', () => {
    const ws = newWorkspace();
    const attr = attrOf(ws, 'server', 'hostname');
    assert.throws(() => deleteAttribute(ws, attr.id), /Built-in fields cannot be deleted/);
    assert.throws(() => updateAttribute(ws, attr.id, { attr_key: 'host' }), /built-in field cannot be changed/);
    assert.equal(updateAttribute(ws, attr.id, { enabled: 0 }).enabled, 0);
  });

  test('deleting a custom field reports how many values went with it', () => {
    const ws = newWorkspace();
    const cls = getClass(ws, 'server').id;
    const attr = createAttribute(ws, cls, { attr_key: 'patch_group', label: 'Patch group', data_type: 'text' });
    const ci = newCi(ws, 'server');
    writeAttributes(ws, ci, cls, { patch_group: 'weekly' });
    assert.deepEqual(deleteAttribute(ws, attr.id), { ok: true, values_removed: 1 });
    assert.equal(readAttributes(ci).patch_group, undefined);
  });
});
