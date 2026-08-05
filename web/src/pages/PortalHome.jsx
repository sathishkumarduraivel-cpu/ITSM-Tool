import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ShoppingBag, BookOpen, Ticket } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';

export default function PortalHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const { tickets } = await api.get('/tickets');
      setTickets(tickets.filter((t) => t.requester_id === user.id));
      setLoading(false);
    })();
  }, [user.id]);

  const open = tickets.filter((t) => !['resolved', 'closed'].includes(t.status));
  const closed = tickets.filter((t) => ['resolved', 'closed'].includes(t.status));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800">Hi {user.name.split(' ')[0]} 👋</h1>
        <p className="text-sm text-slate-500">Submit requests, track tickets, and find answers — all in one place.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <button onClick={() => navigate('/catalog')} className="card p-5 text-left hover:shadow-md transition-shadow">
          <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center mb-3"><ShoppingBag size={18} /></div>
          <div className="font-medium text-slate-800">Browse Service Catalog</div>
          <div className="text-sm text-slate-500">Request hardware, software &amp; access</div>
        </button>
        <button onClick={() => navigate('/tickets')} className="card p-5 text-left hover:shadow-md transition-shadow">
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 flex items-center justify-center mb-3"><Plus size={18} /></div>
          <div className="font-medium text-slate-800">Report an issue</div>
          <div className="text-sm text-slate-500">Something broken? Log an incident</div>
        </button>
        <button onClick={() => navigate('/knowledge-base')} className="card p-5 text-left hover:shadow-md transition-shadow">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3"><BookOpen size={18} /></div>
          <div className="font-medium text-slate-800">Search Knowledge Base</div>
          <div className="text-sm text-slate-500">Find a quick answer yourself</div>
        </button>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5"><Ticket size={15} /> My open tickets ({open.length})</h3>
        {loading && <div className="text-sm text-slate-400 py-6 text-center">Loading…</div>}
        {!loading && open.length === 0 && <div className="text-sm text-slate-400 py-6 text-center">Nothing open right now.</div>}
        <div className="space-y-2">
          {open.map((t) => (
            <button key={t.id} onClick={() => navigate(`/tickets/${t.id}`)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50 text-left">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs text-slate-400">{t.number}</span>
                <span className="text-sm text-slate-700 truncate">{t.title}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <TypeBadge type={t.type} />
                <PriorityBadge priority={t.priority} />
                <StatusBadge status={t.status} />
              </div>
            </button>
          ))}
        </div>
      </div>

      {closed.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Recently closed</h3>
          <div className="space-y-2">
            {closed.slice(0, 5).map((t) => (
              <button key={t.id} onClick={() => navigate(`/tickets/${t.id}`)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50 text-left">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-slate-400">{t.number}</span>
                  <span className="text-sm text-slate-700 truncate">{t.title}</span>
                </div>
                <StatusBadge status={t.status} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
