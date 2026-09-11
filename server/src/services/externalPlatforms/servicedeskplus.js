// ManageEngine ServiceDesk Plus adapter -- REST API v3.
// Docs: https://www.manageengine.com/products/service-desk/sdpod-v3-api/
// Auth: Technician Key sent via the `TECHNICIAN_KEY` header (on-premise --
// generate one under Admin > Technicians > edit technician > API Key). Cloud
// SDP uses OAuth instead, out of scope here same as the other platforms'
// simple-auth-only choice. auth_config shape: { api_key }.
// SDP's v3 write endpoints wrap the payload in a single `input_data` form
// field containing JSON rather than a raw JSON body -- a well-documented
// quirk of ManageEngine's REST API -- so this adapter builds its own request
// bodies for writes instead of routing through httpClient's apiRequest,
// which always sends plain JSON.
import fetch from 'node-fetch';
import { apiRequest } from './httpClient.js';

const PRIORITY_TO_SDP = { low: 'Low', medium: 'Medium', high: 'High', critical: 'Urgent' };
const PRIORITY_FROM_SDP = { Low: 'low', Medium: 'medium', High: 'high', Urgent: 'critical' };

// Default out-of-the-box SDP request statuses. A real instance can rename or
// add statuses; not overridable here, same tradeoff made for the other
// adapters' status maps.
const STATUS_TO_SDP = { open: 'Open', in_progress: 'In Progress', on_hold: 'On Hold', resolved: 'Resolved', closed: 'Closed' };
const STATUS_FROM_SDP = { Open: 'open', 'In Progress': 'in_progress', 'On Hold': 'on_hold', Resolved: 'resolved', Closed: 'closed' };

function authHeaders(auth) {
  return { TECHNICIAN_KEY: auth.api_key };
}

function requestsUrl(conn, id) {
  return `${conn.base_url.replace(/\/$/, '')}/api/v3/requests${id ? `/${id}` : ''}`;
}

function deepLink(conn, id) {
  return `${conn.base_url.replace(/\/$/, '')}/WorkOrder.do?woMode=viewWO&woID=${id}`;
}

async function writeRequest(url, method, auth, payload) {
  const resp = await fetch(url, {
    method,
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded', ...authHeaders(auth) },
    body: `input_data=${encodeURIComponent(JSON.stringify(payload))}`,
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  const status = Array.isArray(data?.response_status) ? data.response_status[0] : data?.response_status;
  if (!resp.ok || status?.status === 'failed') {
    const message = status?.messages?.[0]?.message || `${method} ${url} failed (${resp.status})`;
    throw new Error(message);
  }
  return data;
}

export async function testConnection(conn, auth) {
  try {
    const listInfo = encodeURIComponent(JSON.stringify({ list_info: { row_count: 1 } }));
    await apiRequest(`${requestsUrl(conn)}?input_data=${listInfo}`, { headers: authHeaders(auth) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function createTicket(conn, auth, ticket) {
  const requesterEmail = conn.field_mapping?.default_requester_email;
  if (!requesterEmail) throw new Error('This ServiceDesk Plus connection has no default_requester_email configured in its field mapping (SDP requires a requester on every request)');
  const payload = {
    request: {
      subject: ticket.title,
      description: ticket.description || '',
      requester: { email_id: requesterEmail },
      priority: { name: PRIORITY_TO_SDP[ticket.priority] || 'Medium' },
      status: { name: STATUS_TO_SDP[ticket.status] || 'Open' },
    },
  };
  const data = await writeRequest(requestsUrl(conn), 'POST', auth, payload);
  const r = data?.request;
  if (!r?.id) throw new Error('ServiceDesk Plus did not return a created request — it may not have reached SDP correctly.');
  return { external_id: String(r.id), external_number: `#${r.id}`, external_url: deepLink(conn, r.id) };
}

export async function updateTicket(conn, auth, link, patch) {
  const request = {};
  if (patch.title !== undefined) request.subject = patch.title;
  if (patch.description !== undefined) request.description = patch.description;
  if (patch.priority !== undefined) request.priority = { name: PRIORITY_TO_SDP[patch.priority] || 'Medium' };
  if (patch.status !== undefined) request.status = { name: STATUS_TO_SDP[patch.status] || 'Open' };
  if (Object.keys(request).length === 0) return;
  await writeRequest(requestsUrl(conn, link.external_id), 'PUT', auth, { request });
}

export async function fetchTicket(conn, auth, link) {
  const data = await apiRequest(requestsUrl(conn, link.external_id), { headers: authHeaders(auth) });
  const r = data?.request;
  if (!r?.id) {
    throw new Error(`ServiceDesk Plus did not return a request for id "${link.external_id}". Make sure you pasted the request's numeric id.`);
  }
  return {
    title: r.subject,
    description: r.description,
    priority: PRIORITY_FROM_SDP[r.priority?.name] || 'medium',
    status: STATUS_FROM_SDP[r.status?.name] || 'open',
  };
}

// SDP's "Add Note" API -- `show_to_requester: true` mirrors the other
// adapters' choice to push a Reply as a customer-visible note, not an
// internal-only one.
export async function addComment(conn, auth, link, { body }) {
  await writeRequest(`${requestsUrl(conn, link.external_id)}/notes`, 'POST', auth, {
    request_note: { description: body, show_to_requester: true },
  });
}

export async function fetchComments(conn, auth, link) {
  const data = await apiRequest(`${requestsUrl(conn, link.external_id)}/notes`, { headers: authHeaders(auth) });
  const notes = data?.request_notes || data?.notes || [];
  return notes.map((n) => ({
    external_comment_id: String(n.id),
    author: n.created_by?.name || 'ServiceDesk Plus',
    body: n.description,
    created_at: n.created_time?.display_value,
  }));
}

// SDP has no built-in generic webhook-subscription API -- an admin wires
// this up via a Business Rule / Custom Trigger that POSTs this shape to our
// webhook URL. We document the expected body rather than assume a fixed
// subscribe call.
export function parseWebhookPayload(rawBody) {
  const r = rawBody?.request || rawBody;
  if (!r?.id) throw new Error('Missing request.id in ServiceDesk Plus webhook payload');
  return {
    external_id: String(r.id),
    fields: {
      title: r.subject,
      description: r.description,
      priority: r.priority?.name !== undefined ? (PRIORITY_FROM_SDP[r.priority.name] || 'medium') : undefined,
      status: r.status?.name !== undefined ? (STATUS_FROM_SDP[r.status.name] || 'open') : undefined,
    },
  };
}
