import { useEffect, useState } from 'react';
import {
  Loader2, Plus, Trash2, Pencil, Boxes, Network, Fingerprint, Radar, AlertTriangle,
  X, Copy, KeyRound, RefreshCw, ChevronRight, ChevronDown, Lock,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import { fmtDateTime } from '../../lib/dates.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import EmptyState from '../EmptyState.jsx';

const SUB_TABS = [
  { key: 'classes', label: 'CI Classes', icon: Boxes },
  { key: 'relationships', label: 'Relationship Types', icon: Network },
  { key: 'identity', label: 'Identification', icon: Fingerprint },
  { key: 'discovery', label: 'Discovery Sources', icon: Radar },
];

// The CMDB model, as configuration.
//
// Everything here shapes what a CI is allowed to be: the class tree and its
// typed fields, how CIs relate, how an incoming record is recognised as one
// we already have, and which tools are allowed to write. Getting identification
// right matters more than any of the rest -- it is the difference between a
// CMDB and a pile of duplicates.
export default function CmdbConfigTab() {
  const [tab, setTab] = useState('classes');
  const [error, setError] = useState('');

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
          <Boxes size={18} className="text-sky-600" /> CMDB Configuration
        </h3>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          What a configuration item can be, how CIs relate, how they are recognised, and which tools may write to them.
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

      {tab === 'classes' && <ClassesPane setError={setError} />}
      {tab === 'relationships' && <RelationshipTypesPane setError={setError} />}
      {tab === 'identity' && <IdentificationPane setError={setError} />}
      {tab === 'discovery' && <DiscoveryPane setError={setError} />}
    </div>
  );
}

// ------------------------------------------------------------- classes ----

function ClassesPane({ setError }) {
  const [data, setData] = useState(null);
  const [selected, setSelected] = useState(null);
  const [detail, setDetail] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [classModal, setClassModal] = useState(undefined);
  const [attrModal, setAttrModal] = useState(undefined);

  const load = async () => {
    try {
      const d = await api.get('/cmdb-config/classes?all=1');
      setData(d);
      if (!selected && d.classes.length) setSelected(d.classes.find((c) => !c.is_abstract)?.id || d.classes[0].id);
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (!selected) return;
    setDetail(null);
    api.get(`/cmdb-config/classes/${selected}`).then(setDetail).catch((e) => setError(e.message));
  }, [selected]);

  if (!data) return <Loading />;

  const toggle = (id) => setExpanded((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const renderNode = (node, depth = 0) => (
    <div key={node.id}>
      <div
        className={`flex items-center gap-1 rounded-lg px-1.5 py-1 text-sm transition-colors ${
          selected === node.id ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
        }`}
        style={{ paddingLeft: `${depth * 14 + 6}px` }}
      >
        {node.children?.length ? (
          <button onClick={() => toggle(node.id)} className="shrink-0 text-slate-400">
            {expanded.has(node.id) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
        ) : <span className="w-3 shrink-0" />}
        <button onClick={() => setSelected(node.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: node.color || '#94a3b8' }} />
          <span className={`truncate ${node.is_abstract ? 'italic text-slate-500 dark:text-slate-400' : 'text-slate-700 dark:text-slate-200'}`}>
            {node.label}
          </span>
          {!node.enabled && <span className="text-[10px] text-slate-400">disabled</span>}
        </button>
      </div>
      {expanded.has(node.id) && node.children?.map((c) => renderNode(c, depth + 1))}
    </div>
  );

  // Everything expanded on first load: a collapsed tree hides the model from
  // the person who came here to understand it.
  if (!expanded.size && data.tree.length) {
    const all = new Set();
    const walk = (n) => { all.add(n.id); n.children?.forEach(walk); };
    data.tree.forEach(walk);
    setExpanded(all);
  }

  const counts = new Map(data.classes.map((c) => [c.id, c.ci_count]));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
      <div className="card p-2">
        <div className="mb-2 flex items-center justify-between px-1.5">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Class tree</span>
          <button onClick={() => setClassModal(null)} className="btn-ghost p-1" title="New class"><Plus size={13} /></button>
        </div>
        <div className="max-h-[520px] overflow-y-auto">{data.tree.map((n) => renderNode(n))}</div>
        <p className="mt-2 px-1.5 text-[10px] text-slate-400">Italic classes are groupings — they hold shared fields but no CIs.</p>
      </div>

      <div>
        {!detail ? <Loading /> : (
          <div className="space-y-4">
            <div className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h4 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
                    {detail.ci_class.label}
                    {!!detail.ci_class.system && <Lock size={12} className="text-slate-400" title="Built in — the key is fixed and it cannot be deleted" />}
                  </h4>
                  <p className="mt-0.5 max-w-xl text-xs text-slate-500 dark:text-slate-400">{detail.ci_class.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{detail.ci_class.key}</span>
                    <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{counts.get(detail.ci_class.id) || 0} CIs</span>
                    {!!detail.ci_class.is_asset && <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">asset</span>}
                    {!!detail.ci_class.is_abstract && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">grouping</span>}
                  </div>
                  {detail.ancestry.length > 1 && (
                    <p className="mt-1.5 text-[11px] text-slate-400">{detail.ancestry.map((c) => c.label).join(' › ')}</p>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <button onClick={() => setClassModal(detail.ci_class)} className="btn-secondary text-xs"><Pencil size={12} /> Edit</button>
                  <button
                    onClick={async () => {
                      if (!confirm(`Delete the ${detail.ci_class.label} class?`)) return;
                      try { await api.del(`/cmdb-config/classes/${detail.ci_class.id}`); setSelected(null); load(); }
                      catch (e) { setError(e.message); }
                    }}
                    disabled={!!detail.ci_class.system}
                    className="btn-secondary text-xs disabled:opacity-40"
                    title={detail.ci_class.system ? 'Built-in classes cannot be deleted' : 'Delete'}
                  ><Trash2 size={12} /></button>
                </div>
              </div>
            </div>

            <div className="card p-4">
              <div className="mb-3 flex items-center justify-between">
                <h5 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Fields</h5>
                <button onClick={() => setAttrModal(null)} className="btn-secondary text-xs"><Plus size={12} /> Add field</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-slate-400">
                    <tr>
                      <th className="py-1.5 font-medium">Field</th>
                      <th className="py-1.5 font-medium">Type</th>
                      <th className="py-1.5 font-medium">Declared on</th>
                      <th className="py-1.5 font-medium">Flags</th>
                      <th className="w-16 py-1.5" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                    {detail.attributes.map((a) => (
                      <tr key={a.id} className={a.enabled ? '' : 'opacity-50'}>
                        <td className="py-1.5">
                          <div className="font-medium text-slate-700 dark:text-slate-200">{a.label}</div>
                          <div className="font-mono text-[10px] text-slate-400">{a.attr_key}</div>
                        </td>
                        <td className="py-1.5 text-slate-500 dark:text-slate-400">{a.data_type}</td>
                        <td className="py-1.5 text-slate-500 dark:text-slate-400">
                          {a.inherited
                            ? <span className="text-slate-400">{a.owner_class_label}</span>
                            : <span className="text-slate-700 dark:text-slate-200">this class</span>}
                        </td>
                        <td className="py-1.5">
                          <div className="flex flex-wrap gap-1">
                            {!!a.required && <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300">required</span>}
                            {!!a.is_identifier && <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">identifier</span>}
                            {!!a.system && <Lock size={10} className="text-slate-400" />}
                          </div>
                        </td>
                        <td className="py-1.5">
                          <div className="flex justify-end gap-1">
                            {/* An inherited field is edited where it lives,
                                otherwise the same edit would appear to work
                                from twenty different screens. */}
                            {a.inherited ? (
                              <button onClick={() => setSelected(detail.ancestry.find((c) => c.label === a.owner_class_label)?.id || selected)}
                                className="rounded p-1 text-slate-400 hover:text-brand-600" title={`Edit on ${a.owner_class_label}`}>
                                <ChevronRight size={12} />
                              </button>
                            ) : (
                              <>
                                <button onClick={() => setAttrModal(a)} className="rounded p-1 text-slate-400 hover:text-brand-600"><Pencil size={12} /></button>
                                <button
                                  onClick={async () => {
                                    if (!confirm(`Delete the ${a.label} field? Values stored against it go too.`)) return;
                                    try { await api.del(`/cmdb-config/attributes/${a.id}`); setSelected(selected); api.get(`/cmdb-config/classes/${selected}`).then(setDetail); }
                                    catch (e) { setError(e.message); }
                                  }}
                                  disabled={!!a.system}
                                  className="rounded p-1 text-slate-400 hover:text-red-500 disabled:opacity-30"
                                ><Trash2 size={12} /></button>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {classModal !== undefined && (
        <ClassModal
          initial={classModal}
          classes={data.classes}
          onClose={() => setClassModal(undefined)}
          onSaved={() => { setClassModal(undefined); load(); if (selected) api.get(`/cmdb-config/classes/${selected}`).then(setDetail); }}
        />
      )}
      {attrModal !== undefined && detail && (
        <AttributeModal
          initial={attrModal}
          classId={detail.ci_class.id}
          classes={data.classes}
          onClose={() => setAttrModal(undefined)}
          onSaved={() => { setAttrModal(undefined); api.get(`/cmdb-config/classes/${selected}`).then(setDetail); }}
        />
      )}
    </div>
  );
}

function ClassModal({ initial, classes, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [form, setForm] = useState({
    key: initial?.key || '', label: initial?.label || '', description: initial?.description || '',
    parent_class_id: initial?.parent_class_id || '', color: initial?.color || '#64748b',
    is_asset: initial ? !!initial.is_asset : true, is_abstract: initial ? !!initial.is_abstract : false,
    enabled: initial ? !!initial.enabled : true,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      if (editing) await api.patch(`/cmdb-config/classes/${initial.id}`, form);
      else await api.post('/cmdb-config/classes', form);
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title={editing ? `Edit ${initial.label}` : 'New CI class'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Label<span className="text-red-500">*</span></label>
            <input className="input" required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </div>
          <div>
            <label className="label">Key<span className="text-red-500">*</span></label>
            <input
              className="input" required disabled={editing && !!initial.system}
              value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })}
            />
            <p className="mt-1 text-[10px] text-slate-400">
              {editing && initial.system ? 'Built-in keys are fixed — CIs reference them.' : 'Lowercase, no spaces. Stored CIs reference this, so it cannot change later.'}
            </p>
          </div>
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Inherits from</label>
            <Select
              value={form.parent_class_id} onChange={(v) => setForm({ ...form, parent_class_id: v })}
              placeholder="No parent"
              options={[{ value: '', label: 'No parent' }, ...classes.filter((c) => c.id !== initial?.id).map((c) => ({ value: c.id, label: c.label }))]}
            />
            <p className="mt-1 text-[10px] text-slate-400">Every field on the parent applies here too.</p>
          </div>
          <div>
            <label className="label">Colour</label>
            <input className="input h-[38px] p-1" type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} />
          </div>
        </div>
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={form.is_asset} onChange={(e) => setForm({ ...form, is_asset: e.target.checked })} />
            This is an asset — ownership, warranty and financial fields apply
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={form.is_abstract} onChange={(e) => setForm({ ...form, is_abstract: e.target.checked })} />
            Grouping only — holds shared fields, but no CI can be created on it
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
            Available when creating CIs
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>
      </form>
    </Modal>
  );
}

function AttributeModal({ initial, classId, classes, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [types, setTypes] = useState([]);
  const [form, setForm] = useState({
    attr_key: initial?.attr_key || '', label: initial?.label || '', data_type: initial?.data_type || 'text',
    options: initial?.options || [], reference_class_id: initial?.reference_class_id || '',
    unit: initial?.unit || '', required: initial ? !!initial.required : false,
    is_identifier: initial ? !!initial.is_identifier : false, default_value: initial?.default_value || '',
    min_value: initial?.min_value ?? '', max_value: initial?.max_value ?? '',
    help_text: initial?.help_text || '', enabled: initial ? !!initial.enabled : true,
  });
  const [optionText, setOptionText] = useState((initial?.options || []).join('\n'));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.get('/cmdb-config/meta').then((m) => setTypes(m.data_types || [])).catch(() => {}); }, []);

  const needsOptions = ['select', 'multiselect'].includes(form.data_type);
  const needsReference = form.data_type === 'reference';

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const body = {
        ...form,
        options: needsOptions ? optionText.split('\n').map((s) => s.trim()).filter(Boolean) : undefined,
        reference_class_id: needsReference ? form.reference_class_id : null,
        min_value: form.min_value === '' ? null : Number(form.min_value),
        max_value: form.max_value === '' ? null : Number(form.max_value),
      };
      if (editing) await api.patch(`/cmdb-config/attributes/${initial.id}`, body);
      else await api.post(`/cmdb-config/classes/${classId}/attributes`, body);
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title={editing ? `Edit ${initial.label}` : 'New field'} onClose={onClose} maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Label<span className="text-red-500">*</span></label>
            <input className="input" required value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} />
          </div>
          <div>
            <label className="label">Key<span className="text-red-500">*</span></label>
            <input className="input" required disabled={editing && !!initial.system} value={form.attr_key} onChange={(e) => setForm({ ...form, attr_key: e.target.value })} />
          </div>
          <div>
            <label className="label">Type<span className="text-red-500">*</span></label>
            <Select
              value={form.data_type} onChange={(v) => setForm({ ...form, data_type: v })}
              options={types.map((t) => ({ value: t.key, label: t.label }))}
            />
          </div>
          <div>
            <label className="label">Unit</label>
            <input className="input" placeholder="GB, %, hours" value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })} />
          </div>
        </div>

        {needsOptions && (
          <div>
            <label className="label">Options<span className="text-red-500">*</span></label>
            <textarea className="input font-mono text-xs" rows={4} placeholder="One per line" value={optionText} onChange={(e) => setOptionText(e.target.value)} />
            <p className="mt-1 text-[10px] text-slate-400">Removing an option that CIs already use will be refused, and you will be told which.</p>
          </div>
        )}

        {needsReference && (
          <div>
            <label className="label">Points at<span className="text-red-500">*</span></label>
            <Select
              value={form.reference_class_id} onChange={(v) => setForm({ ...form, reference_class_id: v })}
              placeholder="Choose a class…"
              options={classes.map((c) => ({ value: c.id, label: c.label }))}
            />
            <p className="mt-1 text-[10px] text-slate-400">That class and anything under it will be accepted.</p>
          </div>
        )}

        {['number', 'integer'].includes(form.data_type) && (
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Minimum</label><input className="input" type="number" value={form.min_value} onChange={(e) => setForm({ ...form, min_value: e.target.value })} /></div>
            <div><label className="label">Maximum</label><input className="input" type="number" value={form.max_value} onChange={(e) => setForm({ ...form, max_value: e.target.value })} /></div>
          </div>
        )}

        <div><label className="label">Help text</label>
          <input className="input" value={form.help_text} onChange={(e) => setForm({ ...form, help_text: e.target.value })} /></div>

        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={form.required} onChange={(e) => setForm({ ...form, required: e.target.checked })} /> Required
          </label>
          <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" className="mt-1" checked={form.is_identifier} onChange={(e) => setForm({ ...form, is_identifier: e.target.checked })} />
            <span>
              Identifier
              <span className="block text-[11px] text-slate-400">
                Used to recognise this CI when discovery or an import sends it again. An identification rule is created for it automatically.
              </span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Shown on forms
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>
      </form>
    </Modal>
  );
}

// -------------------------------------------------- relationship types ----

function RelationshipTypesPane({ setError }) {
  const [types, setTypes] = useState(null);
  const [modal, setModal] = useState(undefined);

  const load = () => api.get('/cmdb/relationship-types?all=1').then((d) => setTypes(d.relationship_types || [])).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (!types) return <Loading />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
          Each type reads both ways from a single stored link, and says whether failure travels along it. A peer link like
          <em> connected to</em> is a fact worth recording, not a path an outage follows — which is why impact analysis can
          be told to ignore it.
        </p>
        <button onClick={() => setModal(null)} className="btn-primary text-xs"><Plus size={13} /> New type</button>
      </div>

      <div className="card divide-y divide-slate-100 dark:divide-slate-800">
        {types.map((t) => (
          <div key={t.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${t.enabled ? '' : 'opacity-50'}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: t.color || '#94a3b8' }} />
            <div className="min-w-[200px] flex-1">
              <div className="text-sm text-slate-800 dark:text-slate-100">
                <strong>{t.label}</strong>
                <span className="mx-1.5 text-slate-300">/</span>
                <span className="text-slate-500 dark:text-slate-400">{t.inverse_label}</span>
              </div>
              <div className="text-[11px] text-slate-400">{t.description}</div>
            </div>
            <div className="flex gap-1.5">
              {!!t.is_dependency && <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300">propagates failure</span>}
              {!!t.is_containment && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">containment</span>}
              {!!t.system && <Lock size={11} className="text-slate-400" />}
            </div>
            <div className="flex gap-1">
              <button onClick={() => setModal(t)} className="rounded-lg p-1.5 text-slate-400 hover:text-brand-600"><Pencil size={13} /></button>
              <button
                onClick={async () => {
                  if (!confirm(`Delete "${t.label}"?`)) return;
                  try { await api.del(`/cmdb-config/relationship-types/${t.id}`); load(); } catch (e) { setError(e.message); }
                }}
                disabled={!!t.system}
                className="rounded-lg p-1.5 text-slate-400 hover:text-red-500 disabled:opacity-30"
              ><Trash2 size={13} /></button>
            </div>
          </div>
        ))}
      </div>

      {modal !== undefined && (
        <RelationshipTypeModal initial={modal} onClose={() => setModal(undefined)} onSaved={() => { setModal(undefined); load(); }} />
      )}
    </div>
  );
}

function RelationshipTypeModal({ initial, onClose, onSaved }) {
  const editing = !!initial?.id;
  const [form, setForm] = useState({
    key: initial?.key || '', label: initial?.label || '', inverse_label: initial?.inverse_label || '',
    description: initial?.description || '', color: initial?.color || '#64748b',
    is_dependency: initial ? !!initial.is_dependency : true,
    is_containment: initial ? !!initial.is_containment : false,
    enabled: initial ? !!initial.enabled : true,
  });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      if (editing) await api.patch(`/cmdb-config/relationship-types/${initial.id}`, form);
      else await api.post('/cmdb-config/relationship-types', form);
      onSaved();
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title={editing ? `Edit ${initial.label}` : 'New relationship type'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="label">Reads forward as<span className="text-red-500">*</span></label>
            <input className="input" required placeholder="Runs on" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></div>
          <div><label className="label">Reads backward as<span className="text-red-500">*</span></label>
            <input className="input" required placeholder="Hosts" value={form.inverse_label} onChange={(e) => setForm({ ...form, inverse_label: e.target.value })} /></div>
        </div>
        <div><label className="label">Key<span className="text-red-500">*</span></label>
          <input className="input" required disabled={editing && !!initial.system} value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} /></div>
        <div><label className="label">Description</label>
          <input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        <div><label className="label">Colour</label>
          <input className="input h-[38px] p-1" type="color" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} /></div>
        <div className="space-y-2">
          <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" className="mt-1" checked={form.is_dependency} onChange={(e) => setForm({ ...form, is_dependency: e.target.checked })} />
            <span>Failure propagates along this link
              <span className="block text-[11px] text-slate-400">Impact analysis follows it. Turn off for peer links where one side can fail alone.</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={form.is_containment} onChange={(e) => setForm({ ...form, is_containment: e.target.checked })} /> One contains the other
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} /> Available when linking CIs
          </label>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving && <Loader2 size={14} className="animate-spin" />} Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------- identification ---

function IdentificationPane({ setError }) {
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState('');
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [keys, setKeys] = useState([]);

  useEffect(() => {
    api.get('/cmdb-config/classes').then((d) => {
      const concrete = (d.classes || []).filter((c) => !c.is_abstract);
      setClasses(concrete);
      if (concrete.length) setClassId(concrete[0].id);
    }).catch((e) => setError(e.message));
  }, []);

  const load = () => {
    if (!classId) return;
    setData(null);
    api.get(`/cmdb-config/classes/${classId}/identification-rules`).then(setData).catch((e) => setError(e.message));
  };
  useEffect(() => { load(); }, [classId]);

  const add = async () => {
    try {
      await api.post(`/cmdb-config/classes/${classId}/identification-rules`, { name, attr_keys: keys, priority: 50 });
      setAdding(false); setName(''); setKeys([]);
      load();
    } catch (e) { setError(e.message); }
  };

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
        How an incoming record is recognised as a CI you already have. Rules are tried in order and the first that matches
        exactly one CI wins; a rule matching several is skipped rather than guessed at, because merging two real servers is
        worse than leaving a duplicate. Without these, every discovery run creates fresh rows.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[220px]">
          <label className="label">Class</label>
          <Select value={classId} onChange={setClassId} options={classes.map((c) => ({ value: c.id, label: c.label }))} />
        </div>
        <button onClick={() => setAdding(true)} disabled={!classId} className="btn-secondary text-xs disabled:opacity-40"><Plus size={12} /> Add rule</button>
      </div>

      {!data ? <Loading /> : data.rules.length === 0 ? (
        <EmptyState
          icon={Fingerprint}
          title="No identification rules"
          description="This class has no identifying fields, so every incoming record will create a new CI. Mark a field as an identifier on the class and a rule appears here automatically."
        />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {data.rules.map((r) => (
            <div key={r.id} className={`flex flex-wrap items-center gap-3 px-4 py-2.5 ${r.enabled ? '' : 'opacity-50'}`}>
              <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">#{r.priority}</span>
              <div className="min-w-[180px] flex-1">
                <div className="text-sm text-slate-800 dark:text-slate-100">{r.name}</div>
                <div className="font-mono text-[11px] text-slate-400">{r.attr_keys.join(' + ')}</div>
              </div>
              {r.attr_keys.length > 1 && (
                <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">composite — all must match</span>
              )}
              <div className="flex gap-1">
                <button
                  onClick={async () => { await api.patch(`/cmdb-config/identification-rules/${r.id}`, { enabled: !r.enabled }); load(); }}
                  className="btn-ghost text-[11px]"
                >{r.enabled ? 'Disable' : 'Enable'}</button>
                <button
                  onClick={async () => {
                    if (!confirm(`Delete "${r.name}"?`)) return;
                    try { await api.del(`/cmdb-config/identification-rules/${r.id}`); load(); } catch (e) { setError(e.message); }
                  }}
                  className="rounded-lg p-1.5 text-slate-400 hover:text-red-500"
                ><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {adding && data && (
        <Modal title="New identification rule" onClose={() => setAdding(false)}>
          <div className="space-y-3">
            <div><label className="label">Name<span className="text-red-500">*</span></label>
              <input className="input" placeholder="Match on hostname + domain" value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div>
              <label className="label">Match on<span className="text-red-500">*</span></label>
              <Select
                multiple value={keys} onChange={setKeys}
                placeholder="Choose the fields…"
                options={data.candidates.map((c) => ({ value: c.attr_key, label: `${c.label}${c.is_identifier ? ' (identifier)' : ''}` }))}
              />
              <p className="mt-1 text-[11px] text-slate-400">
                Pick more than one for a composite key. Every field chosen must match on the same CI for the rule to fire.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setAdding(false)} className="btn-secondary">Cancel</button>
              <button onClick={add} disabled={!name || !keys.length} className="btn-primary disabled:opacity-40">Add rule</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ------------------------------------------------------------ discovery ---

function DiscoveryPane({ setError }) {
  const [data, setData] = useState(null);
  const [classes, setClasses] = useState([]);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState(null);

  const load = () => api.get('/discovery/sources').then(setData).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api.get('/cmdb-config/classes').then((d) => setClasses((d.classes || []).filter((c) => !c.is_abstract))).catch(() => {});
  }, []);

  if (!data) return <Loading />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="max-w-2xl text-xs text-slate-500 dark:text-slate-400">
          Tools allowed to push CIs in. The trust rank settles disagreements: when two sources report different values for
          the same field, the higher rank wins and the losing write is kept as evidence rather than dropped. Manual edits
          outrank every tool.
        </p>
        <button onClick={() => setCreating(true)} className="btn-primary text-xs"><Plus size={13} /> New source</button>
      </div>

      {data.sources.length === 0 ? (
        <EmptyState
          icon={Radar}
          title="No discovery sources"
          description="Add one to give a scanner, hypervisor or cloud API its own credential and trust rank."
        />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {data.sources.map((s) => (
            <div key={s.id} className={`flex flex-wrap items-center gap-3 px-4 py-3 ${s.enabled ? '' : 'opacity-50'}`}>
              <div className="min-w-[180px] flex-1">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{s.name}</div>
                <div className="font-mono text-[11px] text-slate-400">{s.key}</div>
              </div>
              <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">trust {s.trust_rank}</span>
              {!s.allow_create && <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">update only</span>}
              <div className="text-[11px] text-slate-400">
                {s.last_ingest_at ? `last ran ${fmtDateTime(s.last_ingest_at)} · ${s.last_ingest_count} items` : 'never run'}
              </div>
              <div className="flex gap-1">
                <button
                  onClick={async () => {
                    if (!confirm('Rotate the secret? Anything still using the old one will stop working.')) return;
                    try { const r = await api.post(`/discovery/sources/${s.id}/rotate-secret`); setSecret(r.source); load(); }
                    catch (e) { setError(e.message); }
                  }}
                  className="rounded-lg p-1.5 text-slate-400 hover:text-brand-600" title="Rotate secret"
                ><RefreshCw size={13} /></button>
                <button
                  onClick={async () => { await api.patch(`/discovery/sources/${s.id}`, { enabled: !s.enabled }); load(); }}
                  className="btn-ghost text-[11px]"
                >{s.enabled ? 'Disable' : 'Enable'}</button>
                <button
                  onClick={async () => {
                    if (!confirm(`Delete ${s.name}? Values it wrote stay, attributed to it.`)) return;
                    try { await api.del(`/discovery/sources/${s.id}`); load(); } catch (e) { setError(e.message); }
                  }}
                  className="rounded-lg p-1.5 text-slate-400 hover:text-red-500"
                ><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
      )}

      {creating && (
        <SourceModal
          classes={classes}
          tiers={data.trust_tiers}
          onClose={() => setCreating(false)}
          onCreated={(s) => { setCreating(false); setSecret(s); load(); }}
        />
      )}
      {secret && <SecretModal source={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

function SourceModal({ classes, tiers, onClose, onCreated }) {
  const [form, setForm] = useState({ key: '', name: '', trust_rank: 50, allow_create: true, default_class_id: '' });
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const r = await api.post('/discovery/sources', form);
      onCreated({ ...r.source, ingest_url: r.ingest_url });
    } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  return (
    <Modal title="New discovery source" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="label">Name<span className="text-red-500">*</span></label>
            <input className="input" required placeholder="vCenter" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div><label className="label">Key<span className="text-red-500">*</span></label>
            <input className="input" required placeholder="vcenter" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} />
            <p className="mt-1 text-[10px] text-slate-400">Goes in the ingest URL and cannot change later.</p></div>
        </div>
        <div>
          <label className="label">Trust rank</label>
          <Select
            value={String(form.trust_rank)} onChange={(v) => setForm({ ...form, trust_rank: Number(v) })}
            options={tiers.map((t) => ({ value: String(t.rank), label: `${t.rank} — ${t.label}` }))}
          />
          <p className="mt-1 text-[11px] text-slate-400">{tiers.find((t) => t.rank === form.trust_rank)?.hint}</p>
        </div>
        <div>
          <label className="label">Default class</label>
          <Select
            value={form.default_class_id} onChange={(v) => setForm({ ...form, default_class_id: v })}
            placeholder="None — the payload must say"
            options={[{ value: '', label: 'None — the payload must say' }, ...classes.map((c) => ({ value: c.id, label: c.label }))]}
          />
        </div>
        <label className="flex items-start gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" className="mt-1" checked={form.allow_create} onChange={(e) => setForm({ ...form, allow_create: e.target.checked })} />
          <span>May create new CIs
            <span className="block text-[11px] text-slate-400">Turn off for a source you want to enrich existing records only.</span>
          </span>
        </label>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving && <Loader2 size={14} className="animate-spin" />} Create</button>
        </div>
      </form>
    </Modal>
  );
}

function SecretModal({ source, onClose }) {
  const [copied, setCopied] = useState('');
  const copy = (text, what) => { navigator.clipboard?.writeText(text); setCopied(what); setTimeout(() => setCopied(''), 1500); };
  const url = source.ingest_url || `/api/discovery/ingest/…/${source.key}`;

  return (
    <Modal title="Ingest credentials" onClose={onClose}>
      <div className="space-y-3">
        {/* Shown once. The secret is never readable again, so this modal is
            the only chance to copy it. */}
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <KeyRound size={13} className="mt-0.5 shrink-0" />
          Copy the secret now — it is stored hashed against this source and cannot be shown again. You can rotate it later.
        </div>

        <Field label="Ingest URL" value={url} onCopy={() => copy(url, 'url')} copied={copied === 'url'} />
        <Field label="Secret" value={source.ingest_secret} onCopy={() => copy(source.ingest_secret, 'secret')} copied={copied === 'secret'} mono />

        <div>
          <div className="label">Send it like this</div>
          <pre className="overflow-x-auto rounded-xl bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">
{`POST ${url}
X-Discovery-Secret: <secret>
Content-Type: application/json

{ "items": [
    { "ci_class": "server",
      "attributes": { "hostname": "app-01", "serial_number": "SN-1" } }
] }`}
          </pre>
          <p className="mt-1 text-[10px] text-slate-400">Add ?dry_run=1 to see what would happen without writing anything.</p>
        </div>

        <div className="flex justify-end"><button onClick={onClose} className="btn-primary">Done</button></div>
      </div>
    </Modal>
  );
}

function Field({ label, value, onCopy, copied, mono }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div className="flex gap-2">
        <input readOnly value={value || ''} className={`input flex-1 ${mono ? 'font-mono text-xs' : ''}`} />
        <button onClick={onCopy} className="btn-secondary shrink-0 text-xs">
          <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

function Loading() {
  return <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>;
}
