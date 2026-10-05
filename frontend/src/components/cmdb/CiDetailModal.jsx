import { useEffect, useState } from 'react';
import {
  Loader2, X, Link2, Ticket as TicketIcon, Trash2, Plus, Pencil, Zap, History,
  ShieldCheck, Wallet, UserCheck, ArrowRightLeft, AlertTriangle, Network,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { fmtDateTime, fmtRelative } from '../../lib/dates.js';
import Select from '../Select.jsx';
import AttributeField, { groupByOwner } from './AttributeField.jsx';

const TABS = [
  { key: 'attributes', label: 'Attributes', icon: ShieldCheck },
  { key: 'relationships', label: 'Relationships', icon: Network },
  { key: 'impact', label: 'Impact', icon: Zap },
  { key: 'custody', label: 'Custody', icon: UserCheck },
  { key: 'financials', label: 'Financials', icon: Wallet },
  { key: 'history', label: 'History', icon: History },
];

const money = (n, currency = 'USD') => (n === null || n === undefined
  ? '—'
  : new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(n));

// One CI, everything about it. Six tabs rather than one long scroll because
// the audiences differ: an engineer wants relationships and impact, a service
// desk lead wants custody, finance wants the money, and an auditor wants the
// history of who changed what.
export default function CiDetailModal({ ciId, isAdmin, onClose, onChanged }) {
  const [tab, setTab] = useState('attributes');
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const load = async () => {
    setError('');
    try { setDetail(await api.get(`/assets/${ciId}/detail`)); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [ciId]);

  if (error && !detail) {
    return (
      <Shell onClose={onClose} title="Configuration item">
        <div className="space-y-3 py-6 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          <button onClick={load} className="btn-primary mx-auto text-xs">Retry</button>
        </div>
      </Shell>
    );
  }
  if (!detail) {
    return (
      <Shell onClose={onClose} title="Configuration item">
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400">
          <Loader2 size={16} className="animate-spin" /> Loading…
        </p>
      </Shell>
    );
  }

  const { asset, ci_class: cls, ancestry, is_asset: isAsset } = detail;

  return (
    <Shell
      onClose={onClose}
      title={asset.name}
      subtitle={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-slate-400">{asset.tag}</span>
          {cls && (
            <span className="badge" style={{ backgroundColor: `${cls.color}1a`, color: cls.color }}>{cls.label}</span>
          )}
          {/* The class path, so an unfamiliar class is placed in the model at
              a glance rather than being just a word. */}
          {ancestry?.length > 1 && (
            <span className="text-[11px] text-slate-400">{ancestry.map((c) => c.label).join(' › ')}</span>
          )}
        </span>
      }
    >
      <div className="mb-3 flex flex-wrap gap-1 border-b border-slate-200 pb-2 dark:border-white/10">
        {TABS.filter((t) => !(t.key === 'financials' && (!isAsset || !isAdmin))).map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <Icon size={13} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'attributes' && <AttributesTab detail={detail} onSaved={() => { load(); onChanged?.(); }} />}
      {tab === 'relationships' && <RelationshipsTab detail={detail} onChanged={() => { load(); onChanged?.(); }} />}
      {tab === 'impact' && <ImpactTab ciId={ciId} onOpen={(id) => { onClose(); setTimeout(() => onChanged?.(id), 0); }} />}
      {tab === 'custody' && <CustodyTab ciId={ciId} onChanged={() => { load(); onChanged?.(); }} />}
      {tab === 'financials' && <FinancialsTab ciId={ciId} />}
      {tab === 'history' && <HistoryTab ciId={ciId} />}

      {detail.linkedTickets?.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">
            <TicketIcon size={13} /> Linked tickets
          </h4>
          <div className="space-y-1">
            {detail.linkedTickets.map((t) => (
              <button key={t.id} onClick={() => navigate(`/tickets/${t.id}`)}
                className="w-full rounded-md bg-slate-50 px-2 py-1.5 text-left text-sm hover:bg-slate-100 dark:bg-slate-800/60 dark:hover:bg-slate-800">
                {t.number} — {t.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </Shell>
  );
}

function Shell({ title, subtitle, onClose, children }) {
  // Escape closes it, the same as every other modal in the app. Without this
  // the only way out is the X, which is a small target and not what anyone
  // reaches for first.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-slate-900/40 px-4 py-8 dark:bg-slate-950/60" onClick={onClose}>
      <div className="card my-auto w-full max-w-3xl p-5" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-lg font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
            {subtitle && <div className="mt-1">{subtitle}</div>}
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ------------------------------------------------------------ attributes ---

function AttributesTab({ detail, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({});
  const [fieldErrors, setFieldErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const attributes = detail.attributes || [];
  const groups = groupByOwner(attributes);

  const start = () => {
    setDraft(Object.fromEntries(attributes.map((a) => [a.attr_key, a.value])));
    setFieldErrors({});
    setError('');
    setEditing(true);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.patch(`/assets/${detail.asset.id}`, { attributes: draft });
      setEditing(false);
      onSaved();
    } catch (err) {
      const detailErrors = err.body?.field_errors;
      if (Array.isArray(detailErrors) && detailErrors.length) {
        setFieldErrors(Object.fromEntries(detailErrors.map((f) => [f.attr_key, f.message])));
        setError('Some fields need attention.');
      } else setError(err.message);
    } finally { setSaving(false); }
  };

  if (!attributes.length) {
    return <p className="py-6 text-center text-sm text-slate-400">This CI has no class, so it has no declared fields.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        {editing ? (
          <>
            <button onClick={() => setEditing(false)} className="btn-secondary text-xs">Cancel</button>
            <button onClick={save} disabled={saving} className="btn-primary text-xs">
              {saving && <Loader2 size={12} className="animate-spin" />} Save
            </button>
          </>
        ) : (
          <button onClick={start} className="btn-secondary text-xs"><Pencil size={12} /> Edit</button>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
        </div>
      )}

      {groups.map((group) => (
        <div key={group.label} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{group.label}</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {group.attributes.map((attr) => (editing ? (
              <AttributeField
                key={attr.attr_key}
                attr={attr}
                value={draft[attr.attr_key]}
                onChange={(k, v) => setDraft((d) => ({ ...d, [k]: v }))}
                error={fieldErrors[attr.attr_key]}
              />
            ) : (
              <div key={attr.attr_key}>
                <div className="label mb-0.5">{attr.label}</div>
                <div className="text-sm text-slate-700 dark:text-slate-200">
                  {formatValue(attr)}
                  {attr.unit && attr.value !== null && <span className="ml-1 text-xs text-slate-400">{attr.unit}</span>}
                </div>
                {/* Which tool last wrote this. The question "why does it say
                    that?" is the one that decides whether a CMDB is trusted. */}
                {attr.source && attr.source !== 'manual' && (
                  <div className="mt-0.5 text-[10px] text-slate-400">from {attr.source}</div>
                )}
              </div>
            )))}
          </div>
        </div>
      ))}
    </div>
  );
}

function formatValue(attr) {
  const v = attr.value;
  if (v === null || v === undefined || v === '') return <span className="text-slate-300 dark:text-slate-600">—</span>;
  if (attr.data_type === 'boolean') return v ? 'Yes' : 'No';
  if (attr.data_type === 'multiselect') return Array.isArray(v) ? v.join(', ') : String(v);
  if (attr.data_type === 'url') return <a href={v} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline dark:text-brand-400">{v}</a>;
  if (attr.data_type === 'datetime') return fmtDateTime(v);
  return String(v);
}

// --------------------------------------------------------- relationships ---

function RelationshipsTab({ detail, onChanged }) {
  const [types, setTypes] = useState([]);
  const [all, setAll] = useState([]);
  const [target, setTarget] = useState('');
  const [type, setType] = useState('depends_on');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/cmdb/relationship-types').then((d) => setTypes(d.relationship_types || [])).catch(() => {});
    api.get('/assets').then((d) => setAll(d.assets || [])).catch(() => {});
  }, []);

  const add = async () => {
    if (!target) return;
    setError('');
    try {
      await api.post(`/assets/${detail.asset.id}/relationships`, { related_asset_id: target, relationship_type: type });
      setTarget('');
      onChanged();
    } catch (e) { setError(e.message); }
  };

  const remove = async (relId) => {
    await api.del(`/assets/relationships/${relId}`);
    onChanged();
  };

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      <div>
        <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300">
          <Link2 size={13} /> This CI depends on
        </h4>
        {detail.dependsOn.length === 0 && <p className="text-xs text-slate-400">Nothing recorded. Impact analysis cannot see past this CI until something is.</p>}
        <div className="space-y-1">
          {detail.dependsOn.map((r) => (
            <div key={r.rel_id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-sm dark:bg-slate-800/60">
              <span>{r.name} <span className="text-xs text-slate-400">({r.relationship_label || r.relationship_type})</span></span>
              <button onClick={() => remove(r.rel_id)} className="text-slate-400 hover:text-red-500"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>

        <div className="mt-2 flex flex-wrap gap-2">
          <Select
            className="min-w-[200px] flex-1"
            value={target}
            onChange={setTarget}
            placeholder="Link to a CI…"
            options={all.filter((a) => a.id !== detail.asset.id).map((a) => ({ value: a.id, label: `${a.name} (${a.tag})` }))}
          />
          <Select
            className="w-auto min-w-[150px]"
            value={type}
            onChange={setType}
            options={types.map((t) => ({ value: t.key, label: t.label }))}
          />
          <button onClick={add} className="btn-secondary shrink-0"><Plus size={14} /></button>
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Things that depend on this CI</h4>
        {detail.dependedOnBy.length === 0 && <p className="text-xs text-slate-400">Nothing depends on this.</p>}
        <div className="space-y-1">
          {detail.dependedOnBy.map((r) => (
            <div key={r.rel_id} className="rounded-md bg-amber-50 px-2 py-1.5 text-sm text-amber-700 dark:bg-amber-500/10 dark:text-amber-400">
              {r.name} <span className="text-xs opacity-70">({r.relationship_label || r.relationship_type})</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- impact ---

function ImpactTab({ ciId }) {
  const [data, setData] = useState(null);
  const [depth, setDepth] = useState(4);

  useEffect(() => {
    setData(null);
    api.get(`/cmdb/ci/${ciId}/impact?depth=${depth}`).then(setData).catch(() => setData({ nodes: [], services: [] }));
  }, [ciId, depth]);

  if (!data) return <p className="py-6 text-center text-sm text-slate-400"><Loader2 size={14} className="inline animate-spin" /> Working out the blast radius…</p>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">What would be affected if this CI failed.</p>
        <Select
          className="w-auto" size="sm" value={String(depth)} onChange={(v) => setDepth(Number(v))}
          options={[2, 3, 4, 6, 8].map((d) => ({ value: String(d), label: `${d} hops` }))}
        />
      </div>

      {/* Services first. Infrastructure counts are a proxy; a named service is
          the thing anyone actually makes a decision about. */}
      <div>
        <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Business services reached</h4>
        {data.services?.length ? (
          <div className="space-y-1">
            {data.services.map((s) => (
              <div key={s.id} className="rounded-md bg-red-50 px-2 py-1.5 text-sm font-medium text-red-700 dark:bg-red-500/10 dark:text-red-300">
                {s.name} <span className="text-xs font-normal opacity-70">· {s.depth} hop{s.depth === 1 ? '' : 's'} away</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-400">None — either nothing maps up to a service, or this CI genuinely stands alone.</p>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
          All affected CIs <span className="font-normal text-slate-400">({data.nodes.length})</span>
        </h4>
        {data.nodes.length === 0 && <p className="text-xs text-slate-400">Nothing depends on this CI.</p>}
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {data.nodes.map((n) => (
            <div key={n.id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-sm dark:bg-slate-800/60">
              <span>
                {n.name}
                {n.ci_class && <span className="ml-1.5 text-[10px] text-slate-400">{n.ci_class.label}</span>}
              </span>
              <span className="text-[10px] text-slate-400">{n.relationship_label} · depth {n.depth}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// --------------------------------------------------------------- custody ---

function CustodyTab({ ciId, onChanged }) {
  const [data, setData] = useState(null);
  const [agents, setAgents] = useState([]);
  const [user, setUser] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');

  const load = () => api.get(`/itam/assets/${ciId}/lifecycle`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); api.get('/tickets/assignable-agents').then((d) => setAgents(d.agents || [])).catch(() => {}); }, [ciId]);

  if (!data) return <p className="py-6 text-center text-sm text-slate-400"><Loader2 size={14} className="inline animate-spin" /> Loading…</p>;

  const act = async (fn) => {
    setError('');
    try { await fn(); await load(); onChanged?.(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      <div className="flex flex-wrap items-center gap-2">
        <span className="label mb-0">Lifecycle</span>
        <span className="badge bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-200">{data.label}</span>
        <span className="text-[11px] text-slate-400">{data.description}</span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {data.transitions.map((t) => (
          <button
            key={t.key}
            onClick={() => act(() => api.post(`/itam/assets/${ciId}/lifecycle`, { to: t.key }))}
            className="btn-secondary text-xs"
            title={t.description}
          >
            <ArrowRightLeft size={11} /> {t.label}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
        {data.current_assignment ? (
          <div className="space-y-2">
            <div className="text-sm text-slate-700 dark:text-slate-200">
              Currently held by <strong>{data.assignments[0]?.user_name || data.current_assignment.assigned_to_label || 'someone'}</strong>
              <span className="ml-1 text-xs text-slate-400">since {fmtDateTime(data.current_assignment.assigned_at)}</span>
            </div>
            <button onClick={() => act(() => api.post(`/itam/assets/${ciId}/check-in`, {}))} className="btn-primary text-xs">
              Check back in
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="text-sm text-slate-500 dark:text-slate-400">Not currently issued to anybody.</div>
            <div className="flex flex-wrap gap-2">
              <Select
                className="min-w-[180px] flex-1" value={user} onChange={setUser} placeholder="Issue to a person…"
                options={agents.map((a) => ({ value: a.id, label: a.name }))}
              />
              <input className="input w-auto flex-1" placeholder="…or a place" value={label} onChange={(e) => setLabel(e.target.value)} />
              <button
                onClick={() => act(() => api.post(`/itam/assets/${ciId}/check-out`, { user_id: user || null, label: label || null }))}
                disabled={!user && !label}
                className="btn-primary shrink-0 text-xs disabled:opacity-40"
              >
                Check out
              </button>
            </div>
          </div>
        )}
      </div>

      <div>
        <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Custody history</h4>
        {data.assignments.length === 0 && <p className="text-xs text-slate-400">Never issued.</p>}
        <div className="space-y-1">
          {data.assignments.map((a) => (
            <div key={a.id} className="rounded-md bg-slate-50 px-2 py-1.5 text-xs dark:bg-slate-800/60">
              <span className="text-slate-700 dark:text-slate-200">{a.user_name || a.assigned_to_label || 'Unknown'}</span>
              <span className="text-slate-400"> · {fmtDateTime(a.assigned_at)} → {a.returned_at ? fmtDateTime(a.returned_at) : 'still out'}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ financials ---

function FinancialsTab({ ciId }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [methods, setMethods] = useState([]);

  const load = () => api.get(`/itam/assets/${ciId}/financials`).then((d) => {
    setData(d.financials);
    setForm(d.financials || {});
  }).catch((e) => setError(e.message));

  useEffect(() => { load(); api.get('/itam/meta').then((m) => setMethods(m.depreciation_methods || [])).catch(() => {}); }, [ciId]);

  if (!form) return <p className="py-6 text-center text-sm text-slate-400"><Loader2 size={14} className="inline animate-spin" /> Loading…</p>;

  const save = async () => {
    setSaving(true); setError('');
    try { await api.put(`/itam/assets/${ciId}/financials`, form); await load(); } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  const dep = data?.depreciation;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-4">
      {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      {dep && (
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50 sm:grid-cols-4">
          <Stat label="Purchase cost" value={money(dep.purchase_cost, form.currency)} />
          <Stat label="Book value" value={money(dep.book_value, form.currency)} />
          <Stat label="Depreciated" value={money(dep.accumulated_depreciation, form.currency)} />
          <Stat label="Months left" value={dep.months_remaining ?? '—'} />
          {/* Say what is missing rather than quietly showing the purchase
              price as though it were today's value. */}
          {dep.missing?.length > 0 && (
            <div className="col-span-2 text-[11px] text-amber-600 dark:text-amber-400 sm:col-span-4">
              Not depreciating yet — still needs {dep.missing.join(' and ').replace(/_/g, ' ')}.
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div><label className="label">Purchase cost</label>
          <input className="input" type="number" value={form.purchase_cost ?? ''} onChange={(e) => set('purchase_cost', e.target.value)} /></div>
        <div><label className="label">Currency</label>
          <input className="input" value={form.currency ?? 'USD'} onChange={(e) => set('currency', e.target.value)} /></div>
        <div><label className="label">In service from</label>
          <input className="input" type="date" value={(form.in_service_date ?? '').slice(0, 10)} onChange={(e) => set('in_service_date', e.target.value)} /></div>
        <div><label className="label">Useful life (months)</label>
          <input className="input" type="number" value={form.useful_life_months ?? ''} onChange={(e) => set('useful_life_months', e.target.value)} /></div>
        <div><label className="label">Salvage value</label>
          <input className="input" type="number" value={form.salvage_value ?? ''} onChange={(e) => set('salvage_value', e.target.value)} /></div>
        <div><label className="label">Depreciation method</label>
          <Select value={form.depreciation_method || 'straight_line'} onChange={(v) => set('depreciation_method', v)}
            options={methods.map((m) => ({ value: m.key, label: m.label }))} /></div>
        <div><label className="label">Cost centre</label>
          <input className="input" value={form.cost_centre ?? ''} onChange={(e) => set('cost_centre', e.target.value)} /></div>
        <div><label className="label">Annual support cost</label>
          <input className="input" type="number" value={form.annual_support_cost ?? ''} onChange={(e) => set('annual_support_cost', e.target.value)} /></div>
        <div><label className="label">Supplier</label>
          <input className="input" value={form.supplier ?? ''} onChange={(e) => set('supplier', e.target.value)} /></div>
        <div><label className="label">Invoice number</label>
          <input className="input" value={form.invoice_number ?? ''} onChange={(e) => set('invoice_number', e.target.value)} /></div>
      </div>

      <div className="flex justify-end">
        <button onClick={save} disabled={saving} className="btn-primary text-xs">
          {saving && <Loader2 size={12} className="animate-spin" />} Save financials
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">{value}</div>
    </div>
  );
}

// --------------------------------------------------------------- history ---

function HistoryTab({ ciId }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get(`/discovery/ci/${ciId}/history`).then(setData).catch(() => setData({ history: [], provenance: [] })); }, [ciId]);

  if (!data) return <p className="py-6 text-center text-sm text-slate-400"><Loader2 size={14} className="inline animate-spin" /> Loading…</p>;

  return (
    <div className="space-y-4">
      <div>
        <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Attribute changes</h4>
        {data.history.length === 0 && <p className="text-xs text-slate-400">Nothing has changed since this CI was created.</p>}
        <div className="max-h-72 space-y-1 overflow-y-auto">
          {data.history.map((h) => (
            <div
              key={h.id}
              className={`rounded-md px-2 py-1.5 text-xs ${
                h.accepted ? 'bg-slate-50 dark:bg-slate-800/60' : 'bg-amber-50 dark:bg-amber-500/10'
              }`}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-slate-700 dark:text-slate-200">{h.attr_key}</span>
                <span className="text-slate-400">{h.old_value ?? '—'} → {h.new_value ?? '—'}</span>
                {/* A refused write is the interesting row: it means two tools
                    disagree about this CI. */}
                {!h.accepted && <span className="badge bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">refused</span>}
              </div>
              <div className="mt-0.5 text-[10px] text-slate-400">
                {h.source} · {fmtRelative(h.changed_at)}{h.reason ? ` · ${h.reason}` : ''}
              </div>
            </div>
          ))}
        </div>
      </div>

      {data.provenance.length > 0 && (
        <div>
          <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Which source owns each value</h4>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {data.provenance.map((p) => (
              <div key={p.attribute_id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1 text-xs dark:bg-slate-800/60">
                <span className="text-slate-600 dark:text-slate-300">{p.label || p.attr_key}</span>
                <span className="text-slate-400">{p.source_key} · trust {p.trust_rank}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
