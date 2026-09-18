const BASE = '/api';

function getToken() {
  return localStorage.getItem('itsm_token');
}

function notifyError(message) {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('itsm:toast', { detail: { message, type: 'error' } }));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A bare 500 with no parseable {error} body is never something this app's
// own routes produce -- every real app error responds with JSON like
// {"error": "..."} (see server/src/index.js's error handler and every route
// file). That exact shape only shows up when the dev proxy (Vite) couldn't
// reach the backend at all -- e.g. mid-restart from `node --watch`, or a
// brief window right after the machine wakes from sleep -- and it fails
// before the request ever reaches app logic, so a retry is safe even for
// POST/PATCH/DELETE. A real network-level failure (fetch throws outright)
// is the same signature. One retry after a short pause is enough to make
// these transient blips invisible instead of surfacing as "Request failed
// (500)" for something that already recovered by the time a human reads it.
async function fetchWithRetry(url, init) {
  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = await fetch(url, init);
    } catch (networkError) {
      if (attempt > 0) throw networkError;
      await sleep(700);
      continue;
    }
    if (resp.status === 500 && attempt === 0) {
      const clone = resp.clone();
      let data = null;
      try { data = await clone.json(); } catch { /* not JSON -- proxy error page */ }
      if (!data?.error) {
        await sleep(700);
        continue;
      }
    }
    return resp;
  }
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const token = getToken();
  const resp = await fetchWithRetry(`${BASE}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const message = data?.error || `Request failed (${resp.status})`;
    notifyError(message);
    throw new Error(message);
  }
  return data;
}

async function upload(path, formData) {
  const token = getToken();
  const resp = await fetchWithRetry(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: formData,
  });
  let data = null;
  try {
    data = await resp.json();
  } catch {
    data = null;
  }
  if (!resp.ok) {
    const message = data?.error || `Request failed (${resp.status})`;
    notifyError(message);
    throw new Error(message);
  }
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
  put: (path, body) => request(path, { method: 'PUT', body }),
  del: (path) => request(path, { method: 'DELETE' }),
  upload,
};

export function setToken(token) {
  if (token) localStorage.setItem('itsm_token', token);
  else localStorage.removeItem('itsm_token');
}

export function getStoredToken() {
  return getToken();
}
