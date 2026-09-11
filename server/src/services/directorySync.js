// Reconciles a workspace's users against an external directory (LDAP/Active
// Directory or Microsoft Graph) -- provisions new accounts, refreshes
// details on existing ones, and deactivates (never hard-deletes, same
// "deactivate don't delete" principle used everywhere else in this app --
// merge, spam, ticket soft-delete) anyone disabled or removed there. Called
// both by the manual "Sync now" route and the periodic scheduler
// (directorySyncScheduler.js) -- identical code path either way.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, uid } from '../db.js';
import { decrypt } from './crypto.js';
import { logAudit } from './auditLog.js';
import { sendTemplatedEmail } from './emailService.js';
import * as ldapClient from './ldapClient.js';
import * as graphDirectory from './graphDirectory.js';

const DEFAULT_LDAP_ATTR_MAP = {
  email: 'mail', name: 'displayName', employeeId: 'employeeID',
  department: 'department', title: 'title', manager: 'manager', office: 'physicalDeliveryOfficeName',
};
// graphDirectory.js's normalize() already emits these exact (lowercase) key
// names, so this map is fixed rather than admin-configurable like LDAP's.
const GRAPH_ATTR_MAP = {
  email: 'mail', name: 'displayname', employeeId: 'employeeid',
  department: 'department', title: 'title', manager: 'manager', office: 'physicaldeliveryofficename',
};

function getConfig(provider) {
  return JSON.parse(decrypt(provider.config) || '{}');
}

// Active Directory's userAccountControl bit 2 (0x2) is ACCOUNTDISABLE.
// Directories that don't expose it (generic LDAP/OpenLDAP) have no way to
// signal "disabled but still present" -- for those, deprovisioning relies
// entirely on the entry disappearing from the search results (see the
// "absent from this sync pass" pass below), which is universal across every
// LDAP flavor.
function ldapAccountDisabled(entry) {
  const uac = Number(entry.useraccountcontrol);
  return !Number.isNaN(uac) && (uac & 2) === 2;
}

function extractFields(provider, attrMap, entry) {
  const get = (key) => {
    const attrName = (attrMap[key] || '').toLowerCase();
    return attrName ? entry[attrName] : undefined;
  };
  const email = get('email');
  return {
    externalId: entry.dn,
    email: Array.isArray(email) ? email[0] : email,
    name: get('name') || email,
    employeeId: get('employeeId'),
    department: get('department'),
    managerRef: get('manager') || null,
    enabled: provider.type === 'microsoft_graph' ? entry.accountenabled !== false : !ldapAccountDisabled(entry),
  };
}

export async function runSync(providerId) {
  const provider = db.prepare('SELECT * FROM directory_providers WHERE id = ?').get(providerId);
  if (!provider) throw new Error('Directory provider not found');
  const config = getConfig(provider);
  const client = provider.type === 'ldap' ? ldapClient : graphDirectory;

  let rawEntries;
  try {
    rawEntries = await client.search(config);
  } catch (e) {
    db.prepare("UPDATE directory_providers SET last_synced_at = datetime('now'), last_sync_status = 'error', last_sync_summary = ? WHERE id = ?").run(e.message, providerId);
    db.prepare('INSERT INTO directory_sync_logs (id, provider_id, status, summary) VALUES (?,?,?,?)').run(uid('dsl'), providerId, 'error', e.message);
    const admins = db.prepare(
      `SELECT u.name, u.email FROM workspace_members wm JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = ? AND wm.role = 'admin' AND wm.active = 1`
    ).all(provider.workspace_id);
    for (const admin of admins) {
      if (admin.email) {
        sendTemplatedEmail(provider.workspace_id, 'directory_sync_failed', admin.email, {
          'admin.name': admin.name, 'provider.name': provider.name, 'error.message': e.message,
        }).catch((err) => console.error('directory sync failure email error', err));
      }
    }
    throw e;
  }

  const attrMap = provider.type === 'ldap' ? (config.attributeMap || DEFAULT_LDAP_ATTR_MAP) : GRAPH_ATTR_MAP;
  const normalized = rawEntries.map((entry) => extractFields(provider, attrMap, entry)).filter((r) => r.email && r.externalId);

  let created = 0;
  let updated = 0;
  let deactivated = 0;
  let reactivated = 0;
  const seenExternalIds = new Set();
  const externalIdToUserId = {};

  for (const rec of normalized) {
    seenExternalIds.add(rec.externalId);
    let membership = db.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND directory_provider_id = ? AND directory_external_id = ?'
    ).get(provider.workspace_id, providerId, rec.externalId);
    let userId;
    let wasActive;
    let isNewMembership = false;
    // Written into the very same INSERT/UPDATE as everything else below,
    // not as a separate pass -- this is a two-way reconciliation: absent or
    // explicitly disabled -> 0, present and enabled -> 1. Earlier versions
    // of this function only ever wrote 0 here (a real bug: once deactivated,
    // re-enabling someone in the directory could never bring them back).
    const activeFlag = rec.enabled ? 1 : 0;

    if (membership) {
      userId = membership.user_id;
      wasActive = !!membership.active;
      db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(rec.name, rec.email, userId);
      db.prepare(
        "UPDATE workspace_members SET team = COALESCE(?, team), employee_id = COALESCE(?, employee_id), directory_synced_at = datetime('now'), active = ? WHERE id = ?"
      ).run(rec.department || provider.default_team || null, rec.employeeId || null, activeFlag, membership.id);
      updated += 1;
    } else {
      // Link an existing manually-created (or OAuth-SSO) account by email
      // before creating a duplicate -- this is what lets an admin invite
      // someone by hand ahead of a directory going live without ending up
      // with two rows for the same person.
      const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(rec.email);
      if (existingUser) {
        userId = existingUser.id;
        const existingMembership = db.prepare('SELECT * FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(provider.workspace_id, userId);
        if (existingMembership) {
          wasActive = !!existingMembership.active;
          db.prepare(
            "UPDATE workspace_members SET directory_provider_id = ?, directory_external_id = ?, directory_synced_at = datetime('now'), active = ? WHERE id = ?"
          ).run(providerId, rec.externalId, activeFlag, existingMembership.id);
          membership = { ...existingMembership, directory_provider_id: providerId, directory_external_id: rec.externalId };
        } else {
          wasActive = false;
          isNewMembership = true;
          const mid = uid('wm');
          db.prepare(
            "INSERT INTO workspace_members (id, workspace_id, user_id, role, team, directory_provider_id, directory_external_id, directory_synced_at, active) VALUES (?,?,?,?,?,?,?,datetime('now'),?)"
          ).run(mid, provider.workspace_id, userId, provider.auto_provision_role, rec.department || provider.default_team || null, providerId, rec.externalId, activeFlag);
          membership = db.prepare('SELECT * FROM workspace_members WHERE id = ?').get(mid);
        }
      } else {
        wasActive = false;
        isNewMembership = true;
        userId = uid('usr');
        const colors = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
        // Directory-sourced users never authenticate via the local-password
        // path (LDAP users bind live against the directory at login instead
        // -- see routes/auth.js -- Graph-sourced ones use the existing OAuth
        // SSO redirect), so this hash only needs to be unguessable, never
        // actually typed by anyone.
        const placeholderHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
        db.prepare(
          'INSERT INTO users (id, name, email, password_hash, avatar_color, last_workspace_id) VALUES (?,?,?,?,?,?)'
        ).run(userId, rec.name, rec.email, placeholderHash, colors[Math.floor(Math.random() * colors.length)], provider.workspace_id);
        const mid = uid('wm');
        db.prepare(
          "INSERT INTO workspace_members (id, workspace_id, user_id, role, team, custom_role_id, employee_id, directory_provider_id, directory_external_id, directory_synced_at, active) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),?)"
        ).run(mid, provider.workspace_id, userId, provider.auto_provision_role, rec.department || provider.default_team || null, provider.default_custom_role_id || null, rec.employeeId || null, providerId, rec.externalId, activeFlag);
        membership = db.prepare('SELECT * FROM workspace_members WHERE id = ?').get(mid);
      }
      created += 1;
    }
    externalIdToUserId[rec.externalId] = userId;

    // Log the transition (either direction) for anyone who wasn't brand new
    // this run -- a create already implies the right active state, nothing
    // to "transition" from.
    if (wasActive && !activeFlag) {
      deactivated += 1;
      logAudit({ workspaceId: provider.workspace_id }, {
        action: 'user.deactivated_by_directory_sync', entityType: 'user', entityId: userId, entityLabel: rec.email,
        details: { provider: provider.name, reason: 'disabled in directory' },
      });
    } else if (!wasActive && activeFlag && !isNewMembership) {
      // Excludes a brand-new membership (already counted in `created`,
      // wasActive is trivially false for those too but there's nothing to
      // "reactivate" -- it never existed before this run).
      reactivated += 1;
      logAudit({ workspaceId: provider.workspace_id }, {
        action: 'user.reactivated_by_directory_sync', entityType: 'user', entityId: userId, entityLabel: rec.email,
        details: { provider: provider.name, reason: 're-enabled in directory' },
      });
    }
  }

  // Second pass: resolve manager_id now that every synced user's local id
  // is known (a manager might appear later in the entry list than their report).
  for (const rec of normalized) {
    if (!rec.managerRef) continue;
    const localUserId = externalIdToUserId[rec.externalId];
    const managerUserId = externalIdToUserId[rec.managerRef];
    if (localUserId && managerUserId) {
      db.prepare('UPDATE workspace_members SET manager_id = ? WHERE workspace_id = ? AND user_id = ?').run(managerUserId, provider.workspace_id, localUserId);
    }
  }

  // Deprovisioning: anyone still linked to this provider but absent from
  // THIS entire sync pass (deleted, or now filtered out by userFilter) gets
  // deactivated too -- this is the "delete in the directory -> deactivated
  // here" behavior, covering the case a disable-flag check above can't (the
  // entry isn't there at all to check a flag on).
  const linkedActive = db.prepare(
    'SELECT * FROM workspace_members WHERE workspace_id = ? AND directory_provider_id = ? AND active = 1'
  ).all(provider.workspace_id, providerId);
  for (const m of linkedActive) {
    if (seenExternalIds.has(m.directory_external_id)) continue;
    db.prepare('UPDATE workspace_members SET active = 0 WHERE id = ?').run(m.id);
    deactivated += 1;
    const u = db.prepare('SELECT email FROM users WHERE id = ?').get(m.user_id);
    logAudit({ workspaceId: provider.workspace_id }, {
      action: 'user.deactivated_by_directory_sync', entityType: 'user', entityId: m.user_id, entityLabel: u?.email,
      details: { provider: provider.name, reason: 'removed from directory' },
    });
  }

  const summary = `${created} created, ${updated} updated, ${deactivated} deactivated${reactivated ? `, ${reactivated} reactivated` : ''}`;
  db.prepare("UPDATE directory_providers SET last_synced_at = datetime('now'), last_sync_status = 'success', last_sync_summary = ? WHERE id = ?").run(summary, providerId);
  db.prepare('INSERT INTO directory_sync_logs (id, provider_id, status, summary) VALUES (?,?,?,?)').run(uid('dsl'), providerId, 'success', summary);
  return { created, updated, deactivated, reactivated, summary };
}

export async function testProvider(provider) {
  const config = getConfig(provider);
  const client = provider.type === 'ldap' ? ldapClient : graphDirectory;
  return client.testConnection(config);
}
