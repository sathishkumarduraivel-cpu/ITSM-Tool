import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plus, Search, Loader2, Check, GitMerge, X, SlidersHorizontal, Bookmark, AlertTriangle, Inbox, UserRoundCheck } from 'lucide-react';
import { api } from '../lib/api.js';
import { fmtDateTime, fmtRelative, dateValue } from '../lib/dates.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import NewTicketModal from '../components/NewTicketModal.jsx';
import Modal from '../components/Modal.jsx';
import { RevealGroup, RevealItem } from '../components/Reveal.jsx';
import { useRealtimeEvent } from '../context/RealtimeContext.jsx';
import Select from '../components/Select.jsx';

const ALL_TYPES = ['incident', 'request', 'problem', 'change'];
const STATUSES = ['open', 'pending_approval', 'in_progress', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

// Picks which of the selected tickets survives a merge -- the rest are
// closed, their comments/attachments move onto the survivor, and their
// requesters become read-only watchers on it instead of losing visibility.
function MergeModal({ tickets, onClose, onMerged }) {
  const [primaryId, setPrimaryId] = useState(tickets[0]?.id || '');
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setMerging(true);
    setError('');
    try {
      const duplicate_ids = tickets.filter((t) => t.id !== primaryId).map((t) => t.id);
      const result = await api.post('/tickets/merge', { primary_id: primaryId, duplicate_ids });
      onMerged(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setMerging(false);
    }
  };

  return (
    <Modal title="Merge tickets" onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Pick which ticket survives. The others will be closed, their comments and attachments moved onto it, and their requesters kept as read-only watchers so they don't lose visibility.
        </p>
        <div className="space-y-1.5">
          {tickets.map((t) => (
            <label
              key={t.id}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 cursor-pointer border transition-colors ${primaryId === t.id ? 'border-brand-400 bg-brand-50 dark:bg-brand-500/10' : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800/60'}`}
            >
              <input type="radio" name="primary" checked={primaryId === t.id} onChange={() => setPrimaryId(t.id)} />
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100 truncate">{t.number} — {t.title}</div>
                <div className="text-xs text-slate-400 capitalize">{t.status.replace('_', ' ')} · {t.priority}</div>
              </div>
              {primaryId === t.id && <span className="badge bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-400 shrink-0">Keep this one</span>}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={submit} disabled={merging} className="btn-primary">
            {merging ? <Loader2 size={14} className="animate-spin" /> : <GitMerge size={14} />} Merge {tickets.length - 1} into this one
          </button>
        </div>
      </div>
    </Modal>
  );
}

function BulkActionBar({ selectedTickets, onClear, onDone, agents, groups }) {
  const [bulk, setBulk] = useState({ status: '', priority: '', assignee_id: '', team: '' });
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState('');
  const [mergeOpen, setMergeOpen] = useState(false);
  const hasEdits = Object.values(bulk).some(Boolean);

  const apply = async () => {
    const updates = Object.fromEntries(Object.entries(bulk).filter(([, v]) => v !== ''));
    if (!Object.keys(updates).length) return;
    setApplying(true);
    setError('');
    try {
      const result = await api.post('/tickets/bulk-update', { ticket_ids: selectedTickets.map((t) => t.id), updates });
      if (result.failed.length) {
        setError(`${result.succeeded.length} updated, ${result.failed.length} failed — ${result.failed.map((f) => `${f.number || f.id}: ${f.error}`).join('; ')}`);
      }
      setBulk({ status: '', priority: '', assignee_id: '', team: '' });
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="card p-3 bg-brand-50/60 dark:bg-brand-500/5 border-brand-200 dark:border-brand-500/20 space-y-2 animate-fade-in">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold text-brand-700 dark:text-brand-400">{selectedTickets.length} selected</span>
        <div className="flex items-center gap-2">
          <button onClick={() => setMergeOpen(true)} disabled={selectedTickets.length < 2} className="btn-secondary text-xs">
            <GitMerge size={12} /> Merge
          </button>
          <button onClick={onClear} className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 flex items-center gap-1 py-1.5 px-1 -m-1"><X size={12} /> Clear</button>
        </div>
      </div>
      {error && <div className="text-xs text-red-600 bg-red-50 dark:bg-red-500/10 rounded-md px-2 py-1.5">{error}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <Select
          size="sm" className="w-auto min-w-[140px]" placeholder="Set status…"
          value={bulk.status} onChange={(v) => setBulk({ ...bulk, status: v })}
          options={STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') }))}
        />
        <Select
          size="sm" className="w-auto min-w-[130px]" placeholder="Set priority…"
          value={bulk.priority} onChange={(v) => setBulk({ ...bulk, priority: v })}
          options={PRIORITIES}
        />
        <Select
          size="sm" className="w-auto min-w-[140px]" placeholder="Assign to…"
          value={bulk.assignee_id} onChange={(v) => setBulk({ ...bulk, assignee_id: v })}
          options={agents.map((a) => ({ value: a.id, label: a.name }))}
        />
        <Select
          size="sm" className="w-auto min-w-[130px]" placeholder="Set group…"
          value={bulk.team} onChange={(v) => setBulk({ ...bulk, team: v })}
          options={groups.map((g) => ({ value: g.name, label: g.name }))}
        />
        <button onClick={apply} disabled={applying || !hasEdits} className="btn-primary text-xs">
          {applying ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Apply to {selectedTickets.length}
        </button>
      </div>

      {mergeOpen && (
        <MergeModal
          tickets={selectedTickets}
          onClose={() => setMergeOpen(false)}
          onMerged={() => { setMergeOpen(false); onDone(); }}
        />
      )}
    </div>
  );
}

export default function Tickets() {
  const { user } = useAuth();
  const isAgent = user.role === 'admin' || user.role === 'agent';
  const availableTypes = isAgent ? ALL_TYPES : ['incident', 'request'];
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchParams] = useSearchParams();
  const urlType = searchParams.get('type') || '';
  const [filters, setFilters] = useState({ status: '', priority: '', type: urlType, q: '', assignee_id: '' });
  const [showNew, setShowNew] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [agents, setAgents] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loadError, setLoadError] = useState('');
  const [sort, setSort] = useState(() => localStorage.getItem('itsm_ticket_sort') || 'updated');
  const [visibleColumns, setVisibleColumns] = useState(() => new Set(JSON.parse(localStorage.getItem('itsm_ticket_columns') || '["type","status","priority","category","updated"]')));
  const [showCustomize, setShowCustomize] = useState(false);
  const navigate = useNavigate();

  const load = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      const { tickets } = await api.get(`/tickets?${params.toString()}`);
      setTickets(isAgent ? tickets : tickets.filter((t) => t.requester_id === user.id));
    } catch (e) {
      // Without this catch, a failed request left `loading` stuck true
      // forever -- the whole ticket list (the single most-used page in the
      // app) replaced permanently by its loading skeleton with no error and
      // no way to recover short of a manual refresh.
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  };

  // The sidebar's Incidents/Service Requests sub-links navigate to
  // /tickets?type=... without remounting this page (same route, only the
  // query string changes), so the initial-state seed above only fires once
  // -- this keeps the type filter in sync with the URL on every subsequent
  // sub-link click too.
  useEffect(() => {
    setFilters((f) => (f.type === urlType ? f : { ...f, type: urlType }));
  }, [urlType]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters.status, filters.priority, filters.type, filters.assignee_id]);

  useEffect(() => {
    if (!isAgent) return;
    api.get('/tickets/assignable-agents').then(({ agents }) => setAgents(agents)).catch(() => setAgents([]));
    api.get('/groups').then(({ groups }) => setGroups(groups)).catch(() => setGroups([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Another agent creating/editing a ticket, or a bulk action landing, shows
  // up in this list live -- re-runs the same filtered fetch rather than
  // trusting the pushed id as content.
  useRealtimeEvent('ticket.created', () => load());
  useRealtimeEvent('ticket.updated', () => load());
  useRealtimeEvent('ticket.bulk_updated', () => load());

  const search = (e) => {
    e.preventDefault();
    load();
  };

  const toggleOne = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelectedIds((prev) => (prev.size === tickets.length ? new Set() : new Set(tickets.map((t) => t.id))));
  const clearSelection = () => setSelectedIds(new Set());
  const afterBulkAction = () => { clearSelection(); load(); };
  const selectedTickets = tickets.filter((t) => selectedIds.has(t.id));
  const displayedTickets = useMemo(() => [...tickets].sort((a, b) => {
    if (sort === 'priority') return PRIORITIES.indexOf(b.priority) - PRIORITIES.indexOf(a.priority);
    if (sort === 'oldest') return dateValue(a.created_at) - dateValue(b.created_at);
    // Tickets with no SLA sort last rather than first, hence the far-future
    // fallback -- dateValue() returns 0 for an unparseable value, which would
    // otherwise put them at the top of an "SLA due first" list.
    if (sort === 'sla') return (dateValue(a.sla_due_at) || Infinity) - (dateValue(b.sla_due_at) || Infinity);
    return dateValue(b.updated_at) - dateValue(a.updated_at);
  }), [tickets, sort]);
  const applyQueue = (queue) => setFilters({ status: queue === 'waiting' ? 'on_hold' : '', priority: queue === 'urgent' ? 'critical' : '', type: '', q: '', assignee_id: queue === 'mine' ? user.id : queue === 'unassigned' ? 'unassigned' : '' });
  const toggleColumn = (column) => setVisibleColumns((current) => { const next = new Set(current); if (next.has(column)) next.delete(column); else next.add(column); localStorage.setItem('itsm_ticket_columns', JSON.stringify([...next])); return next; });

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
        <Select
          className="w-auto min-w-[130px]" placeholder="All types"
          value={filters.type} onChange={(v) => setFilters({ ...filters, type: v })}
          options={ALL_TYPES}
        />
        <Select
          className="w-auto min-w-[140px]" placeholder="All statuses"
          value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })}
          options={STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') }))}
        />
        <Select
          className="w-auto min-w-[130px]" placeholder="All priorities"
          value={filters.priority} onChange={(v) => setFilters({ ...filters, priority: v })}
          options={PRIORITIES}
        />
        <Select className="w-auto min-w-[130px]" value={sort} onChange={(value) => { setSort(value); localStorage.setItem('itsm_ticket_sort', value); }} options={[{ value: 'updated', label: 'Recently updated' }, { value: 'priority', label: 'Priority' }, { value: 'sla', label: 'SLA due first' }, { value: 'oldest', label: 'Oldest first' }]} />
        {isAgent && <button onClick={() => setShowCustomize((open) => !open)} className="btn-secondary text-xs"><SlidersHorizontal size={13} /> Columns</button>}
      </div>

      {isAgent && <div className="flex flex-wrap items-center gap-2"><span className="text-xs font-semibold uppercase tracking-wide text-slate-400 mr-1">Work queues</span><button onClick={() => applyQueue('mine')} className="btn-secondary text-xs"><UserRoundCheck size={13} /> My work</button><button onClick={() => applyQueue('urgent')} className="btn-secondary text-xs"><AlertTriangle size={13} /> Critical</button><button onClick={() => applyQueue('waiting')} className="btn-secondary text-xs"><Inbox size={13} /> Awaiting customer</button><button onClick={() => applyQueue('unassigned')} className="btn-secondary text-xs"><Bookmark size={13} /> Unassigned</button></div>}
      {Object.entries(filters).some(([key, value]) => value && key !== 'q') && <div className="flex flex-wrap items-center gap-1.5 text-xs"><span className="text-slate-400">Active filters:</span>{Object.entries(filters).filter(([key, value]) => value && key !== 'q').map(([key, value]) => <button key={key} onClick={() => setFilters((current) => ({ ...current, [key]: '' }))} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-2 py-1 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">{key.replace('_id', '').replace('_', ' ')}: {value === 'unassigned' ? 'unassigned' : String(value).replace('_', ' ')} <X size={11} /></button>)}</div>}
      {showCustomize && <div className="card-flat flex flex-wrap gap-3 p-3 text-xs text-slate-600 dark:text-slate-300">{['type', 'status', 'priority', 'category', 'updated'].map((column) => <label key={column} className="flex items-center gap-1.5 capitalize"><input type="checkbox" checked={visibleColumns.has(column)} onChange={() => toggleColumn(column)} /> {column}</label>)}</div>}

      {isAgent && selectedTickets.length > 0 && (
        <BulkActionBar selectedTickets={selectedTickets} onClear={clearSelection} onDone={afterBulkAction} agents={agents} groups={groups} />
      )}

      {loadError && !loading && (
        <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2 flex items-center justify-between gap-3">
          <span>{loadError}</span>
          <button onClick={load} className="btn-secondary text-xs shrink-0">Retry</button>
        </div>
      )}

      {loading && <SkeletonRows count={5} />}

      {!loading && (
        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
              <tr>
                {isAgent && (
                  <th className="text-left px-4 py-2.5 font-medium w-8">
                    <input type="checkbox" checked={tickets.length > 0 && selectedIds.size === tickets.length} onChange={toggleAll} />
                  </th>
                )}
                <th className="text-left px-4 py-2.5 font-medium">Ticket</th>
                {visibleColumns.has('type') && <th className="text-left px-4 py-2.5 font-medium">Type</th>}
                {visibleColumns.has('status') && <th className="text-left px-4 py-2.5 font-medium">Status</th>}
                {visibleColumns.has('priority') && <th className="text-left px-4 py-2.5 font-medium">Priority</th>}
                {visibleColumns.has('category') && <th className="text-left px-4 py-2.5 font-medium">Category</th>}
                {visibleColumns.has('updated') && <th className="text-left px-4 py-2.5 font-medium">Updated</th>}
              </tr>
            </thead>
            <RevealGroup as={motion.tbody}>
              {tickets.length === 0 && (
                <tr><td colSpan={(isAgent ? 2 : 1) + visibleColumns.size} className="text-center py-10 text-slate-400">No tickets match these filters.</td></tr>
              )}
              {displayedTickets.map((t) => (
                <RevealItem
                  key={t.id}
                  as={motion.tr}
                  onClick={() => navigate(`/tickets/${t.id}`)}
                  className="border-t border-slate-100 dark:border-slate-800 row-interactive"
                >
                  {isAgent && (
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selectedIds.has(t.id)} onChange={() => toggleOne(t.id)} />
                    </td>
                  )}
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                      {t.number}
                      {!!t.merged_into_id && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">merged</span>}
                    </div>
                    <div className="text-slate-500 text-xs truncate max-w-xs">{t.title}</div>
                  </td>
                  {visibleColumns.has('type') && <td className="px-4 py-2.5"><TypeBadge type={t.type} /></td>}
                  {visibleColumns.has('status') && <td className="px-4 py-2.5"><StatusBadge status={t.status} /></td>}
                  {visibleColumns.has('priority') && <td className="px-4 py-2.5"><PriorityBadge priority={t.priority} /></td>}
                  {visibleColumns.has('category') && <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{t.category || '—'}</td>}
                  {visibleColumns.has('updated') && <td className="px-4 py-2.5 text-slate-400 text-xs" title={fmtDateTime(t.updated_at)}>{fmtRelative(t.updated_at)}</td>}
                </RevealItem>
              ))}
            </RevealGroup>
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
