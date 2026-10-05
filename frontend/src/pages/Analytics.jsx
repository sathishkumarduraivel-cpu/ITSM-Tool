import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, RefreshCw, Pencil, Trash2, Copy, ArrowLeft, ArrowRight, Loader2, Sparkles,
  LayoutDashboard, Lock, Users2, Clock, CalendarDays, Check, X, Settings2, ChevronLeft,
  BarChart3, AlertTriangle, Star,
} from 'lucide-react';
import { api } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import Select from '../components/Select.jsx';
import Modal from '../components/Modal.jsx';
import EmptyState from '../components/EmptyState.jsx';
import CardRenderer from '../components/analytics/CardRenderer.jsx';
import CardEditor from '../components/analytics/CardEditor.jsx';
import { CARD_ICONS, SPAN_CLASS, SPANS } from '../components/analytics/cardMeta.js';
import ReportsExplorer from './Reports.jsx';

const relative = (iso) => {
  if (!iso) return '';
  const then = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (Number.isNaN(mins)) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (mins < 1440) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
};

// ---- the library: every report in the workspace ---------------------------

function NewReportModal({ meta, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [template, setTemplate] = useState(meta.templates?.[0]?.key || '');
  const [blank, setBlank] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const create = async () => {
    setBusy(true); setError('');
    try {
      const out = blank
        ? await api.post('/analytics/boards', { name: name.trim() || 'Untitled report', date_range: { preset: 'last_30_days' } })
        : await api.post('/analytics/boards/from-template', { template, name: name.trim() || undefined });
      onCreated(out.board);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title="New report" onClose={onClose} maxWidth="max-w-2xl">
      <div className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}
        <div>
          <label className="label">Name</label>
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Monthly service review" />
        </div>

        <div>
          <label className="label">Start from</label>
          <div className="space-y-2">
            {meta.templates?.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => { setTemplate(t.key); setBlank(false); }}
                className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors ${
                  !blank && template === t.key
                    ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-500/10'
                    : 'border-slate-200 hover:border-slate-300 dark:border-white/10'
                }`}
              >
                <Sparkles size={15} className="mt-0.5 shrink-0 text-brand-500" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">{t.name}</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">{t.description}</span>
                </span>
                <span className="shrink-0 text-[11px] text-slate-400">{t.card_count} cards</span>
              </button>
            ))}
            <button
              type="button"
              onClick={() => setBlank(true)}
              className={`flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors ${
                blank ? 'border-brand-500 bg-brand-50/60 dark:bg-brand-500/10' : 'border-slate-200 hover:border-slate-300 dark:border-white/10'
              }`}
            >
              <LayoutDashboard size={15} className="shrink-0 text-slate-400" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">Empty report</span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">Start with nothing and add your own cards.</span>
              </span>
            </button>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="button" onClick={create} disabled={busy} className="btn-primary">
            {busy && <Loader2 size={14} className="animate-spin" />} Create report
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Library({ meta, onOpen }) {
  const [boards, setBoards] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try { setBoards((await api.get('/analytics/boards')).boards); setError(''); }
    catch (e) { setError(e.message); setBoards([]); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // Deleting a report takes its cards with it (the foreign key cascades), so
  // the confirmation says how many rather than just asking twice.
  const remove = async (board) => {
    const cards = board.card_count === 1 ? '1 card' : `${board.card_count} cards`;
    if (!window.confirm(`Delete "${board.name}"? Its ${cards} go with it, and this cannot be undone.`)) return;
    setError('');
    try { await api.del(`/analytics/boards/${board.id}`); load(); }
    catch (e) { setError(e.message); }
  };

  const folders = useMemo(() => {
    if (!boards) return [];
    const groups = new Map();
    for (const b of boards) {
      const key = b.folder || 'Reports';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(b);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [boards]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Analytics"
        description="Every report in this workspace. Open one, or build a new one out of cards."
        actions={(
          <button onClick={() => setCreating(true)} className="btn-primary">
            <Plus size={15} /> New report
          </button>
        )}
      />

      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {boards === null ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="card h-32 animate-pulse bg-slate-100 dark:bg-slate-800/60" />)}
        </div>
      ) : !boards.length ? (
        <EmptyState
          icon={BarChart3}
          title="No reports yet"
          description="A report is a board of cards — a number, a trend, a breakdown, a table. Start from a ready-made one and change what you like."
          action={<button onClick={() => setCreating(true)} className="btn-primary"><Plus size={15} /> New report</button>}
        />
      ) : folders.map(([folder, list]) => (
        <div key={folder}>
          <div className="mb-2.5 flex items-center gap-2.5">
            <h2 className="font-display text-sm font-semibold text-slate-700 dark:text-slate-200">{folder}</h2>
            <span className="font-mono text-xs text-slate-400">{list.length}</span>
            <div className="flex-1 border-t border-slate-200/70 dark:border-white/[0.06]" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {list.map((b) => (
              // A div rather than a button, because the card holds two actions.
              // The name is the primary one and stretches over the whole card
              // through its ::after overlay, so the click target is unchanged;
              // the delete sits above that overlay on its own z-layer.
              <div
                key={b.id}
                className="card group relative p-4 transition-shadow hover:shadow-popover dark:hover:shadow-popover-dark"
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className="min-w-0 flex-1 font-display font-semibold text-slate-800 dark:text-slate-100">
                    <button
                      type="button"
                      onClick={() => onOpen(b.id)}
                      className="block w-full truncate rounded text-left after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
                    >
                      {b.name}
                    </button>
                  </h3>
                  <div className="relative z-10 flex shrink-0 items-center gap-1">
                    {b.visibility === 'private'
                      ? <Lock size={13} className="mt-0.5 text-slate-400" title="Only you can see this" />
                      : <Users2 size={13} className="mt-0.5 text-slate-400" title="Shared with the workspace" />}
                    <button
                      type="button"
                      onClick={() => remove(b)}
                      title="Delete this report"
                      aria-label={`Delete ${b.name}`}
                      className="rounded p-1 text-slate-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-red-500/10 dark:hover:text-red-400"
                    >
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
                {b.description && <p className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">{b.description}</p>}
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
                  <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                    {b.card_count} card{b.card_count === 1 ? '' : 's'}
                  </span>
                  <span className="flex items-center gap-1"><CalendarDays size={11} /> {meta.date_presets.find((p) => p.key === b.date_range?.preset)?.label || 'Custom'}</span>
                  <span className="flex items-center gap-1"><Clock size={11} /> {relative(b.updated_at)}</span>
                  {b.mine && <span className="flex items-center gap-1 text-brand-500"><Star size={11} /> yours</span>}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {creating && <NewReportModal meta={meta} onClose={() => setCreating(false)} onCreated={(b) => { setCreating(false); onOpen(b.id); }} />}
    </div>
  );
}

// ---- one report: the card canvas -----------------------------------------

function BoardSettings({ board, onClose, onSaved, onDeleted }) {
  const [name, setName] = useState(board.name);
  const [description, setDescription] = useState(board.description || '');
  const [folder, setFolder] = useState(board.folder || '');
  const [visibility, setVisibility] = useState(board.visibility);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true); setError('');
    try {
      const { board: next } = await api.patch(`/analytics/boards/${board.id}`, { name, description, folder, visibility });
      onSaved(next);
    } catch (e) { setError(e.message); setBusy(false); }
  };

  // Deleting from here leaves nothing to return to, so it hands back to the
  // library rather than closing onto a report that no longer exists.
  const remove = async () => {
    if (!window.confirm(`Delete "${board.name}"? Its cards go with it, and this cannot be undone.`)) return;
    setBusy(true); setError('');
    try { await api.del(`/analytics/boards/${board.id}`); onDeleted(); }
    catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <Modal title="Report settings" onClose={onClose}>
      <div className="space-y-3">
        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input min-h-[60px]" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What question does this report answer?" />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Folder</label>
            <input className="input" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Reports" />
          </div>
          <div>
            <label className="label">Visibility</label>
            <Select
              value={visibility} onChange={setVisibility}
              options={[{ value: 'shared', label: 'Shared with the workspace' }, { value: 'private', label: 'Only me' }]}
            />
          </div>
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <button
            type="button" onClick={remove} disabled={busy}
            className="rounded-lg px-2.5 py-1.5 text-sm font-medium text-red-600 transition hover:bg-red-50 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-500/10"
          >
            <span className="flex items-center gap-1.5"><Trash2 size={14} /> Delete report</span>
          </button>
          <div className="flex gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="button" onClick={save} disabled={busy} className="btn-primary">
              {busy && <Loader2 size={14} className="animate-spin" />} Save
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

function Board({ boardId, meta, onBack }) {
  const [board, setBoard] = useState(null);
  const [results, setResults] = useState([]);
  const [editMode, setEditMode] = useState(false);
  const [cardModal, setCardModal] = useState(null); // { card } | 'new'
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const resultFor = (id) => results.find((r) => r.id === id);

  const load = useCallback(async () => {
    try {
      const out = await api.get(`/analytics/boards/${boardId}`);
      setBoard(out.board); setResults(out.results); setError('');
    } catch (e) { setError(e.message); }
  }, [boardId]);
  useEffect(() => { load(); }, [load]);

  const rerun = async () => {
    setRefreshing(true);
    try { setResults((await api.get(`/analytics/boards/${boardId}/run`)).results); }
    catch (e) { setError(e.message); }
    finally { setRefreshing(false); }
  };

  const changeRange = async (preset) => {
    try {
      const { board: next } = await api.patch(`/analytics/boards/${boardId}`, { date_range: { preset } });
      setBoard(next);
      setResults((await api.get(`/analytics/boards/${boardId}/run`)).results);
    } catch (e) { setError(e.message); }
  };

  const saveCard = async (payload) => {
    if (cardModal?.card?.id) {
      const { card, result } = await api.patch(`/analytics/cards/${cardModal.card.id}`, payload);
      setBoard((b) => ({ ...b, cards: b.cards.map((c) => (c.id === card.id ? card : c)) }));
      setResults((rs) => rs.map((r) => (r.id === card.id ? result : r)));
    } else {
      const { card, result } = await api.post(`/analytics/boards/${boardId}/cards`, payload);
      setBoard((b) => ({ ...b, cards: [...b.cards, card] }));
      setResults((rs) => [...rs, result]);
    }
    setCardModal(null);
  };

  const duplicate = async (card) => {
    try {
      const { card: made, result } = await api.post(`/analytics/boards/${boardId}/cards`, {
        title: `${card.title} (copy)`, card_type: card.card_type, span: card.span, config: card.config,
      });
      setBoard((b) => ({ ...b, cards: [...b.cards, made] }));
      setResults((rs) => [...rs, result]);
    } catch (e) { setError(e.message); }
  };

  const removeCard = async (card) => {
    try {
      await api.del(`/analytics/cards/${card.id}`);
      setBoard((b) => ({ ...b, cards: b.cards.filter((c) => c.id !== card.id) }));
      setResults((rs) => rs.filter((r) => r.id !== card.id));
      setConfirmDelete(null);
    } catch (e) { setError(e.message); }
  };

  const move = async (index, delta) => {
    const next = [...board.cards];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    // Shown immediately, then confirmed by the server -- reordering should
    // feel instant, and the reload below is what makes it true.
    setBoard((b) => ({ ...b, cards: next }));
    try {
      const { board: saved } = await api.patch(`/analytics/boards/${boardId}/cards/order`, { order: next.map((c) => c.id) });
      setBoard(saved);
    } catch (e) { setError(e.message); load(); }
  };

  const resize = async (card, span) => {
    try {
      const { card: saved } = await api.patch(`/analytics/cards/${card.id}`, { span });
      setBoard((b) => ({ ...b, cards: b.cards.map((c) => (c.id === saved.id ? saved : c)) }));
    } catch (e) { setError(e.message); }
  };

  if (error && !board) {
    return (
      <div className="space-y-4">
        <button onClick={onBack} className="btn-secondary"><ChevronLeft size={14} /> All reports</button>
        <div className="card flex items-start gap-3 p-6">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <p className="font-medium text-slate-700 dark:text-slate-200">This report could not be opened</p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{error}</p>
          </div>
        </div>
      </div>
    );
  }
  if (!board) {
    return (
      <div className="grid grid-cols-12 gap-3">
        {[3, 3, 3, 3, 12, 6, 6].map((s, i) => (
          <div key={i} className={`${SPAN_CLASS[s]} card h-40 animate-pulse bg-slate-100 dark:bg-slate-800/60`} />
        ))}
      </div>
    );
  }

  const canEdit = board.mine || board.can_edit !== false;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <button onClick={onBack} className="mb-1.5 flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300">
            <ChevronLeft size={13} /> All reports
          </button>
          <h1 className="font-display text-2xl font-semibold text-slate-800 dark:text-slate-100">{board.name}</h1>
          {board.description && <p className="mt-0.5 max-w-2xl text-sm text-slate-500 dark:text-slate-400">{board.description}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={board.date_range?.preset || 'last_30_days'}
            onChange={changeRange}
            options={meta.date_presets.filter((p) => p.key !== 'custom').map((p) => ({ value: p.key, label: p.label }))}
            className="min-w-[150px]"
          />
          <button onClick={rerun} disabled={refreshing} className="btn-secondary" title="Re-run every card">
            <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} /> Refresh
          </button>
          {canEdit && (
            <>
              <button onClick={() => setSettingsOpen(true)} className="btn-secondary" title="Report settings">
                <Settings2 size={14} />
              </button>
              <button onClick={() => setEditMode((e) => !e)} className={editMode ? 'btn-primary' : 'btn-secondary'}>
                {editMode ? <><Check size={14} /> Done</> : <><Pencil size={14} /> Edit layout</>}
              </button>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          <button onClick={() => setError('')} className="ml-auto shrink-0"><X size={13} /></button>
        </div>
      )}

      {!board.cards.length ? (
        <EmptyState
          icon={LayoutDashboard}
          title="This report has no cards yet"
          description="Add a scorecard for a headline number, a trend to see movement, or a table for the detail behind it."
          action={canEdit && <button onClick={() => setCardModal('new')} className="btn-primary"><Plus size={15} /> Add the first card</button>}
        />
      ) : (
        <div className="grid grid-cols-12 gap-3">
          {board.cards.map((card, i) => {
            const Icon = CARD_ICONS[card.card_type];
            return (
              <div key={card.id} className={`${SPAN_CLASS[card.span] || SPAN_CLASS[6]} card flex flex-col p-4`}>
                <div className="mb-2 flex items-start justify-between gap-2">
                  <h3 className="flex min-w-0 items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
                    {Icon && <Icon size={13} className="shrink-0 text-slate-400" />}
                    <span className="truncate" title={card.title}>{card.title}</span>
                  </h3>
                  {editMode && (
                    <div className="flex shrink-0 items-center gap-0.5">
                      <button onClick={() => move(i, -1)} disabled={i === 0} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800" title="Move earlier"><ArrowLeft size={13} /></button>
                      <button onClick={() => move(i, 1)} disabled={i === board.cards.length - 1} className="rounded p-1 text-slate-400 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800" title="Move later"><ArrowRight size={13} /></button>
                      <button onClick={() => setCardModal({ card })} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" title="Edit card"><Pencil size={13} /></button>
                      <button onClick={() => duplicate(card)} className="rounded p-1 text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800" title="Duplicate"><Copy size={13} /></button>
                      <button onClick={() => setConfirmDelete(card)} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-red-500 dark:hover:bg-slate-800" title="Remove"><Trash2 size={13} /></button>
                    </div>
                  )}
                </div>
                {editMode && (
                  <div className="mb-2 flex items-center gap-1">
                    {SPANS.map((s) => (
                      <button
                        key={s.value}
                        onClick={() => resize(card, s.value)}
                        className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                          card.span === s.value
                            ? 'bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-300'
                            : 'text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'
                        }`}
                      >{s.label}</button>
                    ))}
                  </div>
                )}
                <div className="min-h-0 flex-1">
                  <CardRenderer card={card} result={resultFor(card.id)} meta={meta} />
                </div>
              </div>
            );
          })}

          {editMode && (
            <button
              onClick={() => setCardModal('new')}
              className="col-span-12 flex min-h-[120px] items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-300 text-sm font-medium text-slate-500 transition-colors hover:border-brand-400 hover:text-brand-600 dark:border-white/10 dark:text-slate-400 lg:col-span-6"
            >
              <Plus size={16} /> Add a card
            </button>
          )}
        </div>
      )}

      {!editMode && !!board.cards.length && canEdit && (
        <button onClick={() => { setEditMode(true); setCardModal('new'); }} className="btn-secondary">
          <Plus size={14} /> Add a card
        </button>
      )}

      {cardModal && (
        <CardEditor
          card={cardModal === 'new' ? null : cardModal.card}
          meta={meta}
          boardRange={board.date_range}
          onClose={() => setCardModal(null)}
          onSave={saveCard}
        />
      )}
      {settingsOpen && (
        <BoardSettings board={board} onClose={() => setSettingsOpen(false)} onDeleted={onBack} onSaved={(b) => { setBoard((prev) => ({ ...b, cards: prev.cards })); setSettingsOpen(false); }} />
      )}
      {confirmDelete && (
        <Modal title="Remove this card?" onClose={() => setConfirmDelete(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-600 dark:text-slate-300">
              “{confirmDelete.title}” will be removed from this report. The underlying ticket data is untouched.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setConfirmDelete(null)} className="btn-secondary">Keep it</button>
              <button onClick={() => removeCard(confirmDelete)} className="btn-primary bg-red-600 hover:bg-red-700">Remove card</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---- entry point ---------------------------------------------------------

export default function Analytics() {
  // The open report lives in the URL, so a particular report can be linked,
  // bookmarked and reached with the browser's back button.
  const [params, setParams] = useSearchParams();
  const boardId = params.get('report');
  const tab = params.get('tab') === 'explore' ? 'explore' : 'reports';
  const [meta, setMeta] = useState(null);
  const [metaError, setMetaError] = useState('');

  useEffect(() => {
    api.get('/analytics/meta').then(setMeta).catch((e) => setMetaError(e.message));
  }, []);

  const setTab = (next) => setParams((p) => {
    const q = new URLSearchParams(p);
    q.delete('report');
    if (next === 'reports') q.delete('tab'); else q.set('tab', next);
    return q;
  });

  // Ad-hoc exploration keeps its own tab rather than being replaced: the
  // one-off question ("break today's tickets down by category, export it")
  // is a different job from a report you return to, and the CSV exports and
  // Sona's natural-language builder live there.
  const tabs = (
    <div className="flex items-center gap-1 rounded-xl border border-slate-200 bg-white/70 p-1 dark:border-white/10 dark:bg-slate-900/60">
      {[['reports', 'Reports', LayoutDashboard], ['explore', 'Explore', BarChart3]].map(([key, label, Icon]) => (
        <button
          key={key}
          onClick={() => setTab(key)}
          className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === key
              ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/15 dark:text-brand-300'
              : 'text-slate-500 hover:text-slate-700 dark:text-slate-400 dark:hover:text-slate-200'
          }`}
        >
          <Icon size={13} /> {label}
        </button>
      ))}
    </div>
  );

  const open = (id) => setParams((p) => { const next = new URLSearchParams(p); next.set('report', id); return next; });
  const back = () => setParams((p) => { const next = new URLSearchParams(p); next.delete('report'); return next; });

  if (metaError) {
    return (
      <div className="card flex items-start gap-3 p-6">
        <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
        <div>
          <p className="font-medium text-slate-700 dark:text-slate-200">Analytics is unavailable</p>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">{metaError}</p>
        </div>
      </div>
    );
  }
  if (!meta) {
    return (
      <div className="space-y-4">
        <div className="h-16 animate-pulse rounded-2xl bg-slate-100 dark:bg-slate-800/60" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => <div key={i} className="card h-32 animate-pulse bg-slate-100 dark:bg-slate-800/60" />)}
        </div>
      </div>
    );
  }

  // Inside a single report the tab strip would be noise -- the way back is
  // the report's own "All reports" link.
  if (boardId) return <Board boardId={boardId} meta={meta} onBack={back} />;

  return (
    <div className="space-y-4">
      <div className="flex justify-end">{tabs}</div>
      {tab === 'explore' ? <ReportsExplorer /> : <Library meta={meta} onOpen={open} />}
    </div>
  );
}
