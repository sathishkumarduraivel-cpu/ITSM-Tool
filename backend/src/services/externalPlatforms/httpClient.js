// Small shared request helper for the platform adapters -- just enough to
// avoid repeating fetch/JSON/error boilerplate three times. Each adapter
// still owns its own URL shapes, field mapping and auth header construction.
import fetch from 'node-fetch';

export function basicAuthHeader(user, pass) {
  return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
}

export async function apiRequest(url, { method = 'GET', headers = {}, body } = {}) {
  const resp = await fetch(url, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!resp.ok) {
    const message = (data && (data.error || data?.errorMessages?.[0] || data?.error_summary || data?.message)) || `${method} ${url} failed (${resp.status})`;
    throw new Error(typeof message === 'string' ? message : JSON.stringify(message));
  }
  return data;
}
