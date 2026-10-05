import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { getClass, ensureDefaultCiClasses } from './ciClasses.js';
import {
  ensureDefaultRelationshipTypes, listRelationshipTypes, getRelationshipType,
  createRelationshipType, updateRelationshipType, deleteRelationshipType, checkEndpoints,
} from './ciRelationshipTypes.js';
import { traverse, impactOf, dependenciesOf, servicesAffectedBy, serviceMap, neighbourhood } from './cmdbGraph.js';
import { computeBlastRadius } from './blastRadius.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  ensureDefaultCiClasses(id);
  ensureDefaultRelationshipTypes(id);
  return id;
}

function ci(workspaceId, name, classKey = 'server') {
  const cls = getClass(workspaceId, classKey);
  const id = uid('ast');
  db.prepare('INSERT INTO assets (id, workspace_id, tag, name, class_id, type) VALUES (?,?,?,?,?,?)')
    .run(id, workspaceId, uid('T'), name, cls.id, 'hardware');
  return id;
}

// source depends on target.
function link(workspaceId, source, target, typeKey = 'depends_on') {
  const type = getRelationshipType(workspaceId, typeKey);
  const id = uid('rel');
  db.prepare('INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type, type_id) VALUES (?,?,?,?,?)')
    .run(id, source, target, typeKey, type ? type.id : null);
  return id;
}

const names = (nodes) => nodes.map((n) => n.name).sort();

describe('ciRelationshipTypes', () => {
  test('a workspace gets the default set, once', () => {
    const ws = newWorkspace();
    const first = listRelationshipTypes(ws).length;
    ensureDefaultRelationshipTypes(ws);
    assert.ok(first >= 11);
    assert.equal(listRelationshipTypes(ws).length, first);
  });

  test('the three legacy keys survive, so existing edges still resolve', () => {
    const ws = newWorkspace();
    const keys = listRelationshipTypes(ws).map((t) => t.key);
    for (const legacy of ['depends_on', 'hosted_on', 'connected_to']) assert.ok(keys.includes(legacy), legacy);
  });

  test('every type reads correctly from both ends', () => {
    const ws = newWorkspace();
    const hosted = getRelationshipType(ws, 'hosted_on');
    assert.equal(hosted.label, 'Runs on');
    assert.equal(hosted.inverse_label, 'Hosts');
    assert.ok(listRelationshipTypes(ws).every((t) => t.label && t.inverse_label));
  });

  test('a peer link is not a dependency', () => {
    const ws = newWorkspace();
    assert.equal(getRelationshipType(ws, 'connected_to').is_dependency, 0);
    assert.equal(getRelationshipType(ws, 'clustered_with').is_dependency, 0, 'the point of a cluster is that one member can fail');
    assert.equal(getRelationshipType(ws, 'hosted_on').is_dependency, 1);
  });

  test('a custom type needs both labels', () => {
    const ws = newWorkspace();
    assert.throws(() => createRelationshipType(ws, { key: 'feeds', label: 'Feeds' }), /inverse label/);
    const type = createRelationshipType(ws, { key: 'feeds', label: 'Feeds', inverse_label: 'Fed by' });
    assert.equal(type.key, 'feeds');
  });

  test('a built-in type cannot be deleted or rekeyed', () => {
    const ws = newWorkspace();
    const dep = getRelationshipType(ws, 'depends_on');
    assert.throws(() => deleteRelationshipType(ws, dep.id), /Built-in/i);
    assert.throws(() => updateRelationshipType(ws, dep.id, { key: 'needs' }), /built-in/i);
    assert.equal(updateRelationshipType(ws, dep.id, { label: 'Requires' }).label, 'Requires');
  });

  test('a type still in use cannot be deleted', () => {
    const ws = newWorkspace();
    const type = createRelationshipType(ws, { key: 'feeds', label: 'Feeds', inverse_label: 'Fed by' });
    const a = ci(ws, 'a'); const b = ci(ws, 'b');
    db.prepare('INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type, type_id) VALUES (?,?,?,?,?)')
      .run(uid('rel'), a, b, 'feeds', type.id);
    assert.throws(() => deleteRelationshipType(ws, type.id), /still use this type/);
  });

  test('endpoint restrictions are checked against the class tree', () => {
    const ws = newWorkspace();
    const type = createRelationshipType(ws, {
      key: 'runs_db', label: 'Runs database', inverse_label: 'Database runs on',
      allowed_source_classes: [getClass(ws, 'database').id],
      allowed_target_classes: [getClass(ws, 'hardware').id],
    });
    const dbClass = getClass(ws, 'database');
    const serverClass = getClass(ws, 'server');
    const serviceClass = getClass(ws, 'business_service');

    assert.deepEqual(checkEndpoints(ws, type, dbClass, serverClass), [], 'Server is under Hardware, so it qualifies');
    assert.equal(checkEndpoints(ws, type, serviceClass, serverClass).length, 1);
    assert.equal(checkEndpoints(ws, type, dbClass, serviceClass).length, 1);
  });

  test('an unrestricted type accepts anything', () => {
    const ws = newWorkspace();
    const type = getRelationshipType(ws, 'depends_on');
    assert.deepEqual(checkEndpoints(ws, type, getClass(ws, 'printer'), getClass(ws, 'business_service')), []);
  });
});

describe('cmdbGraph: traversal', () => {
  test('impact walks from a CI to the things that depend on it', () => {
    const ws = newWorkspace();
    const host = ci(ws, 'esx-01');
    const vm = ci(ws, 'vm-01');
    const app = ci(ws, 'app-01', 'application');
    link(ws, vm, host, 'hosted_on');
    link(ws, app, vm, 'hosted_on');

    assert.deepEqual(names(impactOf([host], ws).nodes), ['app-01', 'vm-01']);
    assert.deepEqual(names(impactOf([app], ws).nodes), [], 'nothing depends on the top of the stack');
  });

  test('dependencies walk the other way', () => {
    const ws = newWorkspace();
    const host = ci(ws, 'esx-01');
    const vm = ci(ws, 'vm-01');
    const app = ci(ws, 'app-01', 'application');
    link(ws, vm, host, 'hosted_on');
    link(ws, app, vm, 'hosted_on');

    assert.deepEqual(names(dependenciesOf([app], ws).nodes), ['esx-01', 'vm-01']);
    assert.deepEqual(names(dependenciesOf([host], ws).nodes), []);
  });

  test('the starting CIs are never in their own result', () => {
    const ws = newWorkspace();
    const a = ci(ws, 'a'); const b = ci(ws, 'b');
    link(ws, b, a);
    assert.ok(!impactOf([a], ws).nodes.some((n) => n.id === a));
  });

  test('every node carries the depth it was reached at', () => {
    const ws = newWorkspace();
    const a = ci(ws, 'a'); const b = ci(ws, 'b'); const c = ci(ws, 'c');
    link(ws, b, a); link(ws, c, b);
    const byName = Object.fromEntries(impactOf([a], ws).nodes.map((n) => [n.name, n.depth]));
    assert.deepEqual(byName, { b: 1, c: 2 });
  });

  test('a node reachable by two routes gets its SHORTEST depth', () => {
    const ws = newWorkspace();
    const root = ci(ws, 'root');
    const near = ci(ws, 'near');
    const mid1 = ci(ws, 'mid1');
    const mid2 = ci(ws, 'mid2');
    const target = ci(ws, 'target');
    // A short route root -> near -> target, and a longer one through mid1/mid2.
    link(ws, near, root);
    link(ws, target, near);
    link(ws, mid1, root); link(ws, mid2, mid1); link(ws, target, mid2);

    const node = impactOf([root], ws).nodes.find((n) => n.name === 'target');
    assert.equal(node.depth, 2, 'breadth-first, so the two-hop route wins');
  });

  test('a cycle terminates and does not repeat nodes', () => {
    const ws = newWorkspace();
    const a = ci(ws, 'a'); const b = ci(ws, 'b'); const c = ci(ws, 'c');
    link(ws, b, a); link(ws, c, b); link(ws, a, c); // a -> b -> c -> a
    const result = impactOf([a], ws);
    assert.deepEqual(names(result.nodes), ['b', 'c']);
    assert.equal(new Set(result.nodes.map((n) => n.id)).size, result.nodes.length);
  });

  test('the edge that closes a cycle is still reported, so it stays visible', () => {
    const ws = newWorkspace();
    const a = ci(ws, 'a'); const b = ci(ws, 'b');
    link(ws, b, a); link(ws, a, b);
    const { edges } = impactOf([a], ws);
    assert.equal(edges.length, 2, 'both directions of the loop are drawn');
  });

  test('depth is bounded', () => {
    const ws = newWorkspace();
    const chain = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6'].map((n) => ci(ws, n));
    for (let i = 1; i < chain.length; i += 1) link(ws, chain[i], chain[i - 1]);
    assert.equal(impactOf([chain[0]], ws, { maxDepth: 2 }).nodes.length, 2);
    assert.equal(impactOf([chain[0]], ws, { maxDepth: 4 }).nodes.length, 4);
    assert.equal(impactOf([chain[0]], ws, { maxDepth: 10 }).nodes.length, 6);
  });

  test('dependencyOnly skips edges that do not propagate failure', () => {
    const ws = newWorkspace();
    const host = ci(ws, 'esx-01');
    const vm = ci(ws, 'vm-01');
    const peer = ci(ws, 'switch-b');
    link(ws, vm, host, 'hosted_on');
    link(ws, peer, host, 'connected_to');

    assert.deepEqual(names(impactOf([host], ws).nodes), ['switch-b', 'vm-01'], 'by default everything is followed');
    assert.deepEqual(names(impactOf([host], ws, { dependencyOnly: true }).nodes), ['vm-01']);
  });

  test('a traversal can be restricted to specific relationship types', () => {
    const ws = newWorkspace();
    const host = ci(ws, 'esx-01');
    const vm = ci(ws, 'vm-01');
    const other = ci(ws, 'app-01', 'application');
    link(ws, vm, host, 'hosted_on');
    link(ws, other, host, 'uses');
    assert.deepEqual(names(impactOf([host], ws, { typeKeys: ['hosted_on'] }).nodes), ['vm-01']);
  });

  test('several start points are unioned, not counted twice', () => {
    const ws = newWorkspace();
    const a = ci(ws, 'a'); const b = ci(ws, 'b'); const shared = ci(ws, 'shared');
    link(ws, shared, a); link(ws, shared, b);
    assert.deepEqual(names(impactOf([a, b], ws).nodes), ['shared']);
  });

  test('the graph stops at the workspace boundary', () => {
    const ws = newWorkspace();
    const other = newWorkspace();
    const mine = ci(ws, 'mine');
    const theirs = ci(other, 'theirs');
    // An edge that should not exist, forced in directly.
    db.prepare('INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type) VALUES (?,?,?,?)')
      .run(uid('rel'), theirs, mine, 'depends_on');
    assert.deepEqual(impactOf([mine], ws).nodes, []);
  });

  test('an edge whose type row was deleted still reads', () => {
    const ws = newWorkspace();
    const a = ci(ws, 'a'); const b = ci(ws, 'b');
    db.prepare('INSERT INTO asset_relationships (id, asset_id, related_asset_id, relationship_type, type_id) VALUES (?,?,?,?,?)')
      .run(uid('rel'), b, a, 'some_removed_type', 'crt_gone');
    const { edges, nodes } = impactOf([a], ws);
    assert.equal(nodes.length, 1);
    assert.equal(edges[0].label, 'some_removed_type', 'degrades to the stored string rather than vanishing');
  });

  test('an empty or unknown start yields an empty graph, not a crash', () => {
    const ws = newWorkspace();
    assert.deepEqual(traverse([], ws), { nodes: [], edges: [] });
    assert.deepEqual(traverse(null, ws), { nodes: [], edges: [] });
    assert.deepEqual(impactOf(['ast_nope'], ws).nodes, []);
  });
});

describe('cmdbGraph: services and maps', () => {
  const stack = (ws) => {
    const rack = ci(ws, 'rack-1', 'rack');
    const host = ci(ws, 'esx-01', 'server');
    const vm = ci(ws, 'vm-01', 'virtual_machine');
    const database = ci(ws, 'payments-db', 'database');
    const app = ci(ws, 'payments-app', 'application');
    const service = ci(ws, 'Customer Payments', 'business_service');
    link(ws, host, rack, 'member_of');
    link(ws, vm, host, 'hosted_on');
    link(ws, database, vm, 'hosted_on');
    link(ws, app, vm, 'hosted_on');
    link(ws, app, database, 'uses');
    link(ws, service, app, 'depends_on');
    return { rack, host, vm, database, app, service };
  };

  test('impact rolls all the way up to the business service', () => {
    const ws = newWorkspace();
    const { host, service } = stack(ws);
    const affected = servicesAffectedBy([host], ws, { maxDepth: 6 });
    assert.equal(affected.length, 1);
    assert.equal(affected[0].id, service);
  });

  test('a CI with no route to a service affects none', () => {
    const ws = newWorkspace();
    stack(ws);
    const orphan = ci(ws, 'lonely-printer', 'printer');
    assert.deepEqual(servicesAffectedBy([orphan], ws), []);
  });

  test('a service map layers what the service is built on', () => {
    const ws = newWorkspace();
    const { service } = stack(ws);
    const map = serviceMap(service, ws);
    assert.equal(map.root.id, service);
    assert.equal(map.summary.mapped, true);
    assert.equal(map.summary.total, 5, 'app, db, vm, host, rack');
    assert.deepEqual(map.layers[0].nodes.map((n) => n.name), ['payments-app']);
    assert.deepEqual(names(map.layers[1].nodes), ['payments-db', 'vm-01']);
  });

  test('a service map counts the estate by class', () => {
    const ws = newWorkspace();
    const { service } = stack(ws);
    const byClass = Object.fromEntries(serviceMap(service, ws).summary.by_class.map((c) => [c.key, c.count]));
    assert.equal(byClass.database, 1);
    assert.equal(byClass.server, 1);
    assert.equal(byClass.virtual_machine, 1);
  });

  test('an unmapped service says so rather than rendering nothing', () => {
    const ws = newWorkspace();
    const service = ci(ws, 'Nothing Mapped', 'business_service');
    const map = serviceMap(service, ws);
    assert.equal(map.summary.mapped, false);
    assert.equal(map.summary.total, 0);
  });

  test('a service map for a CI that does not exist is null, not an empty map', () => {
    const ws = newWorkspace();
    assert.equal(serviceMap('ast_nope', ws), null);
  });

  test('the explorer shows both directions and marks which side each CI is on', () => {
    const ws = newWorkspace();
    const { vm } = stack(ws);
    const view = neighbourhood(vm, ws, { maxDepth: 1 });
    const bySide = Object.fromEntries(view.nodes.map((n) => [n.name, n.sides]));
    assert.deepEqual(bySide['esx-01'], ['dependency']);
    assert.deepEqual(bySide['payments-db'], ['impact']);
  });

  test('the explorer does not draw the same edge twice', () => {
    const ws = newWorkspace();
    const a = ci(ws, 'a'); const b = ci(ws, 'b');
    link(ws, b, a);
    const view = neighbourhood(a, ws, { maxDepth: 2 });
    assert.equal(view.edges.length, 1);
  });
});

describe('blastRadius: the contract changeRisk depends on', () => {
  test('no linked CIs means nothing to compute', () => {
    const ws = newWorkspace();
    assert.equal(computeBlastRadius([], ws), null);
    assert.equal(computeBlastRadius(null, ws), null);
  });

  test('the return shape is unchanged', () => {
    const ws = newWorkspace();
    const a = ci(ws, 'a'); const b = ci(ws, 'b');
    link(ws, b, a);
    const result = computeBlastRadius([a], ws);
    assert.deepEqual(Object.keys(result).sort(), ['affected', 'affectedCount', 'score']);
    assert.deepEqual(Object.keys(result.affected[0]).sort(), ['depth', 'id', 'name', 'relationship', 'tag', 'type']);
  });

  test('the staged score bands are unchanged', () => {
    const ws = newWorkspace();
    const root = ci(ws, 'root');
    const expected = [[0, 0], [1, 20], [2, 20], [3, 40], [5, 40], [6, 60], [10, 60], [11, 80], [20, 80], [21, 100]];
    let made = 0;
    for (const [count, score] of expected) {
      while (made < count) { made += 1; link(ws, ci(ws, `dep-${made}`), root); }
      assert.equal(computeBlastRadius([root], ws).score, score, `${count} affected`);
    }
  });

  test('affected is capped at 25 but affectedCount is not', () => {
    const ws = newWorkspace();
    const root = ci(ws, 'root');
    for (let i = 0; i < 30; i += 1) link(ws, ci(ws, `dep-${i}`), root);
    const result = computeBlastRadius([root], ws);
    assert.equal(result.affectedCount, 30);
    assert.equal(result.affected.length, 25);
  });

  test('it still follows every relationship type, not only dependencies', () => {
    const ws = newWorkspace();
    const root = ci(ws, 'root');
    link(ws, ci(ws, 'peer'), root, 'connected_to');
    assert.equal(computeBlastRadius([root], ws).affectedCount, 1,
      'a peer link is still "in the blast radius" for scoring purposes');
  });

  test('it stops at four hops, as it always has', () => {
    const ws = newWorkspace();
    const chain = ['n0', 'n1', 'n2', 'n3', 'n4', 'n5'].map((n) => ci(ws, n));
    for (let i = 1; i < chain.length; i += 1) link(ws, chain[i], chain[i - 1]);
    assert.equal(computeBlastRadius([chain[0]], ws).affectedCount, 4);
  });

  test('the breadth-first walk no longer under-counts a diamond', () => {
    // The case the old depth-first walk got wrong: a CI reachable both by a
    // long path and a short one could be pinned at the long depth, cutting
    // off everything past it.
    const ws = newWorkspace();
    const root = ci(ws, 'root');
    const long = ['L1', 'L2', 'L3'].map((n) => ci(ws, n));
    link(ws, long[0], root); link(ws, long[1], long[0]); link(ws, long[2], long[1]);
    const near = ci(ws, 'near');
    link(ws, near, root);
    link(ws, long[2], near); // also only two hops from root
    const tail = ci(ws, 'tail');
    link(ws, tail, long[2]); // three hops via the short route, five via the long one

    const result = computeBlastRadius([root], ws);
    assert.ok(result.affected.some((a) => a.name === 'tail'), 'reachable in three hops, so it must be counted');
    assert.equal(result.affected.find((a) => a.name === 'L3').depth, 2);
  });
});
