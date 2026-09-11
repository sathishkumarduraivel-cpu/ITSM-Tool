// Orchestrates bilateral ticket sync across external_connections. Platform-
// specific request/response shapes live in ./externalPlatforms/*; this file
// only knows the generic push/pull/webhook flow and never branches on
// platform beyond picking the right adapter.
import { db, uid } from '../db.js';
import { decrypt } from './crypto.js';
import { getLifecycle } from './lifecycleEngine.js';
import * as servicenow from './externalPlatforms/servicenow.js';
import * as jira from './externalPlatforms/jira.js';
import * as freshservice from './externalPlatforms/freshservice.js';
import * as servicedeskplus from './externalPlatforms/servicedeskplus.js';

export const ADAPTERS = { servicenow, jira, freshservice, servicedeskplus };

function adapterFor(platform) {
  const adapter = ADAPTERS[platform];
  if (!adapter) throw new Error(`Unsupported platform: ${platform}`);
  return adapter;
}

function loadAuth(connection) {
  return JSON.parse(decrypt(connection.auth_config) || '{}');
}

// external_connections.field_mapping is stored as a JSON string (same
// convention as every other JSON-blob column in this app) -- callers hand
// adapters the raw DB row, so parse it once here rather than requiring every
// call site to remember to. Safe to call more than once on an already-parsed
// connection (e.g. a caller that built one in memory rather than from a row).
function normalizeConnection(connection) {
  if (typeof connection.field_mapping !== 'string') return connection;
  let field_mapping = {};
  try { field_mapping = JSON.parse(connection.field_mapping || '{}'); } catch { /* leave empty */ }
  return { ...connection, field_mapping };
}

function logSync(linkId, direction, status, detail) {
  db.prepare('INSERT INTO ticket_sync_logs (id, link_id, direction, status, detail) VALUES (?,?,?,?,?)').run(uid('tsl'), linkId, direction, status, detail || '');
}

function touchLink(linkId, patch, syncedNow = false) {
  const fields = []; const params = [];
  for (const [key, value] of Object.entries(patch)) { fields.push(`${key} = ?`); params.push(value); }
  if (syncedNow) fields.push("last_synced_at = datetime('now')");
  params.push(linkId);
  db.prepare(`UPDATE ticket_external_links SET ${fields.join(', ')} WHERE id = ?`).run(...params);
}

// Status is intentionally skipped for lifecycle-governed ticket types,
// mirroring the same guard automationEngine.js's set_status action applies --
// an arbitrary external status string is not a valid lifecycle stage key, so
// writing it directly would desync tickets.status from tickets.lifecycle_stage.
function applyInboundFields(ticket, fields) {
  const updates = {};
  if (fields.title !== undefined) updates.title = fields.title;
  if (fields.description !== undefined) updates.description = fields.description;
  if (fields.priority !== undefined) updates.priority = fields.priority;
  let statusNote = '';
  if (fields.status !== undefined) {
    if (getLifecycle(ticket.workspace_id, ticket.type)) {
      statusNote = ' (status change ignored -- ticket type is governed by a configured lifecycle)';
    } else {
      updates.status = fields.status;
    }
  }
  if (Object.keys(updates).length === 0) return statusNote;
  const setSql = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
  db.prepare(`UPDATE tickets SET ${setSql}, updated_at = datetime('now') WHERE id = ?`).run(...Object.values(updates), ticket.id);
  db.prepare('INSERT INTO ticket_history (id, ticket_id, event, detail) VALUES (?,?,?,?)').run(
    uid('h'), ticket.id, 'external_sync', `Updated from external platform: ${Object.keys(updates).join(', ')}${statusNote}`
  );
  return statusNote;
}

export async function testConnection(connectionRaw) {
  const connection = normalizeConnection(connectionRaw);
  const adapter = adapterFor(connection.platform);
  const result = await adapter.testConnection(connection, loadAuth(connection));
  db.prepare("UPDATE external_connections SET last_tested_at = datetime('now'), last_test_ok = ? WHERE id = ?").run(result.ok ? 1 : 0, connection.id);
  return result;
}

export async function createExternalTicket(connectionRaw, ticket) {
  const connection = normalizeConnection(connectionRaw);
  const adapter = adapterFor(connection.platform);
  const created = await adapter.createTicket(connection, loadAuth(connection), ticket);
  const id = uid('xlnk');
  db.prepare(
    `INSERT INTO ticket_external_links (id, workspace_id, ticket_id, connection_id, external_id, external_number, external_url, sync_status, last_synced_at, last_direction)
     VALUES (?,?,?,?,?,?,?,'synced',datetime('now'),'outbound')`
  ).run(id, ticket.workspace_id, ticket.id, connection.id, created.external_id, created.external_number, created.external_url);
  logSync(id, 'outbound', 'success', `Created ${created.external_number} on ${connection.name}`);
  return db.prepare('SELECT * FROM ticket_external_links WHERE id = ?').get(id);
}

// Links to a record that already exists on the external platform. Platforms
// whose "id you'd naturally have" doesn't match what their single-record API
// expects (ServiceNow: you have the number INC0010010, the API needs the
// sys_id) implement resolveExternalId() to accept either and look up the
// real id via the platform's own search/query API -- everyone else just
// verifies the pasted id is fetchable as-is.
export async function linkExistingTicket(connectionRaw, ticket, externalId) {
  const connection = normalizeConnection(connectionRaw);
  const adapter = adapterFor(connection.platform);
  const auth = loadAuth(connection);

  let resolvedId = externalId;
  let resolvedNumber = externalId;
  let resolvedUrl = null;
  if (adapter.resolveExternalId) {
    const resolved = await adapter.resolveExternalId(connection, auth, externalId);
    resolvedId = resolved.external_id;
    resolvedNumber = resolved.external_number || externalId;
    resolvedUrl = resolved.external_url || null;
  } else {
    const stub = { external_id: externalId, external_number: externalId };
    await adapter.fetchTicket(connection, auth, stub); // throws if it doesn't exist / auth is wrong
  }

  const id = uid('xlnk');
  db.prepare(
    `INSERT INTO ticket_external_links (id, workspace_id, ticket_id, connection_id, external_id, external_number, external_url, sync_status, last_synced_at, last_direction)
     VALUES (?,?,?,?,?,?,?,'synced',datetime('now'),'inbound')`
  ).run(id, ticket.workspace_id, ticket.id, connection.id, resolvedId, resolvedNumber, resolvedUrl);
  logSync(id, 'inbound', 'success', `Linked to existing ${resolvedNumber} on ${connection.name}`);
  return db.prepare('SELECT * FROM ticket_external_links WHERE id = ?').get(id);
}

export async function pushTicketUpdate(link, ticket) {
  try {
    const connection = normalizeConnection(db.prepare('SELECT * FROM external_connections WHERE id = ?').get(link.connection_id) || {});
    if (!connection.id || !connection.enabled) return;
    const adapter = adapterFor(connection.platform);
    await adapter.updateTicket(connection, loadAuth(connection), link, {
      title: ticket.title, description: ticket.description, priority: ticket.priority, status: ticket.status,
    });
    touchLink(link.id, { sync_status: 'synced', last_error: null, last_direction: 'outbound' }, true);
    logSync(link.id, 'outbound', 'success', `Pushed latest ticket state to ${connection.name}`);
  } catch (e) {
    touchLink(link.id, { sync_status: 'error', last_error: e.message });
    logSync(link.id, 'outbound', 'error', e.message);
  }
}

// Fire-and-forget from routes/tickets.js's PATCH handler -- every active link
// for this ticket gets the latest state pushed out automatically.
export async function pushToLinkedConnections(ticket, workspaceId) {
  const links = db.prepare('SELECT * FROM ticket_external_links WHERE ticket_id = ? AND workspace_id = ?').all(ticket.id, workspaceId);
  for (const link of links) {
    // eslint-disable-next-line no-await-in-loop
    await pushTicketUpdate(link, ticket);
  }
}

// Pushes a Reply (never a private note -- those are explicitly internal-only
// and should never leave this app) out to every active external link on the
// ticket, as a real comment/note on the other platform. Fire-and-forget from
// routes/tickets.js's POST /:id/comments, same style as pushToLinkedConnections.
export async function pushCommentToConnections(ticket, comment) {
  const links = db.prepare('SELECT * FROM ticket_external_links WHERE ticket_id = ? AND workspace_id = ?').all(ticket.id, ticket.workspace_id);
  for (const link of links) {
    const connectionRow = db.prepare('SELECT * FROM external_connections WHERE id = ?').get(link.connection_id);
    if (!connectionRow || !connectionRow.enabled) continue;
    const connection = normalizeConnection(connectionRow);
    const adapter = adapterFor(connection.platform);
    if (!adapter.addComment) continue; // platform adapter doesn't support comment sync
    try {
      // eslint-disable-next-line no-await-in-loop
      await adapter.addComment(connection, loadAuth(connection), link, { body: comment.body });
      logSync(link.id, 'outbound', 'success', `Pushed reply to ${connection.name}`);
    } catch (e) {
      logSync(link.id, 'outbound', 'error', `Failed to push reply to ${connection.name}: ${e.message}`);
    }
  }
}

// Imports any remote comments/notes this app hasn't seen yet, keyed by
// external_comment_id so re-pulling never duplicates one already imported.
// Best-effort and silent on adapters that don't support it (returns 0)
// rather than failing the whole pull over a platform that only supports
// field sync.
async function pullComments(connection, auth, adapter, link) {
  if (!adapter.fetchComments) return 0;
  const remote = await adapter.fetchComments(connection, auth, link);
  let imported = 0;
  for (const c of remote) {
    if (!c.body || !c.body.trim()) continue;
    const already = db.prepare('SELECT 1 FROM ticket_comments WHERE external_comment_id = ?').get(c.external_comment_id);
    if (already) continue;
    db.prepare(
      'INSERT INTO ticket_comments (id, ticket_id, author_id, author_name, body, is_private, external_comment_id) VALUES (?,?,?,?,?,0,?)'
    ).run(uid('cmt'), link.ticket_id, null, `${c.author || 'Unknown'} (via ${connection.name})`, c.body, c.external_comment_id);
    imported++;
  }
  return imported;
}

export async function pullTicketUpdate(link) {
  const connectionRow = db.prepare('SELECT * FROM external_connections WHERE id = ?').get(link.connection_id);
  if (!connectionRow) throw new Error('Connection no longer exists');
  const connection = normalizeConnection(connectionRow);
  try {
    const adapter = adapterFor(connection.platform);
    const auth = loadAuth(connection);
    const fetched = await adapter.fetchTicket(connection, auth, link);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(link.ticket_id);
    const note = applyInboundFields(ticket, fetched);
    const importedCount = await pullComments(connection, auth, adapter, link);
    const commentNote = importedCount ? `, ${importedCount} new comment${importedCount === 1 ? '' : 's'}` : '';
    touchLink(link.id, { sync_status: 'synced', last_error: null, last_direction: 'inbound' }, true);
    logSync(link.id, 'inbound', 'success', `Pulled latest from ${connection.name}${note || ''}${commentNote}`);
    return fetched;
  } catch (e) {
    touchLink(link.id, { sync_status: 'error', last_error: e.message });
    logSync(link.id, 'inbound', 'error', e.message);
    throw e;
  }
}

// Inbound webhook path: the external platform calls us. Not every webhook
// event corresponds to a ticket we've linked (their instance may fire this
// for every issue, not just ones tied to us), so "not linked" is a normal,
// silent no-op rather than an error.
export async function applyInboundWebhook(connectionRaw, rawBody) {
  const connection = normalizeConnection(connectionRaw);
  const adapter = adapterFor(connection.platform);
  const parsed = adapter.parseWebhookPayload(rawBody);
  const link = db.prepare('SELECT * FROM ticket_external_links WHERE connection_id = ? AND external_id = ?').get(connection.id, parsed.external_id);
  if (!link) return { applied: false, reason: 'No ticket linked to this external id' };

  const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(link.ticket_id);
  if (!ticket) {
    logSync(link.id, 'inbound', 'error', 'Linked ticket no longer exists');
    return { applied: false, reason: 'Linked ticket no longer exists' };
  }
  try {
    const note = applyInboundFields(ticket, parsed.fields);
    touchLink(link.id, { sync_status: 'synced', last_error: null, last_direction: 'inbound' }, true);
    logSync(link.id, 'inbound', 'success', `Received webhook update${note || ''}`);
    return { applied: true };
  } catch (e) {
    touchLink(link.id, { sync_status: 'error', last_error: e.message });
    logSync(link.id, 'inbound', 'error', e.message);
    throw e;
  }
}
