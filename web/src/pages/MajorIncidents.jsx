import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Siren, AlertTriangle, Clock } from 'lucide-react';
import { api } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SeverityBadge, MiStatusBadge } from '../components/Badge.jsx';

const STATUS_FILTERS = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'monitoring', label: 'Monitoring' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

export default function MajorIncidents() {
  const [items, setItems] = useState(null);
  const [status, setStatus] = useState('');

  const load = async () => {
    const params = status ? `?status=${status}` : '';
    const { majorIncidents } = await api.get(`/major-incidents${params}`);
    setItems(majorIncidents);
  };
  useEffect(() => { load(); }, [status]);

  return (
    <div className="space-y-4">
      <PageHeader title="Major Incidents" description="Declared outages with a commander, a communication cadence, and a post-incident review" />

      <div className="flex gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatus(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${status === f.key ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {items === null ? (
        <div className="text-slate-400 text-sm py-20 text-center">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState icon={Siren} title="No major incidents" description="Declare one from an incident ticket when something breaks big." />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((mi) => (
            <Link key={mi.id} to={`/major-incidents/${mi.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40">
              <Siren size={16} className={mi.status === 'active' ? 'text-red-500 shrink-0' : 'text-slate-400 shrink-0'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{mi.number}</span>
                  <SeverityBadge severity={mi.severity} />
                  <MiStatusBadge status={mi.status} />
                  {mi.updateOverdue && (
                    <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400 flex items-center gap-1"><AlertTriangle size={11} /> update overdue</span>
                  )}
                  {mi.pirOverdue && (
                    <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 flex items-center gap-1"><Clock size={11} /> PIR overdue</span>
                  )}
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-300 truncate">{mi.summary}</div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {mi.ticket ? `${mi.ticket.number} · ` : ''}{mi.commander_name ? `Commander: ${mi.commander_name} · ` : ''}Declared {new Date(mi.declared_at).toLocaleString()}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
