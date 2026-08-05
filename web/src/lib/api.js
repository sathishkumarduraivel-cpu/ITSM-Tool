const BASE = '/api';

function getToken() {
  return localStorage.getItem('itsm_token');
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const token = getToken();
  const resp = await fetch(`${BASE}${path}`, {
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
    throw new Error(message);
  }
  return data;
}

async function upload(path, formData) {
  const token = getToken();
  const resp = await fetch(`${BASE}${path}`, {
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
  if (!resp.ok) throw new Error(data?.error || `Request failed (${resp.status})`);
  return data;
}

export const api = {
  get: (path) => request(path),
  post: (path, body) => request(path, { method: 'POST', body }),
  patch: (path, body) => request(path, { method: 'PATCH', body }),
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
