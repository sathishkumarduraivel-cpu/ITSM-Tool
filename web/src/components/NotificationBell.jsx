import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { api } from '../lib/api.js';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const ref = useRef(null);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const { notifications, unread } = await api.get('/notifications');
      setItems(notifications);
      setUnread(unread);
    } catch {
      // ignore — notifications are best-effort
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const openItem = async (n) => {
    if (!n.read) await api.post(`/notifications/${n.id}/read`, {});
    setOpen(false);
    load();
    if (n.link) navigate(n.link);
  };

  const readAll = async (e) => {
    e.stopPropagation();
    await api.post('/notifications/read-all', {});
    load();
  };

  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} className="relative text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100 p-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] leading-none rounded-full w-4 h-4 flex items-center justify-center">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 card shadow-popover dark:shadow-popover-dark animate-pop-in z-50 max-h-96 overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800">
            <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Notifications</span>
            <button onClick={readAll} className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1">
              <CheckCheck size={12} /> Mark all read
            </button>
          </div>
          {items.length === 0 && <div className="text-sm text-slate-400 text-center py-8">You're all caught up.</div>}
          {items.map((n) => (
            <button
              key={n.id}
              onClick={() => openItem(n)}
              className={`w-full text-left px-3 py-2.5 border-b border-slate-50 dark:border-slate-800/60 hover:bg-slate-50 dark:hover:bg-slate-800/60 ${!n.read ? 'bg-brand-50/40 dark:bg-brand-500/5' : ''}`}
            >
              <div className="flex items-start gap-2">
                {!n.read && <span className="w-1.5 h-1.5 rounded-full bg-brand-600 mt-1.5 shrink-0" />}
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{n.title}</div>
                  <div className="text-xs text-slate-500 line-clamp-2">{n.body}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{new Date(n.created_at).toLocaleString()}</div>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
