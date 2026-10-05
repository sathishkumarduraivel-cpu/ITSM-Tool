import { useCallback, useEffect, useState } from 'react';
import {
  Bookmark, Plus, Star, Copy, Trash2, SlidersHorizontal, Loader2, AlertTriangle, Lock, Users2, Globe,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import FilterBuilder from './FilterBuilder.jsx';

const SCOPE_ICON = { private: Lock, team: Users2, workspace: Globe };

const NO_VALUE = new Set(['is_empty', 'is_not_empty', 'is_true', 'is_false', 'is_me', 'is_not_me']);

// A condition that has been added but not yet filled in is simply not applied
// while the filter is being built. Sending it would fail validation, which
// would break the live count and refuse the save for a rule the person is
// still in the middle of typing. A rule sent deliberately incomplete is still
// rejected by the server -- this only prunes what the builder itself is
// holding mid-edit.
function pruneIncomplete(group) {
  if (!group || !Array.isArray(group.rules)) return group;
  const rules = group.rules
    .map((r) => (Array.isArray(r?.rules) ? pruneIncomplete(r) : r))
    .filter((r) => {
      if (Array.isArray(r?.rules)) return r.rules.length > 0;
      if (!r?.field || !r?.op) return false;
      if (NO_VALUE.has(r.op)) return true;
      if (Array.isArray(r.value)) return r.value.length > 0;
      return r.value !== undefined && r.value !== null && String(r.value).trim() !== '';
    });
  return { ...group, rules };
}

/**
 * The saved views strip above a queue.
 *
 * A view is worth saving because it is shared — "unassigned P1s" is how a
 * team agrees what it is looking at. So scope is a first-class choice here,
 * and the built-in views are present from the start rather than waiting for
 * somebody to build the obvious ones.
 */
export default function ViewBar({ module = 'tickets', activeId, onRun, groups = [] }) {
  const [views, setViews] = useState(null);
  const [counts, setCounts] = useState({});
  const [meta, setMeta] = useState(null);
  const [editing, setEditing] = useState(null);   // { view } | 'new'
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [v, m] = await Promise.all([
        api.get(`/views?module=${module}`),
        api.get('/views/meta', { quiet: true }).catch(() => null),
      ]);
      setViews(v.views);
      if (m) setMeta(m);
      api.get(`/views/counts?module=${module}`, { quiet: true }).then((c) => setCounts(c.counts)).catch(() => {});
    } catch (e) { setError(e.message); setViews([]); }
  }, [module]);
  useEffect(() => { load(); }, [load]);

  // Land on whatever this person made their default, once.
  useEffect(() => {
    if (!views || activeId) return;
    const fallback = views.find((v) => v.is_default);
    if (fallback) onRun(fallback);
  }, [views]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (body, id) => {
    setBusy(true); setError('');
    try {
      const out = id ? await api.patch(`/views/${id}`, body) : await api.post('/views', body);
      setEditing(null);
      await load();
      onRun(out.view);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async (view) => {
    if (!confirm(`Remove the view "${view.name}"? Tickets are not affected.`)) return;
    try { await api.del(`/views/${view.id}`); await load(); }
    catch (e) { setError(e.message); }
  };

  const duplicate = async (view) => {
    try { const out = await api.post(`/views/${view.id}/duplicate`, {}); await load(); setEditing({ view: out.view }); }
    catch (e) { setError(e.message); }
  };

  const makeDefault = async (view) => {
    try { const out = await api.put(`/views/${view.id}/preference`, { is_default: true }); setViews(out.views); }
    catch (e) { setError(e.message); }
  };

  if (!views) return <div className="h-9 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800/60" />;

  return (
    <div className="space-y-2">
      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {views.map((v) => {
          const Icon = SCOPE_ICON[v.scope] || Bookmark;
          const active = v.id === activeId;
          return (
            <div key={v.id} className="group relative">
              <button
                onClick={() => onRun(v)}
                title={v.description || v.name}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? 'bg-brand-600 text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                }`}
              >
                <Icon size={11} className="shrink-0 opacity-70" />
                {v.name}
                {counts[v.id] !== undefined && counts[v.id] !== null && (
                  <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${active ? 'bg-white/20' : 'bg-white/70 dark:bg-slate-900/50'}`}>
                    {counts[v.id]}
                  </span>
                )}
                {!!v.is_default && <Star size={9} className="fill-current opacity-70" />}
              </button>

              {/* Per-view actions, kept out of the way until hovered so the
                  strip reads as a row of tabs rather than a toolbar. */}
              <div className="absolute -top-1 right-0 hidden -translate-y-full gap-0.5 rounded-lg border border-slate-200 bg-white p-0.5 shadow-popover group-hover:flex dark:border-white/10 dark:bg-slate-900">
                <button onClick={() => makeDefault(v)} title="Make this my default" className="rounded p-1 text-slate-400 hover:text-amber-500"><Star size={11} /></button>
                <button onClick={() => duplicate(v)} title="Duplicate" className="rounded p-1 text-slate-400 hover:text-slate-600"><Copy size={11} /></button>
                {!v.built_in && (
                  <>
                    <button onClick={() => setEditing({ view: v })} title="Edit" className="rounded p-1 text-slate-400 hover:text-slate-600"><SlidersHorizontal size={11} /></button>
                    <button onClick={() => remove(v)} title="Remove" className="rounded p-1 text-slate-400 hover:text-red-500"><Trash2 size={11} /></button>
                  </>
                )}
              </div>
            </div>
          );
        })}

        <button
          onClick={() => setEditing('new')}
          className="flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-500 transition-colors hover:border-brand-400 hover:text-brand-600 dark:border-white/15 dark:text-slate-400"
        ><Plus size={11} /> New view</button>
      </div>

      {editing && meta && (
        <ViewEditor
          view={editing === 'new' ? null : editing.view}
          meta={meta}
          module={module}
          groups={groups}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      )}
    </div>
  );
}

function ViewEditor({ view, meta, module, groups, busy, onClose, onSave }) {
  const [name, setName] = useState(view?.name || '');
  const [description, setDescription] = useState(view?.description || '');
  const [scope, setScope] = useState(view?.scope || 'private');
  const [team, setTeam] = useState(view?.team || '');
  const [filters, setFilters] = useState(view?.filters || { logic: 'AND', rules: [] });
  const [sortBy, setSortBy] = useState(view?.sort_by || 'created_at');
  const [sortDir, setSortDir] = useState(view?.sort_dir || 'desc');
  const [preview, setPreview] = useState(null);

  // A live count while the filter is being built, so it is obvious whether a
  // condition narrowed things to nothing before it is saved.
  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const out = await api.post('/views/run', { filters: pruneIncomplete(filters), limit: 1 });
        if (!cancelled) setPreview({ total: out.total });
      } catch (e) {
        if (!cancelled) setPreview({ error: e.message });
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [filters]);

  return (
    <Modal
      title={view ? `Edit "${view.name}"` : 'New view'}
      onClose={onClose}
      maxWidth="max-w-3xl"
      footer={(
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-slate-400">
            {preview?.error
              ? <span className="text-amber-600 dark:text-amber-400">{preview.error}</span>
              : preview
                ? `${preview.total} ticket${preview.total === 1 ? '' : 's'} match right now`
                : 'counting…'}
          </span>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-secondary">Cancel</button>
            <button
              onClick={() => onSave({ name, description, scope, team, module, filters: pruneIncomplete(filters), sort_by: sortBy, sort_dir: sortDir }, view?.id)}
              disabled={busy || !name.trim()}
              className="btn-primary disabled:opacity-40"
            >{busy && <Loader2 size={14} className="animate-spin" />} {view ? 'Save view' : 'Create view'}</button>
          </div>
        </div>
      )}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Name<span className="text-red-500">*</span></label>
            <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Unassigned P1s" />
          </div>
          <div>
            <label className="label">Who can use it</label>
            <Select
              value={scope} onChange={setScope}
              options={[
                { value: 'private', label: 'Only me' },
                { value: 'team', label: 'My team' },
                { value: 'workspace', label: 'Everyone' },
              ]}
            />
          </div>
        </div>

        {scope === 'team' && (
          <div>
            <label className="label">Which team<span className="text-red-500">*</span></label>
            <Select
              value={team} onChange={setTeam}
              options={[{ value: '', label: 'Choose a group…' }, ...groups.map((g) => ({ value: g.name ?? g, label: g.name ?? g }))]}
            />
          </div>
        )}

        <div>
          <label className="label">Description</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What this view is for" />
        </div>

        <div>
          <label className="label">Conditions</label>
          <FilterBuilder value={filters} onChange={setFilters} meta={meta} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Sort by</label>
            <Select
              value={sortBy} onChange={setSortBy}
              options={(meta.sortable || []).map((s) => ({ value: s, label: s.replace(/_/g, ' ') }))}
            />
          </div>
          <div>
            <label className="label">Order</label>
            <Select
              value={sortDir} onChange={setSortDir}
              options={[{ value: 'desc', label: 'Newest / highest first' }, { value: 'asc', label: 'Oldest / lowest first' }]}
            />
          </div>
        </div>
      </div>
    </Modal>
  );
}
