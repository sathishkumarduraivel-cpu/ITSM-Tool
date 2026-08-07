import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Search, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import { useFieldRules } from '../hooks/useFieldRules.js';

const ALL_TYPES = ['incident', 'request', 'problem', 'change'];
const STATUSES = ['open', 'pending_approval', 'in_progress', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const RISKS = ['low', 'medium', 'high'];

function NewTicketModal({ onClose, onCreated, availableTypes }) {
  const [form, setForm] = useState({
    title: '', description: '', type: availableTypes[0], priority: 'medium',
    category: '', subcategory: '', team: '', impact: 'medium',
    risk: 'medium', planned_start: '', planned_end: '', rollback_plan: '',
  });
  const [groups, setGroups] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isChange = form.type === 'change';
  const fieldRules = useFieldRules(form.type, form.category || null, form);

  useEffect(() => { api.get('/groups').then(({ groups }) => setGroups(groups)).catch(() => setGroups([])); }, []);

  // Every field below falls back to its current hardcoded default when no
  // admin rule exists for it (in Field Manager), and is otherwise fully
  // governed by that rule — visibility, requiredness, conditions, format.
  const showCategory = fieldRules.isVisible('category', true);
  const showSubcategory = fieldRules.isVisible('subcategory', true);
  const showTeam = fieldRules.isVisible('team', true);
  const showImpact = fieldRules.isVisible('impact', true);
  const showRisk = fieldRules.isVisible('risk', isChange);
  const showPlannedStart = fieldRules.isVisible('planned_start', isChange);
  const showPlannedEnd = fieldRules.isVisible('planned_end', isChange);
  const showRollbackPlan = fieldRules.isVisible('rollback_plan', isChange);
  const showChangeSection = showRisk || showPlannedStart || showPlannedEnd || showRollbackPlan;

  const ALL_RULED_FIELDS = ['category', 'subcategory', 'team', 'impact', 'risk', 'planned_start', 'planned_end', 'rollback_plan'];

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const firstError = ALL_RULED_FIELDS.map((f) => fieldRules.getError(f, form[f])).find(Boolean);
    if (firstError) { setError(firstError); return; }
    setSaving(true);
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
    <Modal title="New ticket" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
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
          {showCategory && (
            <div>
              <label className="label">Category{fieldRules.isRequired('category') && ' *'}</label>
              <input className="input" required={fieldRules.isRequired('category')} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Optional" />
              {fieldRules.getError('category', form.category) && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('category', form.category)}</p>}
            </div>
          )}
        </div>

        {(showSubcategory || showTeam || showImpact) && (
          <div className="grid grid-cols-3 gap-3">
            {showSubcategory && (
              <div>
                <label className="label">Subcategory{fieldRules.isRequired('subcategory') && ' *'}</label>
                <input className="input" required={fieldRules.isRequired('subcategory')} value={form.subcategory} onChange={(e) => setForm({ ...form, subcategory: e.target.value })} placeholder="Optional" />
                {fieldRules.getError('subcategory', form.subcategory) && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('subcategory', form.subcategory)}</p>}
              </div>
            )}
            {showTeam && (
              <div>
                <label className="label">Group{fieldRules.isRequired('team') && ' *'}</label>
                <select className="input" required={fieldRules.isRequired('team')} value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })}>
                  <option value="">Unassigned</option>
                  {groups.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}
                </select>
              </div>
            )}
            {showImpact && (
              <div>
                <label className="label">Impact{fieldRules.isRequired('impact') && ' *'}</label>
                <select className="input" required={fieldRules.isRequired('impact')} value={form.impact} onChange={(e) => setForm({ ...form, impact: e.target.value })}>
                  {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            )}
          </div>
        )}

        {showChangeSection && (
          <div className="space-y-3 border-t border-slate-100 dark:border-slate-800 pt-3">
            {isChange && <p className="text-xs text-slate-500">Change requests go through Change Advisory Board approval before they can move to in-progress.</p>}
            <div className="grid grid-cols-3 gap-3">
              {showRisk && (
                <div>
                  <label className="label">Risk{fieldRules.isRequired('risk') && ' *'}</label>
                  <select className="input" required={fieldRules.isRequired('risk')} value={form.risk} onChange={(e) => setForm({ ...form, risk: e.target.value })}>
                    {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                  {fieldRules.getError('risk', form.risk) && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('risk', form.risk)}</p>}
                </div>
              )}
              {showPlannedStart && (
                <div>
                  <label className="label">Planned start{fieldRules.isRequired('planned_start') && ' *'}</label>
                  <input type="datetime-local" className="input" required={fieldRules.isRequired('planned_start')} value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} />
                  {fieldRules.getError('planned_start', form.planned_start) && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('planned_start', form.planned_start)}</p>}
                </div>
              )}
              {showPlannedEnd && (
                <div>
                  <label className="label">Planned end{fieldRules.isRequired('planned_end') && ' *'}</label>
                  <input type="datetime-local" className="input" required={fieldRules.isRequired('planned_end')} value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} />
                  {fieldRules.getError('planned_end', form.planned_end) && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('planned_end', form.planned_end)}</p>}
                </div>
              )}
            </div>
            {showRollbackPlan && (
              <div>
                <label className="label">Rollback plan{fieldRules.isRequired('rollback_plan') && ' *'}</label>
                <textarea className="input" rows={2} required={fieldRules.isRequired('rollback_plan')} value={form.rollback_plan} onChange={(e) => setForm({ ...form, rollback_plan: e.target.value })} />
                {fieldRules.getError('rollback_plan', form.rollback_plan) && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('rollback_plan', form.rollback_plan)}</p>}
              </div>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create ticket
          </button>
        </div>
      </form>
    </Modal>
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
      <PageHeader
        title="Tickets"
        description="Incidents, requests, problems & changes"
        actions={<button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New ticket</button>}
      />

      <div className="card p-3 flex flex-wrap items-center gap-2">
        <form onSubmit={search} className="flex-1 min-w-[200px] relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
          <input
            className="input pl-9"
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

      {loading && <SkeletonRows count={5} />}

      {!loading && (
        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
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
              {tickets.length === 0 && (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400">No tickets match these filters.</td></tr>
              )}
              {tickets.map((t) => (
                <tr
                  key={t.id}
                  onClick={() => navigate(`/tickets/${t.id}`)}
                  className="border-t border-slate-100 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                >
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-800 dark:text-slate-100">{t.number}</div>
                    <div className="text-slate-500 text-xs truncate max-w-xs">{t.title}</div>
                  </td>
                  <td className="px-4 py-2.5"><TypeBadge type={t.type} /></td>
                  <td className="px-4 py-2.5"><StatusBadge status={t.status} /></td>
                  <td className="px-4 py-2.5"><PriorityBadge priority={t.priority} /></td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{t.category || '—'}</td>
                  <td className="px-4 py-2.5 text-slate-400 text-xs">{new Date(t.updated_at).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
