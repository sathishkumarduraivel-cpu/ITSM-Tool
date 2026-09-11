import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import { getStoredToken } from '../lib/api.js';

const RealtimeContext = createContext(null);

// One EventSource per session, opened once here and shared via context --
// every SSE broadcast the server sends (see server/src/services/realtime.js)
// arrives as a named event (`ticket.updated`, `notification.new`, etc.), and
// any component anywhere can listen for just the ones it cares about via
// useRealtimeEvent below without knowing anything about the connection
// itself. Recreated whenever the signed-in user or their active workspace
// changes, since the stream's auth token is workspace-scoped (see
// server/src/middleware/auth.js) and switching workspaces re-issues one.
export function RealtimeProvider({ children }) {
  const { user } = useAuth();
  const [source, setSource] = useState(null);

  useEffect(() => {
    if (!user) { setSource(null); return undefined; }
    const token = getStoredToken();
    if (!token) return undefined;
    const es = new EventSource(`/api/realtime/stream?token=${encodeURIComponent(token)}`);
    setSource(es);
    return () => {
      es.close();
      setSource(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.workspace_id]);

  return <RealtimeContext.Provider value={source}>{children}</RealtimeContext.Provider>;
}

// Subscribe to one named real-time event for as long as the calling
// component is mounted. `handler` receives the already-parsed JSON payload,
// never the raw SSE MessageEvent -- callers never touch transport details.
// Payloads are intentionally minimal (ids only, see the server side), so a
// handler should treat this purely as "go re-fetch", never as authoritative
// content.
export function useRealtimeEvent(eventName, handler) {
  const source = useContext(RealtimeContext);
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!source) return undefined;
    const listener = (e) => {
      try { handlerRef.current(JSON.parse(e.data)); } catch { /* malformed frame -- ignore */ }
    };
    source.addEventListener(eventName, listener);
    return () => source.removeEventListener(eventName, listener);
  }, [source, eventName]);
}
