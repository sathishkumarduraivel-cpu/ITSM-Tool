import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { db, uid } from '../db.js';
import { PERMISSIONS, sanitizePermissions, resolveEffectivePermissions } from './permissions.js';

function newWorkspace() {
  const id = uid('ws');
  db.prepare('INSERT INTO workspaces (id, name, slug) VALUES (?,?,?)').run(id, 'Test ' + id, id);
  return id;
}

function newCustomRole(workspaceId, keys) {
  const id = uid('cr');
  db.prepare('INSERT INTO custom_roles (id, workspace_id, name, permissions) VALUES (?,?,?,?)')
    .run(id, workspaceId, 'Role ' + id, JSON.stringify(keys));
  return id;
}

function newUser(name) {
  const id = uid('usr');
  db.prepare('INSERT INTO users (id, name, email, password_hash) VALUES (?,?,?,?)')
    .run(id, name, `${id}@example.com`, 'x');
  return id;
}

function newGroup(workspaceId, defaultRoleId) {
  const id = uid('grp');
  db.prepare('INSERT INTO groups (id, workspace_id, name, default_custom_role_id) VALUES (?,?,?,?)')
    .run(id, workspaceId, 'Group ' + id, defaultRoleId || null);
  return id;
}

describe('permissions: sanitizePermissions', () => {
  test('keeps only keys from the real permission catalog', () => {
    const real = PERMISSIONS[0].key;
    assert.deepEqual(sanitizePermissions([real, 'not_a_real_permission', 'sql.injection.attempt']), [real]);
  });

  test('de-duplicates repeated keys', () => {
    const real = PERMISSIONS[0].key;
    assert.deepEqual(sanitizePermissions([real, real, real]), [real]);
  });

  test('non-array input is always an empty array, never throws', () => {
    assert.deepEqual(sanitizePermissions(null), []);
    assert.deepEqual(sanitizePermissions(undefined), []);
    assert.deepEqual(sanitizePermissions('sla.manage'), []);
    assert.deepEqual(sanitizePermissions({}), []);
  });
});

describe('permissions: resolveEffectivePermissions', () => {
  test('a user with no personal role and no groups has no permissions', () => {
    const ws = newWorkspace();
    const user = newUser('Nobody');
    assert.deepEqual(resolveEffectivePermissions(user, ws, null), []);
  });

  test('personal custom role grants its permissions directly', () => {
    const ws = newWorkspace();
    const user = newUser('Solo Agent');
    const role = newCustomRole(ws, ['sla.manage', 'kb.manage']);
    assert.deepEqual(resolveEffectivePermissions(user, ws, role).sort(), ['kb.manage', 'sla.manage']);
  });

  test('group membership grants that group\'s default role, even with no personal role at all', () => {
    const ws = newWorkspace();
    const user = newUser('Group Member');
    const groupRole = newCustomRole(ws, ['automations.manage']);
    const group = newGroup(ws, groupRole);
    db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), group, user);

    assert.deepEqual(resolveEffectivePermissions(user, ws, null), ['automations.manage']);
  });

  test('personal and group-granted permissions union together, de-duplicated', () => {
    const ws = newWorkspace();
    const user = newUser('Both');
    const personalRole = newCustomRole(ws, ['sla.manage', 'kb.manage']);
    const groupRole = newCustomRole(ws, ['kb.manage', 'business_rules.manage']); // kb.manage overlaps on purpose
    const group = newGroup(ws, groupRole);
    db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), group, user);

    const effective = resolveEffectivePermissions(user, ws, personalRole).sort();
    assert.deepEqual(effective, ['business_rules.manage', 'kb.manage', 'sla.manage']);
  });

  test('a group with no default_custom_role_id contributes nothing', () => {
    const ws = newWorkspace();
    const user = newUser('In An Unprivileged Group');
    const group = newGroup(ws, null);
    db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), group, user);
    assert.deepEqual(resolveEffectivePermissions(user, ws, null), []);
  });

  test('membership in a group belonging to a DIFFERENT workspace grants nothing here', () => {
    const wsA = newWorkspace();
    const wsB = newWorkspace();
    const user = newUser('Cross Workspace');
    const roleInB = newCustomRole(wsB, ['sla.manage']);
    const groupInB = newGroup(wsB, roleInB);
    db.prepare('INSERT INTO group_members (id, group_id, user_id) VALUES (?,?,?)').run(uid('gm'), groupInB, user);

    // Resolved for workspace A, even though this user is (hypothetically)
    // also a member of a group over in workspace B.
    assert.deepEqual(resolveEffectivePermissions(user, wsA, null), []);
  });
});
