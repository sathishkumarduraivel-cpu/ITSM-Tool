import { useEffect, useState } from 'react';
import {
  Loader2, Plus, Trash2, AlertTriangle, GripVertical, ShieldCheck, ListChecks,
  Lock, Settings2, ArrowUp, ArrowDown, Eye,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import RequestField, { visibleFields } from './RequestField.jsx';

const TABS = [
  { key: 'details', label: 'Details', icon: Settings2 },
  { key: 'form', label: 'Form', icon: ListChecks },
  { key: 'approval', label: 'Approval', icon: ShieldCheck },
  { key: 'fulfilment', label: 'Fulfilment', icon: ListChecks },
  { key: 'access', label: 'Who can request', icon: Lock },
];

// Building a catalog item.
//
// Split into the five things that are genuinely separate decisions: what it
// is, what to ask, who signs it off, what work it creates, and who may see
// it. Cramming those into one form is why catalog admin screens are usually
// unusable -- they are five jobs wearing one hat.
export default function ItemBuilder({ itemId, meta, categories, onClose, onSaved }) {
  const [tab, setTab] = useState('details');
  const [item, setItem] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    try { setItem((await api.get(`/catalog/items/${itemId}`)).item); } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, [itemId]);

  if (!item) {
    return (
      <Modal title="Catalog item" onClose={onClose}>
        {error
          ? <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
          : <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>}
      </Modal>
    );
  }

  return (
    <Modal title={item.name} onClose={onClose} maxWidth="max-w-4xl">
      <div className="space-y-4">
        <div className="flex flex-wrap gap-1 border-b border-slate-200 pb-2 dark:border-white/10">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  tab === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
                }`}>
                <Icon size={12} /> {t.label}
              </button>
            );
          })}
        </div>

        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={13} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        {tab === 'details' && <DetailsTab item={item} meta={meta} categories={categories} onSaved={() => { load(); onSaved?.(); }} setError={setError} />}
        {tab === 'form' && <FormTab item={item} meta={meta} onSaved={() => { load(); onSaved?.(); }} setError={setError} />}
        {tab === 'approval' && <ApprovalTab item={item} meta={meta} onChanged={load} setError={setError} />}
        {tab === 'fulfilment' && <FulfilmentTab item={item} meta={meta} onChanged={load} setError={setError} />}
        {tab === 'access' && <AccessTab item={item} onChanged={load} setError={setError} />}
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------- details

function DetailsTab({ item, meta, categories, onSaved, setError }) {
  const [form, setForm] = useState({
    name: item.name || '', short_description: item.short_description || '', description: item.description || '',
    category_id: item.category_id || '', status: item.status || 'draft',
    default_priority: item.default_priority || 'medium',
    cost: item.cost ?? '', currency: item.currency || 'USD', cost_centre: item.cost_centre || '',
    delivery_days: item.delivery_days ?? '', max_quantity: item.max_quantity ?? '',
    allow_on_behalf: !!item.allow_on_behalf, tags: item.tags || '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true); setError('');
    try { await api.patch(`/catalog/items/${item.id}`, form); onSaved(); } catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  const status = meta?.item_statuses?.find((s) => s.key === form.status);

  return (
    <div className="space-y-3">
      <div>
        <label className="label">Name<span className="text-red-500">*</span></label>
        <input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} />
      </div>
      <div>
        <label className="label">One-line summary</label>
        <input className="input" placeholder="What the requester sees on the card" value={form.short_description} onChange={(e) => set('short_description', e.target.value)} />
      </div>
      <div>
        <label className="label">Description</label>
        <textarea className="input" rows={3} value={form.description} onChange={(e) => set('description', e.target.value)} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <label className="label">Status</label>
          <Select value={form.status} onChange={(v) => set('status', v)}
            options={(meta?.item_statuses || []).map((s) => ({ value: s.key, label: s.label }))} />
          {status && <p className="mt-1 text-[11px] text-slate-400">{status.description}</p>}
        </div>
        <div>
          <label className="label">Category</label>
          <Select value={form.category_id} onChange={(v) => set('category_id', v)} placeholder="Unfiled"
            options={[{ value: '', label: 'Unfiled' }, ...(categories || []).map((c) => ({ value: c.id, label: c.name }))]} />
        </div>
        <div>
          <label className="label">Priority</label>
          <Select value={form.default_priority} onChange={(v) => set('default_priority', v)}
            options={['low', 'medium', 'high', 'critical'].map((p) => ({ value: p, label: p }))} />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <label className="label">Cost</label>
          <input className="input" type="number" value={form.cost} onChange={(e) => set('cost', e.target.value)} />
        </div>
        <div>
          <label className="label">Currency</label>
          <input className="input" value={form.currency} onChange={(e) => set('currency', e.target.value)} />
        </div>
        <div>
          <label className="label">Cost centre</label>
          <input className="input" value={form.cost_centre} onChange={(e) => set('cost_centre', e.target.value)} />
        </div>
        <div>
          <label className="label">Deliver within (days)</label>
          <input className="input" type="number" value={form.delivery_days} onChange={(e) => set('delivery_days', e.target.value)} />
          <p className="mt-1 text-[11px] text-slate-400">The promise you are measured against.</p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="label">Maximum quantity</label>
          <input className="input" type="number" min="1" value={form.max_quantity} onChange={(e) => set('max_quantity', e.target.value)} />
        </div>
        <div>
          <label className="label">Tags</label>
          <input className="input" placeholder="laptop, hardware" value={form.tags} onChange={(e) => set('tags', e.target.value)} />
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <input type="checkbox" checked={form.allow_on_behalf} onChange={(e) => set('allow_on_behalf', e.target.checked)} />
        Can be requested on somebody else&rsquo;s behalf
      </label>

      <div className="flex justify-end">
        <button onClick={save} disabled={saving} className="btn-primary text-xs">
          {saving && <Loader2 size={12} className="animate-spin" />} Save
        </button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- form

function FormTab({ item, meta, onSaved, setError }) {
  const [fields, setFields] = useState(item.form_schema || []);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [previewValues, setPreviewValues] = useState({});

  const update = (i, patch) => setFields((f) => f.map((x, n) => (n === i ? { ...x, ...patch } : x)));
  const move = (i, delta) => setFields((f) => {
    const next = [...f];
    const j = i + delta;
    if (j < 0 || j >= next.length) return f;
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });

  const save = async () => {
    setSaving(true); setError('');
    try { await api.patch(`/catalog/items/${item.id}`, { form_schema: fields }); onSaved(); }
    catch (e) { setError(e.message); } finally { setSaving(false); }
  };

  const typeNeedsOptions = (t) => ['select', 'multiselect'].includes(t);

  if (preview) {
    const shown = visibleFields(fields, previewValues);
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Exactly what a requester sees. Answer a question to check the conditional fields behave.
          </p>
          <button onClick={() => setPreview(false)} className="btn-secondary text-xs">Back to editing</button>
        </div>
        {shown.map((f) => (
          <RequestField key={f.key} field={f} value={previewValues[f.key]}
            onChange={(k, v) => setPreviewValues((p) => ({ ...p, [k]: v }))} />
        ))}
        {!shown.length && <p className="text-xs text-slate-400">No fields yet.</p>}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="max-w-lg text-xs text-slate-500 dark:text-slate-400">
          Every answer is validated on the server, so a required field really is required and a choice really is one of the options.
        </p>
        <button onClick={() => setPreview(true)} className="btn-secondary text-xs"><Eye size={12} /> Preview</button>
      </div>

      <div className="space-y-2">
        {fields.map((f, i) => (
          <div key={i} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <div className="mb-2 flex items-center gap-2">
              <GripVertical size={13} className="text-slate-300" />
              <span className="flex-1 text-xs font-semibold text-slate-600 dark:text-slate-300">Field {i + 1}</span>
              <button onClick={() => move(i, -1)} disabled={i === 0} className="btn-ghost p-1 disabled:opacity-30"><ArrowUp size={12} /></button>
              <button onClick={() => move(i, 1)} disabled={i === fields.length - 1} className="btn-ghost p-1 disabled:opacity-30"><ArrowDown size={12} /></button>
              <button onClick={() => setFields((x) => x.filter((_, n) => n !== i))} className="btn-ghost p-1 text-slate-400 hover:text-red-500"><Trash2 size={12} /></button>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <div>
                <label className="label">Label</label>
                <input className="input" value={f.label || ''} onChange={(e) => update(i, { label: e.target.value })} />
              </div>
              <div>
                <label className="label">Key</label>
                <input className="input font-mono text-xs" value={f.key || ''} onChange={(e) => update(i, { key: e.target.value })} />
              </div>
              <div>
                <label className="label">Type</label>
                <Select value={f.type || 'text'} onChange={(v) => update(i, { type: v })}
                  options={(meta?.field_types || []).map((t) => ({ value: t.key, label: t.label }))} />
              </div>
            </div>

            {typeNeedsOptions(f.type) && (
              <div className="mt-2">
                <label className="label">Options</label>
                <textarea className="input font-mono text-xs" rows={3} placeholder="One per line"
                  value={(f.options || []).join('\n')}
                  onChange={(e) => update(i, { options: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
              </div>
            )}

            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                <input type="checkbox" checked={!!f.required} onChange={(e) => update(i, { required: e.target.checked })} /> Required
              </label>
              <div className="min-w-[160px] flex-1">
                <label className="label">Help text</label>
                <input className="input" value={f.help_text || ''} onChange={(e) => update(i, { help_text: e.target.value })} />
              </div>
            </div>

            {/* Conditional visibility: the thing that keeps a form short. */}
            <div className="mt-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60">
              <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Only show this when…</div>
              <div className="flex flex-wrap gap-2">
                <Select className="min-w-[130px] flex-1" size="sm"
                  value={f.show_when?.field || ''}
                  onChange={(v) => update(i, { show_when: v ? { ...(f.show_when || {}), field: v, op: f.show_when?.op || 'equals' } : undefined })}
                  placeholder="Always shown"
                  options={[{ value: '', label: 'Always shown' },
                    ...fields.filter((o, n) => n !== i && o.key).map((o) => ({ value: o.key, label: o.label || o.key }))]} />
                {f.show_when?.field && (
                  <>
                    <Select className="w-auto min-w-[110px]" size="sm"
                      value={f.show_when?.op || 'equals'}
                      onChange={(v) => update(i, { show_when: { ...f.show_when, op: v } })}
                      options={(meta?.condition_ops || []).map((o) => ({ value: o.key, label: o.label }))} />
                    {!['is_empty', 'is_not_empty'].includes(f.show_when?.op) && (
                      <input className="input w-auto flex-1 text-xs" placeholder="value"
                        value={f.show_when?.value ?? ''}
                        onChange={(e) => update(i, { show_when: { ...f.show_when, value: e.target.value } })} />
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-between">
        <button onClick={() => setFields((f) => [...f, { key: `field_${f.length + 1}`, label: '', type: 'text' }])}
          className="btn-secondary text-xs"><Plus size={12} /> Add field</button>
        <button onClick={save} disabled={saving} className="btn-primary text-xs">
          {saving && <Loader2 size={12} className="animate-spin" />} Save form
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- approval

function ApprovalTab({ item, meta, onChanged, setError }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', approver_type: 'role', approver_role: 'admin' });
  const [groups, setGroups] = useState([]);
  const stages = item.approval_stages || [];

  useEffect(() => { api.get('/groups').then((d) => setGroups(d.groups || [])).catch(() => {}); }, []);

  const add = async () => {
    setError('');
    try { await api.post(`/catalog/items/${item.id}/approval-stages`, form); setAdding(false); setForm({ name: '', approver_type: 'role', approver_role: 'admin' }); onChanged(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
        Stages run in order. A stage with a condition only applies when it holds &mdash; use <code className="font-mono">_cost</code> to
        gate on what the request is worth, or a form field key to gate on an answer. With no stages, the item&rsquo;s own approver setting applies.
      </p>

      {stages.length === 0 && <p className="text-xs text-slate-400">No stages configured.</p>}
      <div className="space-y-1">
        {stages.map((s) => (
          <div key={s.id} className={`flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-2.5 py-2 text-xs dark:bg-slate-800/60 ${s.enabled ? '' : 'opacity-50'}`}>
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold dark:bg-slate-700">{s.step_order}</span>
            <span className="flex-1 text-slate-700 dark:text-slate-200">{s.name}</span>
            <span className="text-slate-400">
              {s.approver_name || s.approver_group_name || s.approver_role || s.approver_type}
            </span>
            {s.condition_field && (
              <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                when {s.condition_field} {s.condition_op} {s.condition_value}
              </span>
            )}
            <button onClick={async () => { await api.del(`/catalog/approval-stages/${s.id}`); onChanged(); }}
              className="text-slate-400 hover:text-red-500"><Trash2 size={12} /></button>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-white/10">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="label">Stage name</label>
              <input className="input" placeholder="Line manager" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label className="label">Who approves</label>
              <Select value={form.approver_type} onChange={(v) => setForm({ ...form, approver_type: v })}
                options={(meta?.approver_types || []).map((t) => ({ value: t.key, label: t.label }))} />
            </div>
          </div>
          {form.approver_type === 'group_manager' && (
            <div>
              <label className="label">Team</label>
              <Select value={form.approver_group_id || ''} onChange={(v) => setForm({ ...form, approver_group_id: v })}
                placeholder="Choose a team" options={groups.map((g) => ({ value: g.id, label: g.name }))} />
            </div>
          )}
          <div>
            <label className="label">Only when (optional)</label>
            <div className="flex flex-wrap gap-2">
              <input className="input w-auto flex-1 font-mono text-xs" placeholder="_cost or a field key"
                value={form.condition_field || ''} onChange={(e) => setForm({ ...form, condition_field: e.target.value })} />
              <Select className="w-auto min-w-[110px]" value={form.condition_op || 'gt'}
                onChange={(v) => setForm({ ...form, condition_op: v })}
                options={(meta?.condition_ops || []).map((o) => ({ value: o.key, label: o.label }))} />
              <input className="input w-auto flex-1" placeholder="value"
                value={form.condition_value || ''} onChange={(e) => setForm({ ...form, condition_value: e.target.value })} />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="btn-secondary text-xs">Cancel</button>
            <button onClick={add} disabled={!form.name} className="btn-primary text-xs disabled:opacity-40">Add stage</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="btn-secondary text-xs"><Plus size={12} /> Add a stage</button>
      )}
    </div>
  );
}

// ------------------------------------------------------------- fulfilment

function FulfilmentTab({ item, meta, onChanged, setError }) {
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ title: '', assignee_type: 'group', sequential: true });
  const [groups, setGroups] = useState([]);
  const tasks = item.fulfilment_tasks || [];

  useEffect(() => { api.get('/groups').then((d) => setGroups(d.groups || [])).catch(() => {}); }, []);

  const add = async () => {
    setError('');
    try { await api.post(`/catalog/items/${item.id}/fulfilment-tasks`, form); setAdding(false); setForm({ title: '', assignee_type: 'group', sequential: true }); onChanged(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
        The work this request creates. Tasks appear on the ticket once every approval has cleared &mdash; or straight away if none is needed.
        A sequential task waits for the one before it.
      </p>

      {tasks.length === 0 && <p className="text-xs text-slate-400">No tasks configured, so the request arrives as a ticket with nothing on it.</p>}
      <div className="space-y-1">
        {tasks.map((t, i) => (
          <div key={t.id} className="flex flex-wrap items-center gap-2 rounded-md bg-slate-50 px-2.5 py-2 text-xs dark:bg-slate-800/60">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-slate-200 text-[10px] font-semibold dark:bg-slate-700">{i + 1}</span>
            <span className="flex-1 text-slate-700 dark:text-slate-200">{t.title}</span>
            <span className="text-slate-400">{t.assignee_name || t.assignee_group_name || t.assignee_type}</span>
            {t.due_offset_days != null && <span className="text-slate-400">+{t.due_offset_days}d</span>}
            {!t.sequential && <span className="badge bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">parallel</span>}
            <button onClick={async () => { await api.del(`/catalog/fulfilment-tasks/${t.id}`); onChanged(); }}
              className="text-slate-400 hover:text-red-500"><Trash2 size={12} /></button>
          </div>
        ))}
      </div>

      {adding ? (
        <div className="space-y-2 rounded-xl border border-slate-200 p-3 dark:border-white/10">
          <div>
            <label className="label">Task</label>
            <input className="input" placeholder="Create the AD account" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <label className="label">Assign to</label>
              <Select value={form.assignee_type} onChange={(v) => setForm({ ...form, assignee_type: v })}
                options={(meta?.assignee_types || []).map((t) => ({ value: t.key, label: t.label }))} />
            </div>
            {form.assignee_type === 'group' && (
              <div>
                <label className="label">Team</label>
                <Select value={form.assignee_group_id || ''} onChange={(v) => setForm({ ...form, assignee_group_id: v })}
                  placeholder="Choose" options={groups.map((g) => ({ value: g.id, label: g.name }))} />
              </div>
            )}
            <div>
              <label className="label">Due after (days)</label>
              <input className="input" type="number" value={form.due_offset_days ?? ''} onChange={(e) => setForm({ ...form, due_offset_days: e.target.value })} />
            </div>
          </div>
          <label className="flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={form.sequential} onChange={(e) => setForm({ ...form, sequential: e.target.checked })} />
            Waits for the previous task
          </label>
          <div className="flex justify-end gap-2">
            <button onClick={() => setAdding(false)} className="btn-secondary text-xs">Cancel</button>
            <button onClick={add} disabled={!form.title} className="btn-primary text-xs disabled:opacity-40">Add task</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="btn-secondary text-xs"><Plus size={12} /> Add a task</button>
      )}
    </div>
  );
}

// ----------------------------------------------------------------- access

function AccessTab({ item, onChanged, setError }) {
  const [groups, setGroups] = useState([]);
  const [type, setType] = useState('group');
  const [value, setValue] = useState('');
  const rules = item.entitlements || [];

  useEffect(() => { api.get('/groups').then((d) => setGroups(d.groups || [])).catch(() => {}); }, []);

  const add = async () => {
    setError('');
    try { await api.post(`/catalog/items/${item.id}/entitlements`, { rule_type: type, rule_value: value }); setValue(''); onChanged(); }
    catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
        With no rules, everyone can see and request this. Add one and it becomes visible only to people who match &mdash; rules are
        OR-ed, so matching any one is enough. Whoever manages the catalog always sees everything.
      </p>

      {rules.length === 0 ? (
        <div className="rounded-xl bg-emerald-50 px-3 py-2 text-xs text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
          Open to everyone in the workspace.
        </div>
      ) : (
        <div className="space-y-1">
          {rules.map((r) => (
            <div key={r.id} className="flex items-center justify-between rounded-md bg-slate-50 px-2.5 py-1.5 text-xs dark:bg-slate-800/60">
              <span className="text-slate-700 dark:text-slate-200">
                {r.rule_type === 'group' ? `Team: ${r.group_name || r.rule_value}`
                  : r.rule_type === 'role' ? `Role: ${r.rule_value}`
                    : `Department: ${r.rule_value}`}
              </span>
              <button onClick={async () => { await api.del(`/catalog/entitlements/${r.id}`); onChanged(); }}
                className="text-slate-400 hover:text-red-500"><Trash2 size={12} /></button>
            </div>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-3 dark:border-slate-800">
        <Select className="w-auto min-w-[130px]" value={type} onChange={(v) => { setType(v); setValue(''); }}
          options={[{ value: 'group', label: 'Team' }, { value: 'role', label: 'Role' }, { value: 'department', label: 'Department' }]} />
        {type === 'group' ? (
          <Select className="min-w-[160px] flex-1" value={value} onChange={setValue} placeholder="Choose a team"
            options={groups.map((g) => ({ value: g.id, label: g.name }))} />
        ) : type === 'role' ? (
          <Select className="min-w-[160px] flex-1" value={value} onChange={setValue} placeholder="Choose a role"
            options={['admin', 'agent', 'requester'].map((r) => ({ value: r, label: r }))} />
        ) : (
          <input className="input min-w-[160px] flex-1" placeholder="Department name" value={value} onChange={(e) => setValue(e.target.value)} />
        )}
        <button onClick={add} disabled={!value} className="btn-primary shrink-0 text-xs disabled:opacity-40"><Plus size={12} /> Add rule</button>
      </div>
    </div>
  );
}
