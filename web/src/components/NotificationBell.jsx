import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell, CheckCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from '../lib/api.js';
import { RevealGroup, RevealItem } from './Reveal.jsx';
import { useRealtimeEvent } from '../context/RealtimeContext.jsx';

export default function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [ringing, setRinging] = useState(false);
  const ref = useRef(null);
  const prevUnread = useRef(0);
  const hasLoadedOnce = useRef(false);
  const navigate = useNavigate();

  const load = async () => {
    try {
      const { notifications, unread } = await api.get('/notifications');
      setItems(notifications);
      // A real increase after the initial load gets a quick shake -- a
      // genuinely new alert should feel like it just landed, but simply
      // opening the app with existing unread items shouldn't.
      if (hasLoadedOnce.current && unread > prevUnread.current) {
        setRinging(true);
        setTimeout(() => setRinging(false), 600);
      }
      hasLoadedOnce.current = true;
      prevUnread.current = unread;
      setUnread(unread);
    } catch {
      // ignore — notifications are best-effort
    }
  };

  useEffect(() => {
    load();
    // Real-time push (below) is the primary trigger now -- this poll just
    // stays as a fallback in case a connection drops silently.
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, []);

  useRealtimeEvent('notification.new', () => load());

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
        <motion.div animate={ringing ? { rotate: [0, -16, 14, -10, 8, -4, 0] } : { rotate: 0 }} transition={{ duration: 0.6, ease: 'easeInOut' }}>
          <Bell size={18} />
        </motion.div>
        <AnimatePresence>
          {unread > 0 && (
            <motion.span
              key="badge"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              exit={{ scale: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 20 }}
              className="absolute -top-0.5 -right-0.5 bg-red-500 text-white text-[10px] leading-none rounded-full w-4 h-4 flex items-center justify-center"
            >
              {unread > 9 ? '9+' : unread}
            </motion.span>
          )}
        </AnimatePresence>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="absolute right-0 mt-2 w-80 card shadow-popover dark:shadow-popover-dark z-50 max-h-96 overflow-y-auto"
          >
            <div className="flex items-center justify-between px-3 py-2 border-b border-slate-100 dark:border-slate-800">
              <span className="text-sm font-semibold text-slate-700 dark:text-slate-200">Notifications</span>
              <button onClick={readAll} className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1">
                <CheckCheck size={12} /> Mark all read
              </button>
            </div>
            {items.length === 0 && <div className="text-sm text-slate-400 text-center py-8">You're all caught up.</div>}
            <RevealGroup>
              {items.map((n) => (
                <RevealItem
                  key={n.id}
                  as={motion.button}
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
                </RevealItem>
              ))}
            </RevealGroup>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
