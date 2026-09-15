import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { legacyToGraph, deriveLegacyFromGraph } from './workflowGraph.js';

describe('workflowGraph: legacyToGraph', () => {
  test('a trigger with no conditions or actions produces just the trigger node', () => {
    const { nodes, edges } = legacyToGraph({ event: 'ticket_created' }, [], []);
    assert.equal(nodes.length, 1);
    assert.equal(nodes[0].type, 'trigger');
    assert.equal(nodes[0].data.event, 'ticket_created');
    assert.equal(edges.length, 0);
  });

  test('conditions + actions produce a straight chain: trigger -> condition -> action -> action', () => {
    const conditions = [{ field: 'priority', operator: 'equals', value: 'critical' }];
    const actions = [{ type: 'assign_team', team: 'Network' }, { type: 'set_priority', value: 'high' }];
    const { nodes, edges } = legacyToGraph({ event: 'ticket_created' }, conditions, actions);

    assert.equal(nodes.length, 4);
    const [trigger, cond, act1, act2] = nodes;
    assert.equal(trigger.type, 'trigger');
    assert.equal(cond.type, 'condition');
    assert.deepEqual(cond.data.rules, conditions);
    assert.equal(act1.type, 'action');
    assert.deepEqual(act1.data, actions[0]);
    assert.equal(act2.type, 'action');
    assert.deepEqual(act2.data, actions[1]);

    assert.equal(edges.length, 3);
    assert.equal(edges[0].source, trigger.id);
    assert.equal(edges[0].target, cond.id);
    assert.equal(edges[1].source, cond.id);
    assert.equal(edges[1].target, act1.id);
    assert.equal(edges[1].sourceHandle, 'yes', 'the edge leaving a condition node is tagged which branch it is');
    assert.equal(edges[2].source, act1.id);
    assert.equal(edges[2].target, act2.id);
    assert.equal(edges[2].sourceHandle, undefined, 'a plain action-to-action edge carries no branch handle');
  });

  test('every generated node and edge id is unique, even across repeated calls', () => {
    const ids = new Set();
    for (let i = 0; i < 5; i++) {
      const { nodes, edges } = legacyToGraph({ event: 'ticket_created' }, [{ field: 'x', operator: 'equals', value: '1' }], [{ type: 'noop' }]);
      for (const n of nodes) { assert.ok(!ids.has(n.id), `duplicate node id: ${n.id}`); ids.add(n.id); }
      for (const e of edges) { assert.ok(!ids.has(e.id), `duplicate edge id: ${e.id}`); ids.add(e.id); }
    }
  });
});

describe('workflowGraph: deriveLegacyFromGraph', () => {
  test('round-trips a straight-line graph back to an equivalent legacy shape', () => {
    const trigger = { event: 'sla_breach' };
    const conditions = [{ field: 'team', operator: 'equals', value: 'Network' }];
    const actions = [{ type: 'notify_role', role: 'admin' }, { type: 'set_priority', value: 'critical' }];
    const { nodes, edges } = legacyToGraph(trigger, conditions, actions);

    const derived = deriveLegacyFromGraph(nodes, edges);
    assert.equal(derived.trigger.event, 'sla_breach');
    assert.deepEqual(derived.conditions, conditions);
    assert.deepEqual(derived.actions, actions);
  });

  test('a branching graph collects actions from every reachable branch', () => {
    const trigger = { id: 't1', type: 'trigger', data: { event: 'ticket_created' } };
    const cond = { id: 'c1', type: 'condition', data: { rules: [] } };
    const yesAction = { id: 'a1', type: 'action', data: { type: 'notify_role', role: 'agent' } };
    const noAction = { id: 'a2', type: 'action', data: { type: 'set_priority', value: 'low' } };
    const nodes = [trigger, cond, yesAction, noAction];
    const edges = [
      { id: 'e1', source: 't1', target: 'c1' },
      { id: 'e2', source: 'c1', target: 'a1', sourceHandle: 'yes' },
      { id: 'e3', source: 'c1', target: 'a2', sourceHandle: 'no' },
    ];
    const derived = deriveLegacyFromGraph(nodes, edges);
    assert.equal(derived.actions.length, 2);
    assert.deepEqual(new Set(derived.actions.map((a) => a.type)), new Set(['notify_role', 'set_priority']));
  });

  test('no trigger node at all falls back to a default event and no actions', () => {
    const derived = deriveLegacyFromGraph([], []);
    assert.equal(derived.trigger.event, 'ticket_created');
    assert.deepEqual(derived.conditions, []);
    assert.deepEqual(derived.actions, []);
  });
});
