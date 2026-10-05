// Jira Cloud adapter -- REST API v3.
// Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
// Auth: Basic, base64("email:api_token") -- Jira Cloud's standard API-token
// auth (no OAuth app install needed). auth_config shape: { email, api_token }.
// field_mapping shape: { project_key, issue_type } (issue_type defaults to "Task").
import { apiRequest, basicAuthHeader } from './httpClient.js';

const PRIORITY_TO_JIRA = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low' };
const PRIORITY_FROM_JIRA = { highest: 'critical', high: 'high', medium: 'medium', low: 'low', lowest: 'low' };

// Jira statuses are workflow-defined, not a fixed enum -- this is a
// best-effort heuristic over common default-workflow status names, used for
// inbound mapping and for picking an outbound transition target by name.
const STATUS_FROM_JIRA_NAME = {
  'to do': 'open', open: 'open', backlog: 'open',
  'in progress': 'in_progress', 'in review': 'in_progress',
  blocked: 'on_hold', 'on hold': 'on_hold',
  done: 'resolved', resolved: 'resolved',
  closed: 'closed',
};
const STATUS_TO_JIRA_NAME_CANDIDATES = {
  open: ['To Do', 'Open', 'Backlog'],
  in_progress: ['In Progress'],
  on_hold: ['Blocked', 'On Hold'],
  resolved: ['Done', 'Resolved'],
  closed: ['Closed'],
};

function authHeaders(auth) {
  return { authorization: basicAuthHeader(auth.email, auth.api_token) };
}

function issueUrl(conn, key) {
  return `${conn.base_url.replace(/\/$/, '')}/rest/api/3/issue${key ? `/${key}` : ''}`;
}

function toADF(text) {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] };
}

// Best-effort: ADF -> plain text (just concatenates text nodes), enough to
// round-trip a description we ourselves wrote as plain text.
function fromADF(adf) {
  if (!adf || typeof adf === 'string') return adf || '';
  const out = [];
  const walk = (node) => {
    if (node.text) out.push(node.text);
    if (Array.isArray(node.content)) node.content.forEach(walk);
  };
  walk(adf);
  return out.join(' ');
}

export async function testConnection(conn, auth) {
  try {
    await apiRequest(`${conn.base_url.replace(/\/$/, '')}/rest/api/3/myself`, { headers: authHeaders(auth) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function createTicket(conn, auth, ticket) {
  const projectKey = conn.field_mapping?.project_key;
  if (!projectKey) throw new Error('This Jira connection has no project_key configured in its field mapping');
  const body = {
    fields: {
      project: { key: projectKey },
      issuetype: { name: conn.field_mapping?.issue_type || 'Task' },
      summary: ticket.title,
      description: toADF(ticket.description || ''),
      priority: { name: PRIORITY_TO_JIRA[ticket.priority] || 'Medium' },
    },
  };
  const data = await apiRequest(issueUrl(conn), { method: 'POST', headers: authHeaders(auth), body });
  if (!data?.key) throw new Error('Jira did not return a created issue key — the request may not have reached Jira correctly.');
  return { external_id: data.id, external_number: data.key, external_url: `${conn.base_url.replace(/\/$/, '')}/browse/${data.key}` };
}

async function transitionTo(conn, auth, key, ourStatus) {
  const candidates = STATUS_TO_JIRA_NAME_CANDIDATES[ourStatus] || [];
  if (!candidates.length) return;
  const { transitions } = await apiRequest(`${issueUrl(conn, key)}/transitions`, { headers: authHeaders(auth) });
  const match = transitions.find((t) => candidates.some((c) => t.name.toLowerCase() === c.toLowerCase() || t.to?.name?.toLowerCase() === c.toLowerCase()));
  if (!match) return; // no matching transition on this issue's workflow -- leave status alone rather than fail the whole push
  await apiRequest(`${issueUrl(conn, key)}/transitions`, { method: 'POST', headers: authHeaders(auth), body: { transition: { id: match.id } } });
}

export async function updateTicket(conn, auth, link, patch) {
  const fields = {};
  if (patch.title !== undefined) fields.summary = patch.title;
  if (patch.description !== undefined) fields.description = toADF(patch.description);
  if (patch.priority !== undefined) fields.priority = { name: PRIORITY_TO_JIRA[patch.priority] || 'Medium' };
  if (Object.keys(fields).length) {
    await apiRequest(issueUrl(conn, link.external_number), { method: 'PUT', headers: authHeaders(auth), body: { fields } });
  }
  if (patch.status !== undefined) {
    await transitionTo(conn, auth, link.external_number, patch.status);
  }
}

export async function fetchTicket(conn, auth, link) {
  const data = await apiRequest(`${issueUrl(conn, link.external_number)}?fields=summary,description,status,priority`, { headers: authHeaders(auth) });
  const f = data?.fields;
  if (!f || typeof f !== 'object') {
    throw new Error(`Jira did not return an issue for "${link.external_number}". Make sure you pasted the issue key (e.g. PROJ-123), not an internal id or ticket number.`);
  }
  return {
    title: f.summary,
    description: fromADF(f.description),
    priority: PRIORITY_FROM_JIRA[f.priority?.name?.toLowerCase()] || 'medium',
    status: STATUS_FROM_JIRA_NAME[f.status?.name?.toLowerCase()] || 'open',
  };
}

export async function addComment(conn, auth, link, { body }) {
  await apiRequest(`${issueUrl(conn, link.external_number)}/comment`, { method: 'POST', headers: authHeaders(auth), body: { body: toADF(body) } });
}

export async function fetchComments(conn, auth, link) {
  const data = await apiRequest(`${issueUrl(conn, link.external_number)}/comment`, { headers: authHeaders(auth) });
  return (data?.comments || []).map((c) => ({ external_comment_id: c.id, author: c.author?.displayName, body: fromADF(c.body), created_at: c.created }));
}

// Real Jira webhook payload shape (Admin > System > WebHooks), events
// jira:issue_updated / jira:issue_created.
export function parseWebhookPayload(rawBody) {
  const issue = rawBody?.issue;
  if (!issue?.key) throw new Error('Missing issue.key in Jira webhook payload');
  const f = issue.fields || {};
  return {
    external_id: issue.key,
    fields: {
      title: f.summary,
      description: f.description !== undefined ? fromADF(f.description) : undefined,
      priority: f.priority?.name ? (PRIORITY_FROM_JIRA[f.priority.name.toLowerCase()] || 'medium') : undefined,
      status: f.status?.name ? (STATUS_FROM_JIRA_NAME[f.status.name.toLowerCase()] || 'open') : undefined,
    },
  };
}
