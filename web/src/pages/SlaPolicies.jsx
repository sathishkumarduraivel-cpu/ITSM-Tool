import { useEffect, useState } from 'react';
import {
  Plus, Loader2, Timer, Trash2, AlertTriangle, Pencil, X, ArrowUp, ArrowDown,
  ToggleLeft, ToggleRight, Clock, CheckCircle2, ListTree, Info,
} from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Select from '../components/Select.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Same condition vocabulary as Business Rules (server/src/services/
// businessRules.js) -- one condition language app-wide, not an SLA-specific
// one. `groupOptions: true` means "populate this field's value picker from
// the real Groups list" instead of a fixed option set.
const SLA_FIELD_CATALOG = [
  { key: 'type', label: 'Ticket type', options: ['incident', 'request', 'problem', 'change'] },
  { key: 'priority', label: 'Priority', options: ['low', 'medium', 'high', 'critical'] },
  { key: 'category', label: 'Category' },
  { key: 'subcategory', label: 'Subcategory' },
  { key: 'team', label: 'Group', groupOptions: true },
  { key: 'impact', label: 'Impact', options: ['low', 'medium', 'high'] },
  { key: 'risk', label: 'Risk', options: ['low', 'medium', 'high'] },
  { key: 'source', label: 'Source', options: [{ value: 'portal', label: 'Agent/portal-created' }, { value: 'catalog', label: 'Service Catalog' }, { value: 'api', label: 'Public API' }, { value: 'ai-chat', label: 'Self-Service AI Chat' }] },
  { key: 'title', label: 'Title' },
  { key: 'description', label: 'Description' },
];
const OPERATORS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'greater_than', label: 'is greater than' },
  { value: 'less_than', label: 'is less than' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' },
];

function fieldLabel(key) {
  return SLA_FIELD_CATALOG.find((f) => f.key === key)?.label || key;
}
function opLabel(op) {
  return OPERATORS.find((o) => o.value === op)?.label || op;
}
// A human sentence for the list view — e.g. "Priority equals critical AND
// Group equals Network" — so admins can read what a policy targets without
// opening it, the same way Business Rules' own list summarizes its conditions.
function describeConditions(conditions) {
  if (!conditions?.rules?.length) return 'Every ticket (catch-all)';
  const joiner = conditions.logic === 'OR' ? ' OR ' : ' AND ';
  return conditions.rules
    .map((r) => `${fieldLabel(r.field)} ${opLabel(r.operator)}${['is_empty', 'is_not_empty'].includes(r.operator) ? '' : ` "${r.value}"`}`)
    .join(joiner);
}

function ConditionRow({ condition, groups, onChange, onRemove }) {
  const field = SLA_FIELD_CATALOG.find((f) => f.key === condition.field);
  const needsValue = condition.operator !== 'is_empty' && condition.operator !== 'is_not_empty';
  const options = field?.groupOptions ? groups.map((g) => g.name) : field?.options;
  return (
    <div className="flex items-center gap-1.5 flex-wrap bg-slate-50 dark:bg-slate-800/50 rounded-lg px-2 py-1.5">
      <Select
        size="sm" className="w-auto min-w-[130px]" placeholder="Choose a field…" value={condition.field}
        onChange={(v) => onChange({ ...condition, field: v, value: '' })}
        options={SLA_FIELD_CATALOG.map((f) => ({ value: f.key, label: f.label }))}
      />
      <Select size="sm" className="w-auto min-w-[140px]" value={condition.operator} onChange={(v) => onChange({ ...condition, operator: v })} options={OPERATORS} />
      {needsValue && (
        options ? (
          <Select size="sm" className="w-auto min-w-[130px]" placeholder="Choose…" value={condition.value} onChange={(v) => onChange({ ...condition, value: v })} options={options} />
        ) : (
          <input className="input py-1.5 text-xs w-auto flex-1 min-w-[130px]" placeholder="value" value={condition.value} onChange={(e) => onChange({ ...condition, value: e.target.value })} />
        )
      )}
      <button type="button" onClick={onRemove} className="text-slate-400 hover:text-red-500 p-1 ml-auto shrink-0"><X size={13} /></button>
    </div>
  );
}

function PolicyModal({ initial, onClose, onSaved, groups }) {
  const [name, setName] = useState(initial?.name || '');
  const [logic, setLogic] = useState(initial?.conditions?.logic || 'AND');
  const [rules, setRules] = useState(initial?.conditions?.rules || []);
  const [responseMinutes, setResponseMinutes] = useState(initial?.response_minutes ?? 60);
  const [resolutionMinutes, setResolutionMinutes] = useState(initial?.resolution_minutes ?? 1440);
  const [businessHoursOnly, setBusinessHoursOnly] = useState(initial ? !!initial.business_hours_only : false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const setRule = (i, next) => setRules(rules.map((r, idx) => (idx === i ? next : r)));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        name, conditions: { logic, rules },
        response_minutes: Number(responseMinutes) || 0, resolution_minutes: Number(resolutionMinutes) || 0,
        business_hours_only: businessHoursOnly,
      };
      if (initial?.id) await api.patch(`/sla/policies/${initial.id}`, body);
      else await api.post('/sla/policies', body);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit SLA policy' : 'New SLA policy'} onClose={onClose} maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        <div>
          <label className="label">Policy name</label>
          <input className="input" required autoFocus placeholder="e.g. Critical Network incidents" value={name} onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="rounded-xl border border-slate-200 dark:border-slate-700 p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-400 flex items-center gap-1.5">
              <ListTree size={12} /> Applies when
            </div>
          </div>
          {rules.length > 0 && (
            <div className="flex items-center gap-1.5 mb-2 text-xs text-slate-500 dark:text-slate-400">
              Match{' '}
              <Select size="xs" className="w-auto inline-flex" value={logic} onChange={setLogic} options={[{ value: 'AND', label: 'ALL' }, { value: 'OR', label: 'ANY' }]} />
              of the following:
            </div>
          )}
          <div className="space-y-1.5">
            {rules.map((r, i) => (
              <ConditionRow key={i} condition={r} groups={groups} onChange={(next) => setRule(i, next)} onRemove={() => setRules(rules.filter((_, idx) => idx !== i))} />
            ))}
          </div>
          {rules.length === 0 && (
            <p className="text-xs text-slate-400 mb-2">No conditions — this policy matches every ticket. Use this for a catch-all default, placed last in the list.</p>
          )}
          <button
            type="button"
            onClick={() => setRules([...rules, { field: SLA_FIELD_CATALOG[0].key, operator: 'equals', value: '' }])}
            className="text-xs font-medium text-brand-600 dark:text-brand-400 hover:underline flex items-center gap-1 mt-1.5"
          >
            <Plus size={12} /> Add condition
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label flex items-center gap-1"><Timer size={12} /> Response target (minutes)</label>
            <input type="number" min="1" className="input" required value={responseMinutes} onChange={(e) => setResponseMinutes(e.target.value)} />
          </div>
          <div>
            <label className="label flex items-center gap-1"><CheckCircle2 size={12} /> Resolution target (minutes)</label>
            <input type="number" min="1" className="input" required value={resolutionMinutes} onChange={(e) => setResolutionMinutes(e.target.value)} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 cursor-pointer">
          <input type="checkbox" checked={businessHoursOnly} onChange={(e) => setBusinessHoursOnly(e.target.checked)} />
          <Clock size={13} className="text-slate-400" /> Count only business hours toward this SLA
        </label>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Save policy'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PolicyCard({ policy, index, count, onMove, onToggle, onEdit, onRemove }) {
  return (
    <div className={`card p-4 flex items-start gap-3 ${!policy.enabled ? 'opacity-60' : ''}`}>
      <div className="flex flex-col items-center gap-0.5 shrink-0 pt-0.5">
        <span className="w-6 h-6 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 text-[11px] font-mono font-semibold flex items-center justify-center">{index + 1}</span>
        <button onClick={() => onMove(-1)} disabled={index === 0} className="text-slate-300 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-20 disabled:hover:text-slate-300" title="Move up"><ArrowUp size={13} /></button>
        <button onClick={() => onMove(1)} disabled={index === count - 1} className="text-slate-300 hover:text-slate-600 dark:hover:text-slate-300 disabled:opacity-20 disabled:hover:text-slate-300" title="Move down"><ArrowDown size={13} /></button>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-slate-800 dark:text-slate-100">{policy.name}</span>
          {policy.business_hours_only && (
            <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"><Clock size={10} /> Business hours</span>
          )}
        </div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mt-1 font-mono leading-relaxed">
          <span className="text-slate-400 dark:text-slate-500 font-sans">IF</span> {describeConditions(policy.conditions)}
        </p>
        <div className="flex items-center gap-2 mt-2">
          <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400"><Timer size={11} /> Respond in {policy.response_minutes}m</span>
          <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"><CheckCircle2 size={11} /> Resolve in {policy.resolution_minutes}m</span>
        </div>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <button onClick={onToggle} title={policy.enabled ? 'Disable' : 'Enable'} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-300">
          {policy.enabled ? <ToggleRight size={20} className="text-emerald-500" /> : <ToggleLeft size={20} />}
        </button>
        <button onClick={onEdit} className="text-slate-400 hover:text-brand-600"><Pencil size={15} /></button>
        <button onClick={onRemove} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
      </div>
    </div>
  );
}

export default function SlaPolicies() {
  const [policies, setPolicies] = useState([]);
  const [businessHours, setBusinessHours] = useState(
    DAYS.map((_, i) => ({ day_of_week: i, enabled: i >= 1 && i <= 5, start_time: '09:00', end_time: '17:00' }))
  );
  const [atRisk, setAtRisk] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | policy
  const [savingHours, setSavingHours] = useState(false);
  const [groups, setGroups] = useState([]);

  const load = async () => {
    setLoading(true);
    try {
      const [pol, risk, hours, groupsRes] = await Promise.all([
        api.get('/sla/policies'),
        api.get('/sla/at-risk'),
        api.get('/sla/business-hours'),
        api.get('/groups'),
      ]);
      setPolicies(pol.policies);
      setAtRisk(risk.tickets);
      setGroups(groupsRes.groups);
      if (hours.businessHours.length) {
        setBusinessHours(DAYS.map((_, i) => {
          const existing = hours.businessHours.find((h) => h.day_of_week === i);
          return existing ? { ...existing, enabled: true } : { day_of_week: i, enabled: false, start_time: '09:00', end_time: '17:00' };
        }));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!confirm('Delete this policy?')) return;
    await api.del(`/sla/policies/${id}`);
    load();
  };

  const toggle = async (p) => {
    await api.patch(`/sla/policies/${p.id}`, { enabled: !p.enabled });
    load();
  };

  // Swaps this policy's sort_order with its neighbor's -- same two-parallel-
  // PATCH pattern Lifecycle Stages already uses for reordering, so this
  // interaction feels native to the app rather than a one-off.
  const move = async (policy, dir) => {
    const idx = policies.findIndex((p) => p.id === policy.id);
    const swapWith = policies[idx + dir];
    if (!swapWith) return;
    await Promise.all([
      api.patch(`/sla/policies/${policy.id}`, { sort_order: swapWith.sort_order }),
      api.patch(`/sla/policies/${swapWith.id}`, { sort_order: policy.sort_order }),
    ]);
    load();
  };

  const saveBusinessHours = async () => {
    setSavingHours(true);
    try {
      const hours = businessHours.filter((h) => h.enabled).map(({ day_of_week, start_time, end_time }) => ({ day_of_week, start_time, end_time }));
      await api.put('/sla/business-hours', { hours });
    } finally {
      setSavingHours(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="SLA Policies"
        description="Response & resolution targets, condition-based matching, business hours and breach risk"
        actions={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New policy</button>}
      />

      {atRisk.length > 0 && (
        <div className="card p-4 bg-red-50 dark:bg-red-500/10 border-red-100 dark:border-red-900">
          <h3 className="text-sm font-semibold text-red-700 dark:text-red-400 mb-2 flex items-center gap-1.5"><AlertTriangle size={14} /> {atRisk.length} ticket(s) at risk or breached</h3>
          <div className="space-y-1">
            {atRisk.slice(0, 6).map((t) => (
              <div key={t.id} className="text-sm text-red-700 dark:text-red-400 flex items-center justify-between">
                <span>{t.number} — {t.title}</span>
                <span className="text-xs">{new Date(t.sla_due_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <div className="flex items-center gap-1.5 text-xs text-slate-400 dark:text-slate-500 mb-2">
          <Info size={12} className="shrink-0" /> Evaluated top to bottom — the first policy whose conditions match a ticket applies. Reorder with the arrows to change precedence.
        </div>

        {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}

        {!loading && policies.length === 0 && (
          <EmptyState icon={Timer} title="No custom policies yet" description="Without one, a flat built-in default applies to every ticket. Add a policy to target specific ticket types, priorities, groups or anything else." />
        )}

        {!loading && policies.length > 0 && (
          <div className="space-y-2">
            {policies.map((p, i) => (
              <PolicyCard
                key={p.id} policy={p} index={i} count={policies.length}
                onMove={(dir) => move(p, dir)} onToggle={() => toggle(p)} onEdit={() => setModal(p)} onRemove={() => remove(p.id)}
              />
            ))}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Business hours (used when a policy has "business hours only" checked)</h3>
        <div className="space-y-2">
          {businessHours.map((h, i) => (
            <div key={i} className="flex items-center gap-3">
              <label className="flex items-center gap-2 w-24 text-sm text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={h.enabled} onChange={(e) => setBusinessHours(businessHours.map((x, idx) => idx === i ? { ...x, enabled: e.target.checked } : x))} />
                {DAYS[i]}
              </label>
              <input type="time" className="input w-auto" disabled={!h.enabled} value={h.start_time} onChange={(e) => setBusinessHours(businessHours.map((x, idx) => idx === i ? { ...x, start_time: e.target.value } : x))} />
              <span className="text-slate-400 text-sm">to</span>
              <input type="time" className="input w-auto" disabled={!h.enabled} value={h.end_time} onChange={(e) => setBusinessHours(businessHours.map((x, idx) => idx === i ? { ...x, end_time: e.target.value } : x))} />
            </div>
          ))}
        </div>
        <button onClick={saveBusinessHours} disabled={savingHours} className="btn-primary mt-3 text-xs">
          {savingHours ? <Loader2 size={13} className="animate-spin" /> : null} Save business hours
        </button>
      </div>

      {modal && <PolicyModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} groups={groups} />}
    </div>
  );
}
