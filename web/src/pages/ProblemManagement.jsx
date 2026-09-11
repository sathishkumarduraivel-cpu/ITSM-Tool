import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plus, Search } from 'lucide-react';
import { api } from '../lib/api.js';
import { PriorityBadge, StatusBadge } from '../components/Badge.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import NewTicketModal from '../components/NewTicketModal.jsx';
import { RevealGroup, RevealItem } from '../components/Reveal.jsx';
import Select from '../components/Select.jsx';

const STATUSES = ['open', 'pending_approval', 'in_progress', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

export default function ProblemManagement() {
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: '', priority: '', q: '' });
  const [showNew, setShowNew] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ type: 'problem' });
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      const { tickets } = await api.get(`/tickets?${params.toString()}`);
      setTickets(tickets);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.status, filters.priority]);

  const search = (e) => {
    e.preventDefault();
    load();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Problem Management"
        description="Root-cause investigations behind repeat incidents"
        actions={<button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New problem</button>}
      />

      <div className="card p-3 flex flex-wrap items-center gap-2">
        <form onSubmit={search} className="flex-1 min-w-[200px] relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            className="input pl-9"
            placeholder="Search problems…"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
        </form>
        <Select
          className="w-auto" value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })}
          options={[{ value: '', label: 'All statuses' }, ...STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') }))]}
        />
        <Select
          className="w-auto" value={filters.priority} onChange={(v) => setFilters({ ...filters, priority: v })}
          options={[{ value: '', label: 'All priorities' }, ...PRIORITIES.map((p) => ({ value: p, label: p }))]}
        />
      </div>

      {loading && <SkeletonRows count={5} />}

      {!loading && (
        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Problem</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-left px-4 py-2.5 font-medium">Priority</th>
                <th className="text-left px-4 py-2.5 font-medium">Category</th>
                <th className="text-left px-4 py-2.5 font-medium">Team</th>
                <th className="text-left px-4 py-2.5 font-medium">Updated</th>
              </tr>
            </thead>
            <RevealGroup as={motion.tbody}>
              {tickets.length === 0 && (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">No problems match these filters.</td></tr>
              )}
              {tickets.map((t) => (
                <RevealItem
                  key={t.id}
                  as={motion.tr}
                  onClick={() => navigate(`/tickets/${t.id}`)}
                  className="border-t border-slate-100 dark:border-slate-800 row-interactive"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-800 dark:text-slate-100">{t.number}</div>
                    <div className="text-slate-500 text-xs truncate max-w-xs">{t.title}</div>
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={t.status} /></td>
                  <td className="px-4 py-2.5"><PriorityBadge priority={t.priority} /></td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{t.category || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{t.team || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-400 text-xs">{new Date(t.updated_at).toLocaleString()}</td>
                </RevealItem>
              ))}
            </RevealGroup>
          </table>
        </div>
      )}

      {showNew && (
        <NewTicketModal
          availableTypes={['problem']}
          onClose={() => setShowNew(false)}
          onCreated={(ticket) => {
            setShowNew(false);
            navigate(`/tickets/${ticket.id}`);
          }}
        />
      )}
    </div>
  );
}
