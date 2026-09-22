import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Loader2, Plus, Trash2, Pencil, ListChecks, ChevronRight, ToggleLeft, ToggleRight,
  ArrowUp, ArrowDown, Lock, ExternalLink, Check, X, AlertTriangle, Tags, Type,
  AlignLeft, CalendarClock, Users, CircleDot, ListFilter, Asterisk,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import TicketCategoriesTab from './TicketCategoriesTab.jsx';

const TICKET_TYPES = [
  { key: 'incident', label: 'Incident' },
  { key: 'request', label: 'Request' },
  { key: 'problem', label: 'Problem' },
  { key: 'change', label: 'Change' },
];

// Matched light/dark pairs, so an admin's colour choice can never produce an
// unreadable pill. The server only ever stores the token name.
const COLOR_CLASSES = {
  slate: 'bg-slate-100 text-slate-700 dark:bg-slate-700/50 dark:text-slate-200',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300',
  orange: 'bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300',
  red: 'bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300',
  cyan: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/15 dark:text-cyan-300',
};
const COLOR_DOTS = {
  slate: 'bg-slate-400', sky: 'bg-sky-500', emerald: 'bg-emerald-500', amber: 'bg-amber-500',
  orange: 'bg-orange-500', red: 'bg-red-500', violet: 'bg-violet-500', cyan: 'bg-cyan-500',
};

const KIND_META = {
  text: { icon: Type, label: 'Text' },
  textarea: { icon: AlignLeft, label: 'Paragraph' },
  enum: { icon: ListFilter, label: 'Dropdown' },
  taxonomy: { icon: Tags, label: 'Taxonomy' },
  taxonomy_child: { icon: Tags, label: 'Dependent multi-select' },
  reference: { icon: Users, label: 'Reference' },
  datetime: { icon: CalendarClock, label: 'Date & time' },
  select: { icon: ListFilter, label: 'Dropdown' },
  multiselect: { icon: ListChecks, label: 'Multi-select' },
};

// Where each externally-managed field actually lives, so the panel can send
// the admin straight there rather than just naming it.
const EXTERNAL_TARGETS = {
  lifecycles: { label: 'Open Lifecycles', section: 'lifecycles' },
  groups: { label: 'Open Groups', section: 'groups' },
  assignmentPolicies: { label: 'Open Assignment Policies', section: 'assignmentPolicies' },
};

function ColorPicker({ value, onChange, colors }) {
  return (
    <div className="flex flex-wrap gap-1">
      {colors.map((c) => (
        <button
          key={c} type="button" onClick={() => onChange(c)}
          title={c}
          aria-label={`Colour ${c}`}
          className={`h-5 w-5 rounded-full ${COLOR_DOTS[c] || 'bg-slate-400'} transition-transform ${
            value === c ? 'ring-2 ring-offset-2 ring-brand-500 dark:ring-offset-slate-900 scale-110' : 'hover:scale-110'
          }`}
        />
      ))}
    </div>
  );
}

function OptionListEditor({ field, colors, onChanged }) {
  const [options, setOptions] = useState(field.options || []);
  const [editingId, setEditingId] = useState(null);
  const [draft, setDraft] = useState({ label: '', color: 'slate' });
  const [newLabel, setNewLabel] = useState('');
  const [newColor, setNewColor] = useState('slate');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => { setOptions(field.options || []); }, [field.options]);

  const locked = field.valuesLocked;

  const apply = (resp) => {
    if (resp?.options) setOptions(resp.options);
    onChanged?.();
  };

  const run = async (fn) => {
    setBusy(true); setError(''); setNotice('');
    try { await fn(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  const add = () => run(async () => {
    if (!newLabel.trim()) return;
    apply(await api.post(`/ticket-fields/options/${field.key}`, { label: newLabel.trim(), color: newColor }));
    setNewLabel(''); setNewColor('slate');
  });

  const save = (opt) => run(async () => {
    apply(await api.patch(`/ticket-fields/options/${opt.id}`, { label: draft.label.trim(), color: draft.color }));
    setEditingId(null);
  });

  const toggle = (opt) => run(async () => {
    apply(await api.patch(`/ticket-fields/options/${opt.id}`, { active: !opt.active }));
  });

  const remove = (opt) => run(async () => {
    const resp = await api.del(`/ticket-fields/options/${opt.id}`);
    apply(resp);
    if (resp.deactivated) {
      setNotice(`"${opt.label}" is used by ${resp.tickets} ticket(s), so it was hidden rather than deleted — those tickets keep a readable value.`);
    }
  });

  const move = (index, delta) => run(async () => {
    const next = [...options];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setOptions(next);
    apply(await api.put(`/ticket-fields/options/${field.key}/order`, { ids: next.map((o) => o.id) }));
  });

  return (
    <div className="space-y-3">
      {locked && (
        <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-2.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
          <Lock size={13} className="mt-0.5 shrink-0" />
          <span>{field.lockedReason}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl bg-sky-50 p-2.5 text-xs text-sky-800 dark:bg-sky-500/10 dark:text-sky-200">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span className="flex-1">{notice}</span>
          <button onClick={() => setNotice('')} className="btn-ghost p-0.5" aria-label="Dismiss"><X size={11} /></button>
        </div>
      )}
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}

      <ul className="space-y-1.5">
        {options.map((opt, i) => (
          <li
            key={opt.id}
            className={`flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-2.5 py-2 dark:border-white/10 dark:bg-slate-900/50 ${
              !opt.active ? 'opacity-60' : ''
            }`}
          >
            {editingId === opt.id ? (
              <>
                <input
                  className="input w-auto min-w-[160px] flex-1 px-2 py-1 text-xs" value={draft.label} autoFocus
                  onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save(opt); } }}
                />
                <ColorPicker value={draft.color} onChange={(c) => setDraft((d) => ({ ...d, color: c }))} colors={colors} />
                <button onClick={() => save(opt)} disabled={busy} className="btn-primary text-xs"><Check size={11} /> Save</button>
                <button onClick={() => setEditingId(null)} className="btn-secondary text-xs">Cancel</button>
              </>
            ) : (
              <>
                <span className={`badge ${COLOR_CLASSES[opt.color] || COLOR_CLASSES.slate}`}>{opt.label}</span>
                <code className="text-[10px] text-slate-400">{opt.value}</code>
                {!opt.active && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">hidden</span>}
                <span className="flex-1" />
                {!locked && (
                  <>
                    <button onClick={() => move(i, -1)} disabled={busy || i === 0} className="btn-ghost p-1 disabled:opacity-30" aria-label="Move up"><ArrowUp size={12} /></button>
                    <button onClick={() => move(i, 1)} disabled={busy || i === options.length - 1} className="btn-ghost p-1 disabled:opacity-30" aria-label="Move down"><ArrowDown size={12} /></button>
                  </>
                )}
                <button
                  onClick={() => { setEditingId(opt.id); setDraft({ label: opt.label, color: opt.color || 'slate' }); }}
                  className="btn-ghost p-1" aria-label="Rename"
                ><Pencil size={12} /></button>
                {!locked && (
                  <>
                    <button onClick={() => toggle(opt)} disabled={busy} className="btn-ghost p-1" aria-label={opt.active ? 'Hide' : 'Show'}>
                      {opt.active ? <ToggleRight size={15} className="text-emerald-600" /> : <ToggleLeft size={15} className="text-slate-400" />}
                    </button>
                    <button onClick={() => remove(opt)} disabled={busy} className="btn-ghost p-1 text-red-500" aria-label="Delete"><Trash2 size={12} /></button>
                  </>
                )}
              </>
            )}
          </li>
        ))}
      </ul>

      {!locked && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed border-slate-300 p-2.5 dark:border-slate-700">
          <input
            className="input w-auto min-w-[160px] flex-1 px-2 py-1 text-xs"
            value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder={`Add an option to ${field.label}`}
          />
          <ColorPicker value={newColor} onChange={setNewColor} colors={colors} />
          <button onClick={add} disabled={busy || !newLabel.trim()} className="btn-secondary text-xs">
            {busy ? <Loader2 size={11} className="animate-spin" /> : <Plus size={11} />} Add
          </button>
        </div>
      )}
    </div>
  );
}

const CUSTOM_FIELD_TYPES = [
  { value: 'text', label: 'Text' },
  { value: 'textarea', label: 'Paragraph' },
  { value: 'select', label: 'Dropdown' },
  { value: 'multiselect', label: 'Multi-select dropdown' },
];

function CustomFieldModal({ ticketType, field, onClose, onSaved }) {
  const [label, setLabel] = useState(field?.label || '');
  const [fieldType, setFieldType] = useState(field?.field_type || 'text');
  const [options, setOptions] = useState(field?.options?.length ? field.options : ['']);
  const [required, setRequired] = useState(field ? !!field.required : false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const isDropdown = fieldType === 'select' || fieldType === 'multiselect';

  const save = async () => {
    setError('');
    if (!label.trim()) { setError('Label is required.'); return; }
    const cleanOptions = options.map((o) => o.trim()).filter(Boolean);
    if (isDropdown && cleanOptions.length === 0) { setError('A dropdown needs at least one option.'); return; }
    setSaving(true);
    try {
      const body = { label: label.trim(), field_type: fieldType, options: isDropdown ? cleanOptions : [], required };
      if (field) await api.patch(`/custom-fields/${field.id}`, body);
      else await api.post('/custom-fields', { ...body, ticket_type: ticketType });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={field ? `Edit "${field.label}"` : 'New custom field'} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <div>
          <label className="label">Label</label>
          <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Affected site" />
          {field && <p className="mt-1 text-xs text-slate-400">Stored key <code className="font-mono">{field.field_key}</code> never changes, so existing values and Business Rules keep working.</p>}
        </div>
        <div>
          <label className="label">Field type</label>
          <Select value={fieldType} onChange={setFieldType} options={CUSTOM_FIELD_TYPES} disabled={!!field} />
          {field && <p className="mt-1 text-xs text-slate-400">The type is fixed after creation — values already stored were captured in this shape.</p>}
        </div>
        {isDropdown && (
          <div>
            <label className="label">Options</label>
            <div className="space-y-1.5">
              {options.map((o, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    className="input px-2 py-1 text-sm" value={o}
                    onChange={(e) => setOptions(options.map((x, idx) => (idx === i ? e.target.value : x)))}
                    placeholder={`Option ${i + 1}`}
                  />
                  <button onClick={() => setOptions(options.filter((_, idx) => idx !== i))} className="btn-ghost p-1.5 text-red-500 shrink-0" aria-label="Remove option"><Trash2 size={13} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setOptions([...options, ''])} className="btn-secondary mt-2 text-xs"><Plus size={12} /> Option</button>
          </div>
        )}
        <button type="button" onClick={() => setRequired((r) => !r)} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
          {required ? <ToggleRight size={18} className="text-brand-600" /> : <ToggleLeft size={18} className="text-slate-400" />}
          Required on this form
        </button>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button onClick={save} disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {field ? 'Save field' : 'Create field'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FieldRow({ field, colors, expanded, onToggle, onChanged, navigate }) {
  const kind = KIND_META[field.kind] || KIND_META.text;
  const Icon = kind.icon;
  const external = field.manage === 'external' ? EXTERNAL_TARGETS[field.managedBy] : null;
  const configurable = field.manage === 'options' || field.manage === 'taxonomy';

  return (
    <div className="card overflow-hidden p-0">
      <button
        type="button"
        onClick={configurable || external ? onToggle : undefined}
        className={`flex w-full items-start gap-3 p-3 text-left ${configurable || external ? '' : 'cursor-default'}`}
      >
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">
          <Icon size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{field.label}</span>
            <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{kind.label}</span>
            {field.required && <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300"><Asterisk size={9} /> required</span>}
            {field.valuesLocked && <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"><Lock size={9} /> values fixed</span>}
            {field.manage === 'none' && <span className="badge bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">nothing to configure</span>}
            {external && <span className="badge bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300">managed elsewhere</span>}
          </span>
          <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{field.description}</span>
          {field.options?.length > 0 && !expanded && (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {field.options.filter((o) => o.active).slice(0, 6).map((o) => (
                <span key={o.id} className={`badge ${COLOR_CLASSES[o.color] || COLOR_CLASSES.slate}`}>{o.label}</span>
              ))}
            </span>
          )}
        </span>
        {(configurable || external) && (
          <ChevronRight size={15} className={`mt-1 shrink-0 text-slate-300 transition-transform dark:text-slate-600 ${expanded ? 'rotate-90' : ''}`} />
        )}
      </button>

      {expanded && (
        <div className="border-t border-slate-100 bg-slate-50/60 p-3 dark:border-white/5 dark:bg-slate-800/30">
          {field.manage === 'options' && <OptionListEditor field={field} colors={colors} onChanged={onChanged} />}
          {field.manage === 'taxonomy' && field.key === 'category' && (
            <div className="rounded-xl bg-white p-3 dark:bg-slate-900/50">
              <TicketCategoriesTab embedded />
            </div>
          )}
          {field.manage === 'taxonomy' && field.key === 'subcategory' && (
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Subcategories live under their parent category — open <strong>Category</strong> above and expand a category to manage its subcategories.
              On the ticket form this appears as a multi-select dropdown that only lists the chosen category&apos;s subcategories.
            </p>
          )}
          {external && (
            <div className="space-y-2">
              <p className="text-xs text-slate-600 dark:text-slate-300">{field.externalReason}</p>
              <button
                onClick={() => navigate(`/admin-settings?section=${external.section}`)}
                className="btn-secondary text-xs"
              >
                <ExternalLink size={12} /> {external.label}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function TicketFieldManagerTab() {
  const navigate = useNavigate();
  const [ticketType, setTicketType] = useState('incident');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [customModal, setCustomModal] = useState(null); // 'new' | field

  const load = async (type = ticketType) => {
    setError('');
    try {
      setData(await api.get(`/ticket-fields/${type}?all=1`));
    } catch (e) {
      setError(e.message);
      setData(null);
    }
  };

  useEffect(() => { setData(null); setExpanded(null); load(ticketType); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ticketType]);

  const removeCustom = async (field) => {
    if (!window.confirm(`Delete "${field.label}"? Values already captured on existing tickets are removed with it.`)) return;
    await api.del(`/custom-fields/${field.id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
          <ListChecks size={18} className="text-brand-600" /> Field Manager
        </h3>
        <p className="mt-0.5 max-w-3xl text-sm text-slate-500 dark:text-slate-400">
          Every field on a ticket form, built-in and custom, in one place. Expand a field to edit its options, labels and colours.
          Where a field is owned by another area — statuses by Lifecycles, groups by Groups — this links you there rather than keeping a second copy of the list.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-white/10">
        {TICKET_TYPES.map((t) => (
          <button
            key={t.key} onClick={() => setTicketType(t.key)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
              ticketType === t.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="py-6 text-center text-sm">
          <p className="text-red-600 dark:text-red-400">{error}</p>
          <button onClick={() => load()} className="btn-secondary mx-auto mt-2 text-xs">Retry</button>
        </div>
      )}

      {!data && !error && (
        <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading fields…</p>
      )}

      {data && (
        <>
          <div>
            <h4 className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
              <CircleDot size={11} /> Built-in fields
            </h4>
            <div className="space-y-2">
              {data.builtin.map((field) => (
                <FieldRow
                  key={field.key}
                  field={field}
                  colors={data.colors}
                  expanded={expanded === field.key}
                  onToggle={() => setExpanded(expanded === field.key ? null : field.key)}
                  onChanged={() => load()}
                  navigate={navigate}
                />
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between gap-3">
              <h4 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                <Plus size={11} /> Custom fields
              </h4>
              <button onClick={() => setCustomModal('new')} className="btn-primary text-xs"><Plus size={13} /> Add field</button>
            </div>

            {data.custom.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400 dark:border-slate-700">
                No custom fields on the {TICKET_TYPES.find((t) => t.key === ticketType)?.label.toLowerCase()} form yet.
              </p>
            ) : (
              <div className="space-y-2">
                {data.custom.map((field) => {
                  const kind = KIND_META[field.field_type] || KIND_META.text;
                  const Icon = kind.icon;
                  return (
                    <div key={field.id} className="card flex flex-wrap items-start gap-3 p-3">
                      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-300">
                        <Icon size={15} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{field.label}</span>
                          <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{kind.label}</span>
                          {!!field.required && <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-300"><Asterisk size={9} /> required</span>}
                          <code className="text-[10px] text-slate-400">{field.field_key}</code>
                        </div>
                        {field.options?.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {field.options.map((o) => (
                              <span key={o} className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{o}</span>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button onClick={() => setCustomModal(field)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={13} /></button>
                        <button onClick={() => removeCustom(field)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={13} /></button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {customModal && (
        <CustomFieldModal
          ticketType={ticketType}
          field={customModal === 'new' ? null : customModal}
          onClose={() => setCustomModal(null)}
          onSaved={() => { setCustomModal(null); load(); }}
        />
      )}
    </div>
  );
}
