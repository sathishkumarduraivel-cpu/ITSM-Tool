import { Fragment, useEffect, useState } from 'react';
import {
  Loader2, Plus, Trash2, Pencil, GitBranch, Snowflake, Gauge, FileText, Users,
  ToggleLeft, ToggleRight, Check, X, AlertTriangle, Lock, ArrowUp, ArrowDown, LockKeyhole, Save, RotateCcw,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/dates.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import EmptyState from '../EmptyState.jsx';

const SUB_TABS = [
  { key: 'types', label: 'Change Types', icon: GitBranch },
  { key: 'templates', label: 'Standard Templates', icon: FileText },
  { key: 'risk', label: 'Risk Scoring', icon: Gauge },
  { key: 'freezes', label: 'Freeze Windows', icon: Snowflake },
  { key: 'routes', label: 'Approval Routes', icon: Users },
  { key: 'fieldAccess', label: 'Field Access', icon: LockKeyhole },
];

const BAND_STYLES = {
  low: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  medium: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  high: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300',
  critical: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
};

function Toggle({ on, onClick, label, hint, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled}
      className="flex w-full items-start gap-2 rounded-xl border border-slate-200 p-2.5 text-left transition-colors hover:bg-slate-50 disabled:opacity-50 dark:border-white/10 dark:hover:bg-slate-800/50">
      {on ? <ToggleRight size={17} className="mt-0.5 shrink-0 text-brand-600" /> : <ToggleLeft size={17} className="mt-0.5 shrink-0 text-slate-400" />}
      <span className="min-w-0">
        <span className="block text-xs font-medium text-slate-700 dark:text-slate-200">{label}</span>
        {hint && <span className="mt-0.5 block text-[11px] text-slate-500 dark:text-slate-400">{hint}</span>}
      </span>
    </button>
  );
}

function TypesPane({ config, onChanged, setError }) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState(false);

  const start = (t) => {
    setEditing(t.id);
    setDraft({
      label: t.label, approval_sla_hours: t.approval_sla_hours ?? '',
      lead_time_hours: t.lead_time_hours ?? 0,
      requires_backout: !!t.requires_backout, requires_test_plan: !!t.requires_test_plan,
      requires_implementation_plan: !!t.requires_implementation_plan,
      allow_freeze_override: !!t.allow_freeze_override,
      pir_required_bands: t.pir_required_bands || [],
    });
  };

  const save = async (t) => {
    setBusy(true); setError('');
    try {
      await api.patch(`/change-config/types/${t.id}`, {
        ...draft,
        approval_sla_hours: draft.approval_sla_hours === '' ? null : Number(draft.approval_sla_hours),
        lead_time_hours: Number(draft.lead_time_hours) || 0,
      });
      setEditing(null);
      onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const toggleBand = (band) => setDraft((d) => ({
    ...d,
    pir_required_bands: d.pir_required_bands.includes(band)
      ? d.pir_required_bands.filter((b) => b !== band)
      : [...d.pir_required_bands, band],
  }));

  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
        The four lanes from the change flow. The keys are fixed — the approval routing is wired to them — but every policy attached to a type is yours.
      </p>
      {config.change_types.map((t) => (
        <div key={t.id} className="card p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.label}</span>
                <code className="text-[10px] text-slate-400">{t.key}</code>
                <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{t.approval_mode.replace(/_/g, ' ')}</span>
                {t.allow_freeze_override && <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><Snowflake size={9} /> may override a freeze</span>}
              </div>
              <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t.description}</p>
              <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-500 dark:text-slate-400">
                <span>Approval SLA: {t.approval_sla_hours ? `${t.approval_sla_hours}h` : 'none'}</span>
                <span>Lead time: {t.lead_time_hours || 0}h</span>
                <span>Backout {t.requires_backout ? 'required' : 'optional'}</span>
                <span>Test plan {t.requires_test_plan ? 'required' : 'optional'}</span>
                <span>PIR for: {t.pir_required_bands.length ? t.pir_required_bands.join(', ') : 'never'}</span>
              </div>
            </div>
            {editing === t.id
              ? <div className="flex gap-1">
                <button onClick={() => save(t)} disabled={busy} className="btn-primary text-xs">{busy ? <Loader2 size={11} className="animate-spin" /> : <Check size={11} />} Save</button>
                <button onClick={() => setEditing(null)} className="btn-secondary text-xs">Cancel</button>
              </div>
              : <button onClick={() => start(t)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={13} /></button>}
          </div>

          {editing === t.id && (
            <div className="mt-3 space-y-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
              <div className="grid gap-3 sm:grid-cols-3">
                <div>
                  <label className="label">Label</label>
                  <input className="input" value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
                </div>
                <div>
                  <label className="label">Approval SLA (hours)</label>
                  <input type="number" min="0" step="0.5" className="input" value={draft.approval_sla_hours}
                    onChange={(e) => setDraft({ ...draft, approval_sla_hours: e.target.value })} placeholder="none" />
                </div>
                <div>
                  <label className="label">Minimum lead time (hours)</label>
                  <input type="number" min="0" className="input" value={draft.lead_time_hours}
                    onChange={(e) => setDraft({ ...draft, lead_time_hours: e.target.value })} />
                </div>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                <Toggle on={draft.requires_implementation_plan} onClick={() => setDraft({ ...draft, requires_implementation_plan: !draft.requires_implementation_plan })}
                  label="Implementation plan required" />
                <Toggle on={draft.requires_backout} onClick={() => setDraft({ ...draft, requires_backout: !draft.requires_backout })}
                  label="Backout plan required" hint="Enforced before implementation may start" />
                <Toggle on={draft.requires_test_plan} onClick={() => setDraft({ ...draft, requires_test_plan: !draft.requires_test_plan })}
                  label="Test plan required" />
                <Toggle on={draft.allow_freeze_override} onClick={() => setDraft({ ...draft, allow_freeze_override: !draft.allow_freeze_override })}
                  label="May override a change freeze" hint="Only with a recorded reason, counted as a freeze violation" />
              </div>
              <div>
                <label className="label">Post-implementation review required for</label>
                <div className="flex flex-wrap gap-1.5">
                  {['low', 'medium', 'high', 'critical'].map((band) => (
                    <button key={band} type="button" onClick={() => toggleBand(band)}
                      className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                        draft.pir_required_bands.includes(band) ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                      }`}>{band}</button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-slate-400">A change in a selected band cannot be closed until its review is complete.</p>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

function TemplatesPane({ config, onChanged, setError }) {
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);

  const openNew = () => { setForm({ name: '', match_category: '', match_subcategory: '', match_title_contains: '', implementation_plan: '', backout_plan: '', test_plan: '' }); setModal('new'); };
  const openEdit = (t) => { setForm({ ...t }); setModal(t); };

  const save = async () => {
    setBusy(true); setError('');
    try {
      if (modal === 'new') await api.post('/change-config/templates', form);
      else await api.patch(`/change-config/templates/${modal.id}`, form);
      setModal(null); onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete "${t.name}"?`)) return;
    try {
      const resp = await api.del(`/change-config/templates/${t.id}`);
      if (resp.deactivated) setError(`"${t.name}" is used by ${resp.changes} change(s), so it was disabled rather than deleted.`);
      onChanged();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          A Standard change that matches one of these auto-approves and inherits its plans. Anything that matches nothing is routed as Normal instead.
        </p>
        <button onClick={openNew} className="btn-primary shrink-0 text-xs"><Plus size={13} /> New template</button>
      </div>

      {config.templates.length === 0 ? (
        <EmptyState icon={FileText} title="No templates" description="Without one, every Standard change falls back to the Normal CAB route." />
      ) : config.templates.map((t) => (
        <div key={t.id} className={`card p-4 ${!t.enabled ? 'opacity-60' : ''}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{t.name}</span>
                {!t.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">disabled</span>}
                {t.usage_count > 0 && <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">used {t.usage_count}×</span>}
              </div>
              {t.description && <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{t.description}</p>}
              <p className="mt-1 text-[11px] text-slate-400">
                Matches: {[t.match_category && `category ${t.match_category}`, t.match_subcategory && `subcategory ${t.match_subcategory}`,
                  t.match_title_contains && `title contains "${t.match_title_contains}"`, t.match_asset_type && `CI type ${t.match_asset_type}`]
                  .filter(Boolean).join(' · ') || 'anything (catch-all)'}
              </p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button onClick={() => openEdit(t)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={13} /></button>
              <button onClick={() => remove(t)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={13} /></button>
            </div>
          </div>
        </div>
      ))}

      {modal && (
        <Modal title={modal === 'new' ? 'New standard change template' : `Edit "${modal.name}"`} onClose={() => setModal(null)} maxWidth="max-w-2xl">
          <div className="space-y-3">
            <div>
              <label className="label">Name</label>
              <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label">Description</label>
              <input className="input" value={form.description || ''} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="grid gap-3 sm:grid-cols-3">
              {['match_category', 'match_subcategory', 'match_title_contains'].map((f) => (
                <div key={f}>
                  <label className="label">{f.replace('match_', '').replace(/_/g, ' ')}</label>
                  <input className="input" value={form[f] || ''} onChange={(e) => setForm({ ...form, [f]: e.target.value })} placeholder="Any" />
                </div>
              ))}
            </div>
            {['implementation_plan', 'backout_plan', 'test_plan'].map((f) => (
              <div key={f}>
                <label className="label">{f.replace(/_/g, ' ')}</label>
                <textarea className="input min-h-[60px]" value={form[f] || ''} onChange={(e) => setForm({ ...form, [f]: e.target.value })} />
              </div>
            ))}
            <div className="flex justify-end gap-2">
              <button onClick={() => setModal(null)} className="btn-secondary">Cancel</button>
              <button onClick={save} disabled={busy || !form.name?.trim()} className="btn-primary">
                {busy ? <Loader2 size={14} className="animate-spin" /> : null} Save
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RiskPane({ config, onChanged, setError }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', signal: 'priority', operator: 'equals', value: '', points: 10 });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true); setError('');
    try { await api.post('/change-config/risk-rules', form); setAdding(false); setForm({ name: '', signal: 'priority', operator: 'equals', value: '', points: 10 }); onChanged(); }
    catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const remove = async (r) => {
    try { await api.del(`/change-config/risk-rules/${r.id}`); onChanged(); } catch (e) { setError(e.message); }
  };

  const toggle = async (r) => {
    try { await api.patch(`/change-config/risk-rules/${r.id}`, { enabled: !r.enabled }); onChanged(); } catch (e) { setError(e.message); }
  };

  const setBand = async (b, min) => {
    try { await api.patch(`/change-config/risk-bands/${b.id}`, { min_score: Number(min) }); onChanged(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-4">
      <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
        Risk decides which approval route a change takes, so it is scored deterministically: matching rules add their points, and the total lands in a band.
        Two of the signals come from your CMDB — how many CIs depend on what this change touches, and whether any of them already have open incidents.
      </p>

      <div className="card p-4">
        <h4 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Bands</h4>
        <div className="grid gap-3 sm:grid-cols-4">
          {config.risk_bands.map((b) => (
            <div key={b.id}>
              <label className="label"><span className={`badge ${BAND_STYLES[b.band]}`}>{b.band}</span></label>
              <input type="number" min="0" className="input" defaultValue={b.min_score} onBlur={(e) => setBand(b, e.target.value)} />
              <p className="mt-0.5 text-[10px] text-slate-400">score ≥ this</p>
            </div>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Scoring rules</h4>
        <button onClick={() => setAdding((a) => !a)} className="btn-secondary text-xs"><Plus size={12} /> Rule</button>
      </div>

      {adding && (
        <div className="card space-y-3 p-3">
          <div className="grid gap-2 sm:grid-cols-5">
            <input className="input sm:col-span-2" placeholder="Rule name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <Select value={form.signal} onChange={(v) => setForm({ ...form, signal: v })} options={config.meta.signals.map((s) => ({ value: s.key, label: s.label }))} />
            <Select value={form.operator} onChange={(v) => setForm({ ...form, operator: v })} options={config.meta.operators.map((o) => ({ value: o, label: o.replace(/_/g, ' ') }))} />
            <input className="input" placeholder="value" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
          </div>
          <div className="flex items-center gap-2">
            <label className="label mb-0">Points</label>
            <input type="number" className="input w-24" value={form.points} onChange={(e) => setForm({ ...form, points: e.target.value })} />
            <button onClick={add} disabled={busy || !form.name.trim()} className="btn-primary text-xs">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Plus size={12} />} Add rule
            </button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden p-0">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Rule</th>
              <th className="px-3 py-2 text-left font-medium">When</th>
              <th className="px-3 py-2 text-left font-medium">Points</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {config.risk_rules.map((r) => (
              <tr key={r.id} className={`border-t border-slate-100 dark:border-white/5 ${!r.enabled ? 'opacity-50' : ''}`}>
                <td className="px-3 py-2 font-medium text-slate-800 dark:text-slate-100">{r.name}</td>
                <td className="px-3 py-2 text-slate-500 dark:text-slate-400">
                  <code className="text-[10px]">{r.signal}</code> {r.operator.replace(/_/g, ' ')} {r.value ?? ''}
                </td>
                <td className={`px-3 py-2 font-mono ${r.points >= 0 ? 'text-orange-600 dark:text-orange-400' : 'text-emerald-600 dark:text-emerald-400'}`}>
                  {r.points >= 0 ? '+' : ''}{r.points}
                </td>
                <td className="px-3 py-2 text-right">
                  <button onClick={() => toggle(r)} className="btn-ghost p-1" aria-label="Toggle">
                    {r.enabled ? <ToggleRight size={14} className="text-emerald-600" /> : <ToggleLeft size={14} className="text-slate-400" />}
                  </button>
                  <button onClick={() => remove(r)} className="btn-ghost p-1 text-red-500" aria-label="Delete"><Trash2 size={11} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {config.risk_rules.length === 0 && (
          <p className="p-4 text-center text-xs text-slate-400">No rules — every change scores zero and lands in the lowest band.</p>
        )}
      </div>
    </div>
  );
}

function FreezesPane({ config, onChanged, setError }) {
  const [adding, setAdding] = useState(false);
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const [form, setForm] = useState({
    name: '', reason: '', start_at: local(new Date()), end_at: local(new Date(Date.now() + 7 * 86400000)),
    scope: 'all', scope_value: '', allow_emergency: true,
  });
  const [busy, setBusy] = useState(false);

  const add = async () => {
    setBusy(true); setError('');
    try {
      await api.post('/change-config/freeze-windows', {
        ...form,
        start_at: new Date(form.start_at).toISOString(), end_at: new Date(form.end_at).toISOString(),
        scope_value: form.scope === 'all' ? null : form.scope_value,
      });
      setAdding(false); onChanged();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const remove = async (w) => {
    if (!window.confirm(`Delete the freeze "${w.name}"?`)) return;
    try { await api.del(`/change-config/freeze-windows/${w.id}`); onChanged(); } catch (e) { setError(e.message); }
  };

  const toggle = async (w) => {
    try { await api.patch(`/change-config/freeze-windows/${w.id}`, { enabled: !w.enabled }); onChanged(); } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          Blackout periods. A change cannot be scheduled inside one — unless its type permits an override, in which case it needs a recorded reason and shows up in the metrics as a freeze violation.
        </p>
        <button onClick={() => setAdding((a) => !a)} className="btn-primary shrink-0 text-xs"><Plus size={13} /> New freeze</button>
      </div>

      {adding && (
        <div className="card space-y-3 p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Name</label>
              <input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Year-end close" />
            </div>
            <div>
              <label className="label">Reason</label>
              <input className="input" value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
            </div>
            <div>
              <label className="label">From</label>
              <input type="datetime-local" className="input" value={form.start_at} onChange={(e) => setForm({ ...form, start_at: e.target.value })} />
            </div>
            <div>
              <label className="label">Until</label>
              <input type="datetime-local" className="input" value={form.end_at} onChange={(e) => setForm({ ...form, end_at: e.target.value })} />
            </div>
            <div>
              <label className="label">Scope</label>
              <Select value={form.scope} onChange={(v) => setForm({ ...form, scope: v })} options={[
                { value: 'all', label: 'Everything' }, { value: 'category', label: 'One category' }, { value: 'asset', label: 'One configuration item' },
              ]} />
            </div>
            {form.scope !== 'all' && (
              <div>
                <label className="label">{form.scope === 'category' ? 'Category name' : 'Asset id'}</label>
                <input className="input" value={form.scope_value} onChange={(e) => setForm({ ...form, scope_value: e.target.value })} />
              </div>
            )}
          </div>
          <Toggle on={form.allow_emergency} onClick={() => setForm({ ...form, allow_emergency: !form.allow_emergency })}
            label="Emergency changes may override this freeze" hint="Turn off for a hard freeze that nothing may pierce" />
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="btn-secondary text-xs">Cancel</button>
            <button onClick={add} disabled={busy || !form.name.trim()} className="btn-primary text-xs">
              {busy ? <Loader2 size={12} className="animate-spin" /> : null} Create freeze
            </button>
          </div>
        </div>
      )}

      {config.freeze_windows.length === 0 ? (
        <EmptyState icon={Snowflake} title="No freeze windows" description="Add one to block changes over a period like year-end or a trading peak." />
      ) : config.freeze_windows.map((w) => (
        <div key={w.id} className={`card flex flex-wrap items-start justify-between gap-2 p-4 ${!w.enabled ? 'opacity-60' : ''}`}>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{w.name}</span>
              <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{w.scope}{w.scope_value ? `: ${w.scope_value}` : ''}</span>
              {w.allow_emergency
                ? <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">emergencies may override</span>
                : <span className="badge bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"><Lock size={9} /> hard freeze</span>}
              {!w.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">disabled</span>}
            </div>
            <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{fmtDateTime(w.start_at)} → {fmtDateTime(w.end_at)}</p>
            {w.reason && <p className="text-[11px] text-slate-400">{w.reason}</p>}
          </div>
          <div className="flex shrink-0 gap-1">
            <button onClick={() => toggle(w)} className="btn-ghost p-1.5" aria-label="Toggle">
              {w.enabled ? <ToggleRight size={16} className="text-emerald-600" /> : <ToggleLeft size={16} className="text-slate-400" />}
            </button>
            <button onClick={() => remove(w)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={13} /></button>
          </div>
        </div>
      ))}
    </div>
  );
}

function RoutesPane({ config, setError }) {
  return (
    <div className="space-y-3">
      <p className="max-w-3xl text-sm text-slate-500 dark:text-slate-400">
        Which approvers a change goes to, matched on its type and risk band — most specific wins. A group step can require a quorum, so a real CAB does not pass because one member clicked approve.
      </p>
      {config.approval_routes.map((r) => (
        <div key={r.id} className={`card p-4 ${!r.enabled ? 'opacity-60' : ''}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{r.name}</span>
            <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
              {r.match_change_type || 'any type'}{r.match_risk_band ? ` · ${r.match_risk_band} risk` : ''}
            </span>
            {!r.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">disabled</span>}
          </div>
          <ol className="mt-2 space-y-1">
            {r.steps.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs dark:border-white/10">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-brand-50 text-[10px] font-bold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                  {s.step_order}
                </span>
                <span className="font-medium text-slate-700 dark:text-slate-200">{s.approver_type.replace(/_/g, ' ')}</span>
                {s.quorum > 1 && <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">quorum {s.quorum}</span>}
                {s.sla_hours && <span className="text-slate-400">SLA {s.sla_hours}h</span>}
              </li>
            ))}
          </ol>
        </div>
      ))}
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Board membership is real group membership — manage who sits on the CAB and ECAB under <strong>Groups</strong>, or from the CAB view in Change Management.
      </p>
    </div>
  );
}

// ---------------------------------------------------------- Field Access ---
// Which fields stay editable at each point in a change's lifecycle.
//
// Rendered as a grid rather than a list of rules because the question an
// admin actually has is comparative -- "what is still open once this is
// approved?" -- and that is a column you read down, not ten rules you piece
// together. Nothing is saved until Save is pressed, so a half-set matrix
// never reaches the server.
const ACCESS_CYCLE = ['editable', 'readonly', 'required'];
const ACCESS_STYLE = {
  editable: 'bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:bg-emerald-500/20',
  readonly: 'bg-slate-200 text-slate-600 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600',
  required: 'bg-amber-50 text-amber-700 hover:bg-amber-100 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20',
};
const ACCESS_SHORT = { editable: 'Edit', readonly: 'Locked', required: 'Required' };

function FieldAccessPane({ setError }) {
  const [data, setData] = useState(null);
  const [policy, setPolicy] = useState({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = async () => {
    try {
      const res = await api.get('/change-config/field-policy');
      setData(res);
      setPolicy(res.policy);
      setDirty(false);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  if (!data) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading field access…</p>;

  const accessOf = (stateKey, fieldKey) => policy[stateKey]?.[fieldKey] || 'editable';

  const cycle = (stateKey, fieldKey) => {
    const next = ACCESS_CYCLE[(ACCESS_CYCLE.indexOf(accessOf(stateKey, fieldKey)) + 1) % ACCESS_CYCLE.length];
    setPolicy((prev) => ({ ...prev, [stateKey]: { ...(prev[stateKey] || {}), [fieldKey]: next } }));
    setDirty(true);
    setSaved(false);
  };

  // Setting a whole column at once: locking everything from "Approved"
  // onwards is the common intent, and clicking fourteen cells to express it
  // is how an admin gives up halfway.
  const setColumn = (stateKey, access) => {
    setPolicy((prev) => ({
      ...prev,
      [stateKey]: Object.fromEntries(data.fields.map((f) => [f.key, access])),
    }));
    setDirty(true);
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const res = await api.put('/change-config/field-policy', { policy });
      setPolicy(res.policy);
      setDirty(false);
      setSaved(true);
    } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  const groups = [...new Set(data.fields.map((f) => f.group))];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Field access by change state</h4>
          <p className="mt-0.5 max-w-3xl text-xs text-slate-500 dark:text-slate-400">
            Click a cell to cycle it. <b>Edit</b> leaves the field open, <b>Locked</b> makes it read-only while the change sits in
            that state, and <b>Required</b> means it must be filled in. Enforced when the ticket is saved as well as in the form,
            so an API client cannot bypass it. Whether a field is <i>visible</i> stays with Business Rules.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {saved && !dirty && <span className="flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400"><Check size={13} /> Saved</span>}
          <button onClick={load} disabled={!dirty || saving} className="btn-secondary text-xs disabled:opacity-40">
            <RotateCcw size={13} /> Discard
          </button>
          <button onClick={save} disabled={!dirty || saving} className="btn-primary text-xs disabled:opacity-40">
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />} Save changes
          </button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-slate-200 dark:border-white/10">
        <table className="w-full min-w-[900px] text-left text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800/60">
            <tr>
              <th className="sticky left-0 z-10 bg-slate-50 px-3 py-2 font-medium text-slate-500 dark:bg-slate-800 dark:text-slate-400">Field</th>
              {data.states.map((st) => (
                <th key={st.key} className="px-2 py-2 text-center font-medium text-slate-600 dark:text-slate-300">
                  <div className="whitespace-nowrap">{st.label}</div>
                  <div className="mt-1 flex justify-center gap-1">
                    <button onClick={() => setColumn(st.key, 'editable')} className="rounded px-1 py-0.5 text-[10px] text-slate-400 hover:bg-emerald-100 hover:text-emerald-700 dark:hover:bg-emerald-500/20" title="Make every field editable in this state">all edit</button>
                    <button onClick={() => setColumn(st.key, 'readonly')} className="rounded px-1 py-0.5 text-[10px] text-slate-400 hover:bg-slate-200 hover:text-slate-700 dark:hover:bg-slate-600" title="Lock every field in this state">all lock</button>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {groups.map((group) => (
              <Fragment key={group}>
                <tr className="bg-slate-50/60 dark:bg-slate-800/30">
                  <td colSpan={data.states.length + 1} className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{group}</td>
                </tr>
                {data.fields.filter((f) => f.group === group).map((field) => (
                  <tr key={field.key}>
                    <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-3 py-1.5 font-medium text-slate-700 dark:bg-slate-900 dark:text-slate-200">{field.label}</td>
                    {data.states.map((st) => {
                      const access = accessOf(st.key, field.key);
                      return (
                        <td key={st.key} className="px-1.5 py-1 text-center">
                          <button
                            onClick={() => cycle(st.key, field.key)}
                            title={`${field.label} in ${st.label}: ${access}. Click to change.`}
                            className={`w-full rounded-md px-1.5 py-1 text-[11px] font-medium transition-colors ${ACCESS_STYLE[access]}`}
                          >
                            {ACCESS_SHORT[access]}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        Status itself is not listed: it is owned by the change state machine, which already decides which moves are legal.
      </p>
    </div>
  );
}

export default function ChangeConfigTab() {
  const [tab, setTab] = useState('types');
  const [config, setConfig] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try { setConfig(await api.get('/change-config')); } catch (e) { setError(e.message); setConfig(null); }
  };
  useEffect(() => { load(); }, []);

  if (error && !config) {
    return (
      <div className="py-10 text-center text-sm">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <button onClick={load} className="btn-secondary mx-auto mt-2 text-xs">Retry</button>
      </div>
    );
  }
  if (!config) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading change configuration…</p>;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
          <GitBranch size={18} className="text-teal-600" /> Change Management
        </h3>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          Everything the change pipeline decides with — types, pre-approved templates, risk scoring, freeze windows and approval routing.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-white/10">
        {SUB_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="btn-ghost p-0.5"><X size={12} /></button>
        </div>
      )}

      {tab === 'types' && <TypesPane config={config} onChanged={load} setError={setError} />}
      {tab === 'templates' && <TemplatesPane config={config} onChanged={load} setError={setError} />}
      {tab === 'risk' && <RiskPane config={config} onChanged={load} setError={setError} />}
      {tab === 'freezes' && <FreezesPane config={config} onChanged={load} setError={setError} />}
      {tab === 'routes' && <RoutesPane config={config} setError={setError} />}
      {tab === 'fieldAccess' && <FieldAccessPane setError={setError} />}
    </div>
  );
}
