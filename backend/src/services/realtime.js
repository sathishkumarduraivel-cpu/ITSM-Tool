// Server-Sent Events hub -- one long-lived HTTP response per connected
// client, server pushes `event: name\ndata: json\n\n` frames down it. Chosen
// over WebSockets deliberately: everything that needs to go the OTHER way
// (create/edit/delete) already goes through the existing REST routes, so the
// only new wire is server-to-client push -- SSE covers that with zero new
// dependencies (it's plain HTTP, Express already speaks it), no separate
// port/protocol upgrade, and reconnects automatically in every browser via
// the native EventSource API. In-memory only (no persistence, no queue) --
// exactly like every other piece of live state in this app, a client that
// wasn't connected when an event fired just sees the current state on its
// next normal fetch, the same "eventually consistent on next read" tradeoff
// already made throughout (SLA breach, escalations, etc).
const connections = new Map(); // connectionId -> { res, workspaceId, userId }
let nextId = 1;

export function subscribe(workspaceId, userId, res) {
  const id = nextId++;
  connections.set(id, { res, workspaceId, userId });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx buffering if ever proxied through one
  });
  res.write(': connected\n\n');

  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(heartbeat); }
  }, 25000);

  res.req.on('close', () => {
    clearInterval(heartbeat);
    connections.delete(id);
  });

  return id;
}

function write(res, event, payload) {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  } catch {
    // connection died between the close handler firing and this write --
    // harmless, it'll be cleaned up by the 'close' listener momentarily.
  }
}

// Everyone currently connected from this workspace (any user) -- for
// changes that are visible workspace-wide, like a ticket update. Payloads
// are deliberately minimal (ids, never full ticket content) so a client
// always re-fetches through the normal, permission-checked REST route
// rather than trusting broadcast data as if it were authorized content.
export function broadcastToWorkspace(workspaceId, event, payload) {
  for (const conn of connections.values()) {
    if (conn.workspaceId === workspaceId) write(conn.res, event, payload);
  }
}

// Just one user's own connections (they may have several tabs open) -- for
// things that are only ever theirs, like a new notification.
export function sendToUser(workspaceId, userId, event, payload) {
  for (const conn of connections.values()) {
    if (conn.workspaceId === workspaceId && conn.userId === userId) write(conn.res, event, payload);
  }
}

// Real presence, not a proxy for it -- "online" means this user currently
// has an open SSE connection (RealtimeContext.jsx opens exactly one for the
// whole signed-in session, recreated on login/workspace switch, so this
// reflects "has the app open right now" regardless of which page they're
// on). Used by the dashboard's team roster (routes/ai.js) instead of
// guessing from unrelated data like ticket assignment.
export function getOnlineUserIds(workspaceId) {
  const ids = new Set();
  for (const conn of connections.values()) {
    if (conn.workspaceId === workspaceId) ids.add(conn.userId);
  }
  return ids;
}
