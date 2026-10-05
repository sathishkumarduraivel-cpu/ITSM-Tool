import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import {
  ensureDefaultTaxonomy, listTaxonomy, categoryNames,
  parseSubcategories, serializeSubcategories, reconcileSubcategories,
} from './ticketCategories.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

describe('ticketCategories: parseSubcategories', () => {
  test('splits a stored comma-separated list', () => {
    assert.deepEqual(parseSubcategories('VPN, Wi-Fi'), ['VPN', 'Wi-Fi']);
  });

  test('tolerates ragged spacing and trailing separators', () => {
    assert.deepEqual(parseSubcategories('  VPN ,,  Wi-Fi , '), ['VPN', 'Wi-Fi']);
  });

  test('a single legacy value is already a valid one-item list', () => {
    assert.deepEqual(parseSubcategories('Password reset'), ['Password reset']);
  });

  test('empty and null inputs yield an empty list, never [""]', () => {
    assert.deepEqual(parseSubcategories(''), []);
    assert.deepEqual(parseSubcategories(null), []);
    assert.deepEqual(parseSubcategories(undefined), []);
  });
});

describe('ticketCategories: serializeSubcategories', () => {
  test('joins a list back into the stored shape', () => {
    assert.equal(serializeSubcategories(['VPN', 'Wi-Fi']), 'VPN, Wi-Fi');
  });

  test('collapses duplicates case-insensitively, keeping the first spelling', () => {
    assert.equal(serializeSubcategories(['VPN', 'vpn', ' VPN ']), 'VPN');
  });

  test('an empty selection stores NULL rather than an empty string', () => {
    // NULL matters: the report builder and SLA matching both test for a
    // missing subcategory, and '' is not missing.
    assert.equal(serializeSubcategories([]), null);
    assert.equal(serializeSubcategories(['', '  ']), null);
  });

  test('accepts an already-serialized string as input (idempotent)', () => {
    assert.equal(serializeSubcategories('VPN, Wi-Fi'), 'VPN, Wi-Fi');
  });
});

describe('ticketCategories: default taxonomy', () => {
  test('seeds on demand and is idempotent', () => {
    const ws = newWorkspace();
    ensureDefaultTaxonomy(ws);
    const first = listTaxonomy(ws);
    assert.ok(first.length >= 8, `expected a full default set, got ${first.length}`);

    ensureDefaultTaxonomy(ws);
    ensureDefaultTaxonomy(ws);
    assert.equal(listTaxonomy(ws).length, first.length, 're-seeding must not duplicate');
  });

  test('listTaxonomy seeds lazily without an explicit ensure call', () => {
    const ws = newWorkspace();
    assert.ok(listTaxonomy(ws).length >= 8);
  });

  test('every default category carries at least one subcategory', () => {
    const ws = newWorkspace();
    for (const category of listTaxonomy(ws)) {
      assert.ok(category.subcategories.length >= 1, `${category.name} has no subcategories`);
    }
  });

  test('the default categories are the vocabulary the AI classifier already used', () => {
    const ws = newWorkspace();
    const names = categoryNames(ws);
    for (const expected of ['Hardware', 'Software', 'Network', 'Access & Identity', 'Email', 'Facilities', 'HR', 'Security', 'Other']) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
  });

  test('taxonomies are per workspace', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    listTaxonomy(wsA);
    db.prepare('INSERT INTO ticket_categories (id, workspace_id, name, sort_order) VALUES (?,?,?,?)').run(uid('tcat'), wsA, 'A-only', 99);
    assert.ok(categoryNames(wsA).includes('A-only'));
    assert.ok(!categoryNames(wsB).includes('A-only'));
  });

  test('inactive categories are hidden unless explicitly asked for', () => {
    const ws = newWorkspace();
    const [first] = listTaxonomy(ws);
    db.prepare('UPDATE ticket_categories SET active = 0 WHERE id = ?').run(first.id);

    assert.ok(!listTaxonomy(ws).some((c) => c.id === first.id), 'a hidden category must not appear in the picker');
    assert.ok(listTaxonomy(ws, { includeInactive: true }).some((c) => c.id === first.id), 'but the admin view must still see it');
  });
});

describe('ticketCategories: reconcileSubcategories', () => {
  test('keeps only subcategories that belong to the given category', () => {
    const ws = newWorkspace();
    listTaxonomy(ws);
    // 'VPN' is under Network; 'Payroll' is under HR.
    assert.equal(reconcileSubcategories(ws, 'Network', ['VPN', 'Payroll']), 'VPN');
  });

  test('matches subcategory names case-insensitively', () => {
    const ws = newWorkspace();
    listTaxonomy(ws);
    assert.equal(reconcileSubcategories(ws, 'Network', ['vpn']), 'vpn');
  });

  test('returns null when nothing survives', () => {
    const ws = newWorkspace();
    listTaxonomy(ws);
    assert.equal(reconcileSubcategories(ws, 'Network', ['Payroll']), null);
  });

  test('a subcategory with no category cannot be stored', () => {
    const ws = newWorkspace();
    listTaxonomy(ws);
    assert.equal(reconcileSubcategories(ws, null, ['VPN']), null);
    assert.equal(reconcileSubcategories(ws, '', ['VPN']), null);
  });

  test('an unknown category keeps its values rather than erasing history', () => {
    const ws = newWorkspace();
    listTaxonomy(ws);
    // A legacy free-text category, or one since renamed. Dropping the
    // subcategories here would silently destroy data on an unrelated edit.
    assert.equal(reconcileSubcategories(ws, 'Legacy Typo Category', ['Whatever']), 'Whatever');
  });

  test('an empty selection clears the field', () => {
    const ws = newWorkspace();
    listTaxonomy(ws);
    assert.equal(reconcileSubcategories(ws, 'Network', []), null);
  });

  test('accepts the stored comma-separated shape as input', () => {
    const ws = newWorkspace();
    listTaxonomy(ws);
    assert.equal(reconcileSubcategories(ws, 'Network', 'VPN, Wi-Fi'), 'VPN, Wi-Fi');
  });

  test('a category in another workspace does not validate here', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    listTaxonomy(wsA);
    listTaxonomy(wsB);
    db.prepare('DELETE FROM ticket_categories WHERE workspace_id = ? AND name = ?').run(wsB, 'Network');
    // Network no longer exists in wsB, so it is treated as an unknown
    // category there -- and must not borrow wsA's subcategory list.
    assert.equal(reconcileSubcategories(wsB, 'Network', ['VPN']), 'VPN');
    assert.equal(reconcileSubcategories(wsA, 'Network', ['Payroll']), null);
  });
});
