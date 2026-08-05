import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, X, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';

const ALL_TYPES = ['incident', 'request', 'problem', 'change'];
const STATUSES = ['open', 'pending_approval', 'in_progress', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const RISKS = ['low', 'medium', 'high'];

function NewTicketModal({ onClose, onCreated, availableTypes }) {
  const [form, setForm] = useState({ title: '', description: '', type: availableTypes[0], priority: 'medium', category: '', risk: 'medium', planned_start: '', planned_end: '', rollback_plan: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isChange = form.type === 'change';

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { ticket } = await api.post('/tickets', form);
      onCreated(ticket);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4 py-8 overflow-y-auto">
      <form onSubmit={submit} className="card w-full max-w-lg p-5 space-y-3 my-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">New ticket</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600">
            <X size={18} />
          </button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Title</label>
          <input className="input" required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Type</label>
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {availableTypes.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Priority</label>
            <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Category</label>
            <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Optional" />
          </div>
        </div>

        {isChange && (
          <div className="space-y-3 border-t border-slate-100 pt-3">
            <p className="text-xs text-slate-500">Change requests go through Change Advisory Board approval before they can move to in-progress.</p>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="label">Risk</label>
                <select className="input" value={form.risk} onChange={(e) => setForm({ ...form, risk: e.target.value })}>
                  {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Planned start</label>
                <input type="datetime-local" className="input" value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} />
              </div>
              <div>
                <label className="label">Planned end</label>
                <input type="datetime-local" className="input" value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} />
              </div>
            </div>
            <div>
              <label className="label">Rollback plan</label>
              <textarea className="input" rows={2} value={form.rollback_plan} onChange={(e) => setForm({ ...form, rollback_plan: e.target.value })} />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create ticket
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Tickets() {
  const { user } = useAuth();
  const isAgent = user.role === 'admin' || user.role === 'agent';
  const availableTypes = isAgent ? ALL_TYPES : ['incident', 'request'];
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ status: '', priority: '', type: '', q: '' });
  const [showNew, setShowNew] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    const { tickets } = await api.get(`/tickets?${params.toString()}`);
    setTickets(isAgent ? tickets : tickets.filter((t) => t.requester_id === user.id));
    setLoading(false);
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.status, filters.priority, filters.type]);

  const search = (e) => {
    e.preventDefault();
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Tickets</h1>
          <p className="text-sm text-slate-500">Incidents, requests, problems &amp; changes</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary">
          <Plus size={14} /> New ticket
        </button>
      </div>

      <div className="card p-3 flex flex-wrap items-center gap-2">
        <form onSubmit={search} className="flex-1 min-w-[200px] relative">
          <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            className="input pl-8"
            placeholder="Search tickets…"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          />
        </form>
        <select className="input w-auto" value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}>
          <option value="">All types</option>
          {ALL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="input w-auto" value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}>
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
        </select>
        <select className="input w-auto" value={filters.priority} onChange={(e) => setFilters({ ...filters, priority: e.target.value })}>
          <option value="">All priorities</option>
          {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Ticket</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-left px-4 py-2.5 font-medium">Priority</th>
              <th className="text-left px-4 py-2.5 font-medium">Category</th>
              <th className="text-left px-4 py-2.5 font-medium">Updated</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} className="text-center py-10 text-slate-400">Loading…</td></tr>
            )}
            {!loading && tickets.length === 0 && (
              <tr><td colSpan={6} className="text-center py-10 text-slate-400">No tickets match these filters.</td></tr>
            )}
            {!loading && tickets.map((t) => (
              <tr
                key={t.id}
                onClick={() => navigate(`/tickets/${t.id}`)}
                className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
              >
                <td className="px-4 py-2.5">
                  <div className="font-medium text-slate-800">{t.number}</div>
                  <div className="text-slate-500 text-xs truncate max-w-xs">{t.title}</div>
                </td>
                <td className="px-4 py-2.5"><TypeBadge type={t.type} /></td>
                <td className="px-4 py-2.5"><StatusBadge status={t.status} /></td>
                <td className="px-4 py-2.5"><PriorityBadge priority={t.priority} /></td>
                <td className="px-4 py-2.5 text-slate-600">{t.category || '—'}</td>
                <td className="px-4 py-2.5 text-slate-400 text-xs">{new Date(t.updated_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <NewTicketModal
          availableTypes={availableTypes}
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
