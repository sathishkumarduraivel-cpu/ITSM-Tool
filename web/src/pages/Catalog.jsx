import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, Search, Loader2, Package, X, BarChart3, ShoppingCart, Pencil, Trash2,
  Clock, Wallet, ShieldCheck, Lock, AlertTriangle, TrendingDown, CheckCircle2,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Select from '../components/Select.jsx';
import Modal from '../components/Modal.jsx';
import RequestModal, { RequestSubmitted } from '../components/catalog/RequestModal.jsx';
import ItemBuilder from '../components/catalog/ItemBuilder.jsx';

const money = (n, currency = 'USD') => new Intl.NumberFormat(undefined, {
  style: 'currency', currency, maximumFractionDigits: 0,
}).format(n || 0);

const STATUS_STYLE = {
  draft: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  published: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  retired: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

export default function Catalog() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const [meta, setMeta] = useState(null);
  const [tab, setTab] = useState(params.get('tab') || 'browse');
  const [refresh, setRefresh] = useState(0);
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    api.get('/catalog/meta').then(setMeta).catch(() => setMeta(null));
    api.get('/catalog/categories').then((d) => setCategories(d.categories || [])).catch(() => {});
  }, [refresh]);

  const canManage = !!meta?.can_manage;
  const go = (next) => {
    setTab(next);
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p, { replace: true });
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Service Catalog"
        description="What people can ask for, what it costs, who signs it off, and what happens once they do."
      />

      {canManage && (
        <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-white/10">
          {[['browse', 'Browse', ShoppingCart], ['manage', 'Manage', Package], ['insights', 'Insights', BarChart3]].map(([key, label, Icon]) => (
            <button key={key} onClick={() => go(key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      )}

      {tab === 'insights' && canManage && <Insights />}
      {tab === 'manage' && canManage && (
        <Manage key={refresh} meta={meta} categories={categories} onChanged={() => setRefresh((n) => n + 1)} />
      )}
      {(tab === 'browse' || !canManage) && <Browse key={refresh} categories={categories} />}
    </div>
  );
}

// ---------------------------------------------------------------- browse ---

function Browse({ categories }) {
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [ordering, setOrdering] = useState(null);
  const [submitted, setSubmitted] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const p = new URLSearchParams();
      if (categoryId) p.set('category_id', categoryId);
      if (q.trim()) p.set('q', q.trim());
      setItems((await api.get(`/catalog/items?${p}`)).items);
    } catch (e) { setError(e.message); setItems([]); }
  };
  useEffect(() => { load(); }, [categoryId]);
  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [q]);

  const openItem = async (item) => {
    // Re-fetched so the form schema is current even if an admin changed it
    // while this page was open.
    try { setOrdering((await api.get(`/catalog/items/${item.id}`)).item); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search the catalog…" value={q} onChange={(e) => setQ(e.target.value)} />
          {q && <button onClick={() => setQ('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"><X size={13} /></button>}
        </div>
        <Select className="w-auto min-w-[170px]" value={categoryId} onChange={setCategoryId} placeholder="All categories"
          options={[{ value: '', label: 'All categories' }, ...categories.map((c) => ({ value: c.id, label: `${c.name} (${c.item_count})` }))]} />
      </div>

      {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      {!items ? (
        <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState icon={Package} title={q || categoryId ? 'Nothing matches' : 'Nothing in the catalog yet'}
          description={q || categoryId ? 'Try different words or another category.' : 'Once items are published they appear here.'} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <button key={item.id} onClick={() => openItem(item)}
              className="card p-4 text-left transition-colors hover:border-brand-300 dark:hover:border-brand-500/40">
              <div className="flex items-start justify-between gap-2">
                <h3 className="font-medium text-slate-800 dark:text-slate-100">{item.name}</h3>
                {item.cost != null && (
                  <span className="shrink-0 text-xs font-semibold text-slate-600 dark:text-slate-300">{money(item.cost, item.currency)}</span>
                )}
              </div>
              <p className="mt-1 line-clamp-2 text-xs text-slate-500 dark:text-slate-400">
                {item.short_description || item.description}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
                {item.category && <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{item.category.name}</span>}
                {item.delivery_days != null && (
                  <span className="flex items-center gap-1 text-slate-400"><Clock size={10} /> {item.delivery_days}d</span>
                )}
                {!!item.approval_required && (
                  <span className="flex items-center gap-1 text-amber-600 dark:text-amber-400"><ShieldCheck size={10} /> approval</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {ordering && (
        <RequestModal
          item={ordering}
          onClose={() => setOrdering(null)}
          onSubmitted={(ticket, chain) => { setOrdering(null); setSubmitted({ ticket, chain }); load(); }}
        />
      )}
      {submitted && (
        <RequestSubmitted ticket={submitted.ticket} chain={submitted.chain} onClose={() => setSubmitted(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- manage ---

function Manage({ meta, categories, onChanged }) {
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState('');

  const load = async () => {
    try { setItems((await api.get('/catalog/items?all=1')).items); } catch (e) { setError(e.message); setItems([]); }
  };
  useEffect(() => { load(); }, []);

  const create = async () => {
    setError('');
    try {
      const { item } = await api.post('/catalog/items', { name: newName });
      setCreating(false); setNewName('');
      await load(); onChanged?.();
      setEditing(item.id);
    } catch (e) { setError(e.message); }
  };

  const remove = async (item) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    setError('');
    try { await api.del(`/catalog/items/${item.id}`); await load(); onChanged?.(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-slate-500 dark:text-slate-400">Drafts are only visible here until you publish them.</p>
        <button onClick={() => setCreating(true)} className="btn-primary text-xs"><Plus size={13} /> New item</button>
      </div>

      {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      {!items ? (
        <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState icon={Package} title="No catalog items" description="Create one, then set its form, approval and fulfilment steps."
          action={<button onClick={() => setCreating(true)} className="btn-primary text-xs"><Plus size={13} /> New item</button>} />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <button onClick={() => setEditing(item.id)} className="min-w-[180px] flex-1 text-left">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{item.name}</span>
                  <span className={`badge ${STATUS_STYLE[item.status] || STATUS_STYLE.draft}`}>{item.status_meta?.label || item.status}</span>
                </div>
                <div className="text-[11px] text-slate-400">
                  {item.category?.name || 'Unfiled'}
                  {item.cost != null && ` · ${money(item.cost, item.currency)}`}
                  {item.delivery_days != null && ` · ${item.delivery_days}d`}
                  {item.request_count ? ` · ${item.request_count} requested` : ''}
                </div>
              </button>
              <button onClick={() => setEditing(item.id)} className="rounded-lg p-1.5 text-slate-400 hover:text-brand-600"><Pencil size={13} /></button>
              <button onClick={() => remove(item)} className="rounded-lg p-1.5 text-slate-400 hover:text-red-500"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <Modal title="New catalog item" onClose={() => setCreating(false)}>
          <div className="space-y-3">
            <div>
              <label className="label">Name<span className="text-red-500">*</span></label>
              <input className="input" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} />
              <p className="mt-1 text-[11px] text-slate-400">It starts as a draft so you can set it up before anyone can order it.</p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setCreating(false)} className="btn-secondary">Cancel</button>
              <button onClick={create} disabled={!newName.trim()} className="btn-primary disabled:opacity-40">Create</button>
            </div>
          </div>
        </Modal>
      )}

      {editing && (
        <ItemBuilder itemId={editing} meta={meta} categories={categories}
          onClose={() => setEditing(null)} onSaved={() => { load(); onChanged?.(); }} />
      )}
    </div>
  );
}

// -------------------------------------------------------------- insights ---

function Insights() {
  const [days, setDays] = useState(30);
  const [overview, setOverview] = useState(null);
  const [approvals, setApprovals] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setOverview(null);
    Promise.all([
      api.get(`/catalog/analytics/overview?days=${days}`).then(setOverview),
      api.get(`/catalog/analytics/approvals?days=${days}`).then(setApprovals),
    ]).catch((e) => setError(e.message));
  }, [days]);

  if (error) return <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>;
  if (!overview) return <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>;

  const d = overview.delivery;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid flex-1 grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Requests" value={overview.requests.total} sub={`${overview.requests.completed} completed`} />
          <Stat label="Awaiting approval" value={overview.requests.awaiting_approval}
            tone={overview.requests.awaiting_approval ? 'warn' : 'ok'} />
          <Stat label="Delivered on time" value={d.on_time_rate != null ? `${d.on_time_rate}%` : '—'}
            sub={d.on_time_rate != null ? `${d.on_time} of ${d.on_time + d.late}` : d.note} />
          <Stat label="Spend" value={money(overview.requests.total_cost)} />
        </div>
        <Select className="w-auto" value={String(days)} onChange={(v) => setDays(Number(v))}
          options={[7, 30, 90, 180].map((n) => ({ value: String(n), label: `Last ${n} days` }))} />
      </div>

      {d.overdue_now > 0 && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2.5 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          {d.overdue_now} request{d.overdue_now === 1 ? ' is' : 's are'} already past the delivery date the catalog promised.
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel icon={ShoppingCart} title="Most requested" hint="What to automate first.">
          {overview.most_requested.length === 0 ? <p className="text-xs text-slate-400">Nothing requested yet.</p> : (
            <div className="space-y-1">
              {overview.most_requested.map((i) => (
                <div key={i.id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-sm dark:bg-slate-800/60">
                  <span className="text-slate-700 dark:text-slate-200">{i.name}</span>
                  <span className="text-xs text-slate-400">{i.requests}</span>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel icon={TrendingDown} title="Published but never requested"
          hint="Badly named, badly placed, or nobody needs it. All three are worth knowing.">
          {overview.never_requested.length === 0 ? (
            <p className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"><CheckCircle2 size={11} /> Everything has been requested at least once.</p>
          ) : (
            <div className="space-y-1">
              {overview.never_requested.map((i) => (
                <div key={i.id} className="rounded-md bg-amber-50 px-2 py-1.5 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
                  {i.name}
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {approvals && (
        <Panel icon={ShieldCheck} title="Where requests are waiting"
          hint="Almost always an approver rather than the fulfilment team — a completely different fix.">
          <div className="mb-2 flex flex-wrap gap-3 text-xs text-slate-500 dark:text-slate-400">
            <span>{approvals.pending_total} pending</span>
            {approvals.avg_decision_hours != null && <span>· average decision {approvals.avg_decision_hours}h</span>}
            <span>· {approvals.approved} approved, {approvals.rejected} rejected</span>
          </div>
          {approvals.by_approver.length === 0 ? (
            <p className="text-xs text-slate-400">Nothing waiting.</p>
          ) : (
            <div className="space-y-1">
              {approvals.by_approver.map((a) => (
                <div key={a.approver} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-sm dark:bg-slate-800/60">
                  <span className="text-slate-700 dark:text-slate-200">{a.approver}</span>
                  <span className="text-xs text-slate-400">
                    {a.pending} waiting · oldest {Math.round(a.oldest_hours)}h
                  </span>
                </div>
              ))}
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function Panel({ icon: Icon, title, hint, children }) {
  return (
    <div className="card p-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <Icon size={14} /> {title}
      </h3>
      {hint && <p className="mb-2 mt-0.5 text-[11px] text-slate-400">{hint}</p>}
      {children}
    </div>
  );
}

function Stat({ label, value, sub, tone }) {
  return (
    <div className="card p-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`font-display text-xl font-bold ${tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-800 dark:text-slate-100'}`}>{value}</div>
      {sub && <div className="text-[10px] text-slate-400">{sub}</div>}
    </div>
  );
}
