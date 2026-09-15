import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { createBusinessRule, evaluateBusinessRules, applyBusinessRules } from './businessRules.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

describe('businessRules: evaluateBusinessRules', () => {
  test('a matching rule mandates a field, a non-matching one does not', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'incident', {
      name: 'Require root cause on critical incidents',
      conditions: { logic: 'AND', rules: [{ field: 'priority', operator: 'equals', value: 'critical' }] },
      actions: [{ type: 'mandate_field', field: 'root_cause' }],
    });

    const critical = evaluateBusinessRules(ws, 'incident', { priority: 'critical' });
    assert.equal(critical.root_cause?.required, true);

    const low = evaluateBusinessRules(ws, 'incident', { priority: 'low' });
    assert.equal(low.root_cause, undefined, 'a field never touched by any matching rule has no state at all');
  });

  test('a field targeted by show_field starts hidden and only becomes visible when its rule actually matches', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'request', {
      name: 'Show approver note only for high-value requests',
      conditions: { logic: 'AND', rules: [{ field: 'amount', operator: 'greater_than', value: '1000' }] },
      actions: [{ type: 'show_field', field: 'approver_note' }],
    });

    const cheap = evaluateBusinessRules(ws, 'request', { amount: '50' });
    assert.equal(cheap.approver_note.visible, false, 'governed field defaults hidden until a rule proves otherwise');

    const expensive = evaluateBusinessRules(ws, 'request', { amount: '5000' });
    assert.equal(expensive.approver_note.visible, true);
  });

  test('set_value writes through so a later (lower-priority-number... i.e. later-evaluated) rule can react to it', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'incident', {
      name: 'Auto-set category from source',
      priority: 10,
      conditions: { logic: 'AND', rules: [{ field: 'source', operator: 'equals', value: 'email' }] },
      actions: [{ type: 'set_value', field: 'category', value: 'Inbound Email' }],
    });
    createBusinessRule(ws, 'incident', {
      name: 'Mandate a note when category is Inbound Email',
      priority: 20,
      conditions: { logic: 'AND', rules: [{ field: 'category', operator: 'equals', value: 'Inbound Email' }] },
      actions: [{ type: 'mandate_field', field: 'note' }],
    });

    const values = { source: 'email' };
    const states = evaluateBusinessRules(ws, 'incident', values);
    assert.equal(values.category, 'Inbound Email', 'set_value mutated the caller\'s values object in place');
    assert.equal(states.note?.required, true, 'the second rule saw the first rule\'s set_value and matched on it');
  });

  test('an inactive rule never evaluates at all', () => {
    const ws = newWorkspace();
    const id = createBusinessRule(ws, 'incident', {
      name: 'Should never fire',
      conditions: { logic: 'AND', rules: [] }, // would always match if active
      actions: [{ type: 'mandate_field', field: 'never_required' }],
    });
    db.prepare('UPDATE business_rules SET status = ? WHERE id = ?').run('inactive', id);

    const states = evaluateBusinessRules(ws, 'incident', {});
    assert.equal(states.never_required, undefined);
  });

  test('remove_options subtracts from the field\'s real base option list', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'change', {
      name: 'Hide emergency change type for non-admins',
      conditions: { logic: 'AND', rules: [] },
      actions: [{ type: 'remove_options', field: 'change_type', options: ['emergency'] }],
    });
    const states = evaluateBusinessRules(ws, 'change', {}, { change_type: ['standard', 'normal', 'emergency'] });
    assert.deepEqual(states.change_type.options, ['standard', 'normal']);
  });
});

describe('businessRules: block action', () => {
  test('a matching block rule stops the save with its message, independent of any field state', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'incident', {
      name: 'Cannot resolve with open tasks',
      conditions: {
        logic: 'AND',
        rules: [{ field: 'status', operator: 'equals', value: 'resolved' }, { field: 'all_tasks_completed', operator: 'equals', value: 'false' }],
      },
      actions: [{ type: 'block', message: 'Complete all tasks before resolving.' }],
    });

    const blocked = applyBusinessRules(ws, 'incident', { status: 'resolved', all_tasks_completed: 'false' });
    assert.equal(blocked, 'Complete all tasks before resolving.');

    const allowed = applyBusinessRules(ws, 'incident', { status: 'resolved', all_tasks_completed: 'true' });
    assert.equal(allowed, null);
  });
});

describe('businessRules: applyBusinessRules (server-side enforcement)', () => {
  test('required-but-empty fails validation on a full submit, but not on a partial (PATCH) one', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'incident', {
      name: 'Require category',
      conditions: { logic: 'AND', rules: [] },
      actions: [{ type: 'mandate_field', field: 'category' }],
    });

    const full = applyBusinessRules(ws, 'incident', { category: '' });
    assert.equal(full, 'Field "category" is required.');

    const partial = applyBusinessRules(ws, 'incident', { category: '' }, {}, { partial: true });
    assert.equal(partial, null, 'PATCH does not enforce required-field checks');
  });

  test('a hidden field is stripped from the submitted values entirely', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'incident', {
      name: 'Hide internal notes from requesters',
      conditions: { logic: 'AND', rules: [] },
      actions: [{ type: 'hide_field', field: 'internal_notes' }],
    });
    const values = { internal_notes: 'should be dropped', title: 'kept' };
    const err = applyBusinessRules(ws, 'incident', values);
    assert.equal(err, null);
    assert.equal('internal_notes' in values, false);
    assert.equal(values.title, 'kept');
  });

  test('submitting a value outside a restricted option set is rejected', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'change', {
      name: 'Restrict environment to prod/staging',
      conditions: { logic: 'AND', rules: [] },
      actions: [{ type: 'set_options', field: 'environment', options: ['prod', 'staging'] }],
    });
    const err = applyBusinessRules(ws, 'change', { environment: 'dev' });
    assert.match(err, /not a valid option/);
  });

  test('validate_field enforces a regex format and reports the configured message', () => {
    const ws = newWorkspace();
    createBusinessRule(ws, 'incident', {
      name: 'Ticket reference must look like TCK-1234',
      conditions: { logic: 'AND', rules: [] },
      actions: [{
        type: 'validate_field', field: 'external_ref',
        validation_type: 'regex', validation_value: '^TCK-\\d+$', validation_message: 'Must look like TCK-1234',
      }],
    });
    assert.equal(applyBusinessRules(ws, 'incident', { external_ref: 'nope' }), 'Must look like TCK-1234');
    assert.equal(applyBusinessRules(ws, 'incident', { external_ref: 'TCK-9981' }), null);
  });
});
