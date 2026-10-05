// ServiceNow adapter -- Table API against the `incident` table.
// Docs: https://docs.servicenow.com/bundle/latest-release-notes/page/integrate/inbound-rest/concept/c_TableAPI.html
// Auth: Basic (username/password) against a ServiceNow instance user with
// rights on the incident table. auth_config shape: { username, password }.
import { apiRequest, basicAuthHeader } from './httpClient.js';

const PRIORITY_TO_SN = { critical: '1', high: '2', medium: '3', low: '4' };
const PRIORITY_FROM_SN = { 1: 'critical', '1': 'critical', 2: 'high', '2': 'high', 3: 'medium', '3': 'medium', 4: 'low', '4': 'low', 5: 'low', '5': 'low' };

// Default `incident` table state codes. A real instance can customize these,
// but this is the out-of-the-box mapping ServiceNow ships with.
const STATUS_TO_SN = { open: '1', in_progress: '2', on_hold: '3', resolved: '6', closed: '7' };
const STATUS_FROM_SN = { 1: 'open', '1': 'open', 2: 'in_progress', '2': 'in_progress', 3: 'on_hold', '3': 'on_hold', 6: 'resolved', '6': 'resolved', 7: 'closed', '7': 'closed', 8: 'closed', '8': 'closed' };

function authHeaders(conn, auth) {
  return { authorization: basicAuthHeader(auth.username, auth.password) };
}

function tableUrl(conn, sysId) {
  const table = conn.field_mapping?.table || 'incident';
  return `${conn.base_url.replace(/\/$/, '')}/api/now/table/${table}${sysId ? `/${sysId}` : ''}`;
}

function deepLink(conn, sysId) {
  const table = conn.field_mapping?.table || 'incident';
  return `${conn.base_url.replace(/\/$/, '')}/nav_to.do?uri=${table}.do?sys_id=${sysId}`;
}

export async function testConnection(conn, auth) {
  try {
    await apiRequest(`${tableUrl(conn)}?sysparm_limit=1`, { headers: authHeaders(conn, auth) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ServiceNow's Table API always wraps a record in {result: {...}} on
// success. If that shape isn't there, the response wasn't the record we
// expected (wrong sys_id, an HTML login/redirect page from a mis-set-up
// instance, etc.) -- surface a clear reason instead of letting a raw
// property-access crash bubble up.
function unwrapResult(data, context) {
  const r = data?.result;
  if (!r || typeof r !== 'object' || Array.isArray(r)) {
    // Deliberately does NOT echo back whatever id was pasted, and avoids a
    // made-up "like INC0012345" example -- both read as if they were a
    // literal value to paste rather than an illustration of the format,
    // which is exactly what caused confusion here before.
    throw new Error(
      `ServiceNow did not return a record ${context}. This field needs the record's sys_id (a 32-character internal id), not its ticket number. `
      + `Open the record in ServiceNow and copy the value after "sys_id=" in the browser's address bar.`
    );
  }
  return r;
}

// Lets an admin paste EITHER the sys_id or the human-readable number
// (INC0010010) when linking an existing record -- ServiceNow's own query
// syntax can match on either field in one call, so there's no need to force
// someone to go find the internal sys_id first. `^OR` is ServiceNow's
// encoded-query syntax for "either condition matches".
export async function resolveExternalId(conn, auth, idOrNumber) {
  const table = conn.field_mapping?.table || 'incident';
  const query = `sys_id=${idOrNumber}^ORnumber=${idOrNumber}`;
  const url = `${conn.base_url.replace(/\/$/, '')}/api/now/table/${table}?sysparm_query=${encodeURIComponent(query)}&sysparm_limit=1`;
  const data = await apiRequest(url, { headers: authHeaders(conn, auth) });
  const match = data?.result?.[0];
  if (!match) {
    throw new Error(`No ${table} record found matching "${idOrNumber}" (checked both the number and the sys_id). Double check it exists and that this connection's ServiceNow user can see it.`);
  }
  return { external_id: match.sys_id, external_number: match.number, external_url: deepLink(conn, match.sys_id) };
}

export async function createTicket(conn, auth, ticket) {
  const body = {
    short_description: ticket.title,
    description: ticket.description || '',
    priority: PRIORITY_TO_SN[ticket.priority] || '3',
    state: STATUS_TO_SN[ticket.status] || '1',
  };
  const data = await apiRequest(tableUrl(conn), { method: 'POST', headers: authHeaders(conn, auth), body });
  const r = unwrapResult(data, 'after creating it');
  return { external_id: r.sys_id, external_number: r.number, external_url: deepLink(conn, r.sys_id) };
}

export async function updateTicket(conn, auth, link, patch) {
  const body = {};
  if (patch.title !== undefined) body.short_description = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.priority !== undefined) body.priority = PRIORITY_TO_SN[patch.priority] || '3';
  if (patch.status !== undefined) body.state = STATUS_TO_SN[patch.status] || '1';
  if (Object.keys(body).length === 0) return;
  await apiRequest(tableUrl(conn, link.external_id), { method: 'PATCH', headers: authHeaders(conn, auth), body });
}

export async function fetchTicket(conn, auth, link) {
  const data = await apiRequest(tableUrl(conn, link.external_id), { headers: authHeaders(conn, auth) });
  const r = unwrapResult(data, `for sys_id "${link.external_id}"`);
  return {
    title: r.short_description,
    description: r.description,
    priority: PRIORITY_FROM_SN[r.priority] || 'medium',
    status: STATUS_FROM_SN[r.state] || 'open',
  };
}

// ServiceNow "journal" fields (comments/work_notes) work differently from
// every other field on the record: PATCHing a new string onto `comments`
// APPENDS a new journal entry with a timestamp/author stamped on by the
// platform, rather than replacing the field's value -- this is genuine
// documented ServiceNow behavior, not a quirk of this adapter. Posted to
// `comments` specifically (not `work_notes`) since a Reply here is meant to
// be customer-visible on their side too.
export async function addComment(conn, auth, link, { body }) {
  await apiRequest(tableUrl(conn, link.external_id), { method: 'PATCH', headers: authHeaders(conn, auth), body: { comments: body } });
}

// Journal entries don't live on the incident record itself -- they're rows
// in sys_journal_field, queried by the record's sys_id and the field name.
export async function fetchComments(conn, auth, link) {
  const query = `element_id=${link.external_id}^element=comments`;
  const url = `${conn.base_url.replace(/\/$/, '')}/api/now/table/sys_journal_field?sysparm_query=${encodeURIComponent(query)}&sysparm_fields=sys_id,value,sys_created_by,sys_created_on&sysparm_orderby=sys_created_on`;
  const data = await apiRequest(url, { headers: authHeaders(conn, auth) });
  return (data?.result || []).map((j) => ({ external_comment_id: j.sys_id, author: j.sys_created_by, body: j.value, created_at: j.sys_created_on }));
}

// ServiceNow has no built-in generic "webhook subscription" API -- an admin
// wires this up themselves via a Business Rule / Flow Designer action on the
// incident table that POSTs this shape to our webhook URL. We document the
// expected body rather than pretend there's a standard subscribe call.
export function parseWebhookPayload(rawBody) {
  const r = rawBody?.result || rawBody;
  if (!r?.sys_id) throw new Error('Missing sys_id in ServiceNow webhook payload');
  return {
    external_id: r.sys_id,
    fields: {
      title: r.short_description,
      description: r.description,
      priority: r.priority !== undefined ? (PRIORITY_FROM_SN[r.priority] || 'medium') : undefined,
      status: r.state !== undefined ? (STATUS_FROM_SN[r.state] || 'open') : undefined,
    },
  };
}
