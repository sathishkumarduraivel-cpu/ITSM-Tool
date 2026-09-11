// Freshservice adapter -- API v2.
// Docs: https://api.freshservice.com/
// Auth: Basic, API key as the username, literal "X" as the password --
// Freshservice's documented API-key auth scheme. auth_config shape: { api_key }.
// Freshservice requires a requester email on every ticket; field_mapping
// shape: { default_requester_email, group_id? }.
import { apiRequest, basicAuthHeader } from './httpClient.js';

const PRIORITY_TO_FS = { low: 1, medium: 2, high: 3, critical: 4 };
const PRIORITY_FROM_FS = { 1: 'low', 2: 'medium', 3: 'high', 4: 'critical' };

// Freshservice's out-of-the-box ticket status codes. Instances can add
// custom statuses, overridable via field_mapping.status_map if needed.
const STATUS_TO_FS = { open: 2, in_progress: 2, on_hold: 3, resolved: 4, closed: 5 };
const STATUS_FROM_FS = { 2: 'open', 3: 'on_hold', 4: 'resolved', 5: 'closed' };

function authHeaders(auth) {
  return { authorization: basicAuthHeader(auth.api_key, 'X') };
}

function ticketUrl(conn, id) {
  return `${conn.base_url.replace(/\/$/, '')}/api/v2/tickets${id ? `/${id}` : ''}`;
}

export async function testConnection(conn, auth) {
  try {
    await apiRequest(`${ticketUrl(conn)}?per_page=1`, { headers: authHeaders(auth) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function createTicket(conn, auth, ticket) {
  const email = conn.field_mapping?.default_requester_email;
  if (!email) throw new Error('This Freshservice connection has no default_requester_email configured in its field mapping (Freshservice requires a requester on every ticket)');
  const body = {
    subject: ticket.title,
    description: ticket.description || '',
    email,
    priority: PRIORITY_TO_FS[ticket.priority] || 2,
    status: STATUS_TO_FS[ticket.status] || 2,
    ...(conn.field_mapping?.group_id ? { group_id: conn.field_mapping.group_id } : {}),
  };
  const data = await apiRequest(ticketUrl(conn), { method: 'POST', headers: authHeaders(auth), body });
  if (!data?.ticket?.id) throw new Error('Freshservice did not return a created ticket — the request may not have reached Freshservice correctly.');
  const t = data.ticket;
  return { external_id: String(t.id), external_number: `#${t.id}`, external_url: `${conn.base_url.replace(/\/$/, '')}/helpdesk/tickets/${t.id}` };
}

export async function updateTicket(conn, auth, link, patch) {
  const body = {};
  if (patch.title !== undefined) body.subject = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.priority !== undefined) body.priority = PRIORITY_TO_FS[patch.priority] || 2;
  if (patch.status !== undefined) body.status = STATUS_TO_FS[patch.status] || 2;
  if (Object.keys(body).length === 0) return;
  await apiRequest(ticketUrl(conn, link.external_id), { method: 'PUT', headers: authHeaders(auth), body });
}

export async function fetchTicket(conn, auth, link) {
  const data = await apiRequest(ticketUrl(conn, link.external_id), { headers: authHeaders(auth) });
  if (!data?.ticket?.id) {
    throw new Error(`Freshservice did not return a ticket for id "${link.external_id}". Make sure you pasted the ticket's numeric id, not its full display number.`);
  }
  const t = data.ticket;
  return {
    title: t.subject,
    description: t.description_text || t.description,
    priority: PRIORITY_FROM_FS[t.priority] || 'medium',
    status: STATUS_FROM_FS[t.status] || 'open',
  };
}

// Freshservice separates a customer-visible "reply" from an agent-only
// "note" -- a Reply here is meant to reach the requester, so it posts
// through the reply endpoint rather than the private-notes one.
export async function addComment(conn, auth, link, { body }) {
  await apiRequest(`${ticketUrl(conn, link.external_id)}/reply`, { method: 'POST', headers: authHeaders(auth), body: { body } });
}

export async function fetchComments(conn, auth, link) {
  const data = await apiRequest(`${ticketUrl(conn, link.external_id)}/conversations`, { headers: authHeaders(auth) });
  return (data?.conversations || []).map((c) => ({
    external_comment_id: String(c.id),
    author: c.from_email || 'Freshservice',
    body: c.body_text || c.body,
    created_at: c.created_at,
  }));
}

// Freshservice webhooks are admin-configured via Automations (ticket
// workflows) -- we document the expected payload shape (mirrors their own
// ticket object) rather than assume a fixed subscription API.
export function parseWebhookPayload(rawBody) {
  const t = rawBody?.ticket || rawBody;
  if (!t?.id) throw new Error('Missing ticket.id in Freshservice webhook payload');
  return {
    external_id: String(t.id),
    fields: {
      title: t.subject,
      description: t.description_text || t.description,
      priority: t.priority !== undefined ? (PRIORITY_FROM_FS[t.priority] || 'medium') : undefined,
      status: t.status !== undefined ? (STATUS_FROM_FS[t.status] || 'open') : undefined,
    },
  };
}
