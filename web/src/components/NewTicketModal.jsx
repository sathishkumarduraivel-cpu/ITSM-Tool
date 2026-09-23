import { useEffect, useState } from 'react';
import { Plus, Loader2, AlertTriangle, ShoppingBag, Search, GitBranch, Info, Paperclip, X } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from './Modal.jsx';
import Select from './Select.jsx';
import { useBusinessRules } from '../hooks/useBusinessRules.js';

const PRIORITIES = ['low', 'medium', 'high', 'critical'];

// Shown only while /changes/meta is in flight, so the type picker is never
// empty. The real list (with this workspace's own SLAs and plan rules) comes
// from the server.
const FALLBACK_CHANGE_TYPES = [
  { key: 'standard', label: 'Standard', description: 'Pre-approved and repeatable. Auto-approves when it matches a template.' },
  { key: 'normal', label: 'Normal', description: 'The default path. Reviewed by the CAB.' },
  { key: 'emergency', label: 'Emergency', description: 'Restores service. Goes straight to the ECAB.' },
  { key: 'expedite', label: 'Expedite', description: 'Urgent but not an outage. Short-SLA approval.' },
];
const RISKS = ['low', 'medium', 'high'];

// Full literal class strings (not template fragments) so Tailwind's scanner
// picks them up -- same pattern components/Badge.jsx already uses.
const TONE = {
  red: 'border-red-300 bg-red-50 text-red-700 dark:border-red-500/40 dark:bg-red-500/10 dark:text-red-400',
  amber: 'border-amber-300 bg-amber-50 text-amber-700 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-400',
  brand: 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-400',
  purple: 'border-purple-300 bg-purple-50 text-purple-700 dark:border-purple-500/40 dark:bg-purple-500/10 dark:text-purple-400',
  teal: 'border-teal-300 bg-teal-50 text-teal-700 dark:border-teal-500/40 dark:bg-teal-500/10 dark:text-teal-400',
  slate: 'border-slate-300 bg-slate-100 text-slate-600 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-300',
};
const PILL_IDLE = 'border-slate-200 dark:border-white/10 text-slate-500 dark:text-slate-400 hover:border-slate-300 dark:hover:border-white/20 hover:bg-slate-50 dark:hover:bg-white/[0.04]';

const SEVERITY_TONE = { critical: TONE.red, high: TONE.amber, medium: TONE.brand, low: TONE.slate };
const toneForSeverity = (v) => SEVERITY_TONE[v] || TONE.slate;

const TYPE_META = {
  incident: { icon: AlertTriangle, tone: TONE.red, blurb: 'Something is broken or degraded' },
  request: { icon: ShoppingBag, tone: TONE.brand, blurb: 'Ask for something new' },
  problem: { icon: Search, tone: TONE.purple, blurb: 'Investigate an underlying cause' },
  change: { icon: GitBranch, tone: TONE.teal, blurb: 'Plan a controlled change' },
};

const FIELD_LABELS = {
  priority: 'Priority', category: 'Category', subcategory: 'Subcategory', team: 'Group', impact: 'Impact',
  risk: 'Risk', planned_start: 'Planned start', planned_end: 'Planned end', rollback_plan: 'Rollback plan',
};

const isEmptyValue = (v) => v === undefined || v === null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === '');

function SectionHeading({ children }) {
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500 mb-2.5">{children}</h3>;
}

function Required() {
  return <span className="text-red-500">*</span>;
}

// Shared pill-button selector for short, fixed option sets (type/priority/
// impact/risk) -- replaces a plain <select> with something that reads at a
// glance and is far more inviting to tap than a dropdown, while still being
// driven entirely by the same Field Manager-computed option list.
// Accepts plain strings or {value,label} objects, so option lists configured
// in Field Manager can carry their own label while a Business Rule's
// set_options (still a string array) keeps working unchanged.
function PillGroup({ options, value, onChange, toneFor, disabled }) {
  const normalized = (options || []).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <div className="flex flex-wrap gap-1.5">
      {normalized.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-all duration-150 disabled:opacity-40 disabled:cursor-not-allowed ${
              active ? `${toneFor(opt.value)} shadow-sm` : PILL_IDLE
            }`}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export default function NewTicketModal({ onClose, onCreated, availableTypes }) {
  const [form, setForm] = useState({
    title: '', description: '', type: availableTypes[0], priority: 'medium',
    category: '', subcategory: '', team: '', impact: 'medium',
    risk: 'medium', planned_start: '', planned_end: '', rollback_plan: '',
    change_type: 'normal', implementation_plan: '', test_plan: '',
    catalog_item_id: '', custom: {},
  });
  const [groups, setGroups] = useState([]);
  const [customFields, setCustomFields] = useState([]);
  const [catalogItems, setCatalogItems] = useState([]);
  const [taxonomy, setTaxonomy] = useState([]);
  const [fieldMeta, setFieldMeta] = useState(null);
  const [changeTypes, setChangeTypes] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState([]);
  const isChange = form.type === 'change';
  const isRequest = form.type === 'request';
  const isIncident = form.type === 'incident';
  const selectedCatalogItem = catalogItems.find((i) => i.id === form.catalog_item_id);
  // Attachments only make sense for the two ticket types an end user files
  // directly with supporting evidence (a screenshot, a log, a quote) --
  // problems and changes are agent/CAB-driven and already have their own
  // attachment point once the ticket exists. For a Request tied to a
  // Service Catalog item, whether attachments apply (and whether one is
  // mandatory) is exactly what that item's own configuration says --
  // configured in Service Catalog → manage → edit item. No item selected
  // yet (or Request isn't catalog-bound) falls back to "allowed, optional".
  const showAttachments = isIncident || (isRequest && (selectedCatalogItem?.allow_attachments ?? true));
  const requireAttachment = isRequest && !!selectedCatalogItem?.require_attachment;
  const catalogItemName = selectedCatalogItem?.name || '';
  // Business Rules can also target/react to custom fields and the synthetic
  // "Service Item" field, so give it a flat view (built-ins + form.custom's
  // keys + the resolved service item name) to evaluate against.
  const liveValues = { ...form, ...form.custom, catalog_item_name: catalogItemName };
  const fieldRules = useBusinessRules(form.type, liveValues);

  useEffect(() => { api.get('/groups').then(({ groups }) => setGroups(groups)).catch(() => setGroups([])); }, []);
  // The configured change types, so the picker shows this workspace's own
  // labels, SLAs and mandatory-plan rules rather than a hardcoded four.
  useEffect(() => {
    if (!availableTypes.includes('change')) return;
    api.get('/changes/meta').then((d) => setChangeTypes(d.change_types || [])).catch(() => setChangeTypes([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Option lists and the category taxonomy for the selected ticket type,
  // re-fetched when the type changes since risk only exists on changes.
  useEffect(() => {
    api.get(`/ticket-fields/${form.type}`)
      .then((data) => {
        setFieldMeta(data);
        setTaxonomy(data.builtin.find((f) => f.key === 'category')?.taxonomy || []);
      })
      .catch(() => { setFieldMeta(null); setTaxonomy([]); });
  }, [form.type]);

  // Subcategory is multi-value, stored as a comma-separated list -- see
  // server/src/services/ticketCategories.js for why that shape rather than JSON.
  const selectedSubcategories = String(form.subcategory || '').split(',').map((s) => s.trim()).filter(Boolean);
  const subcategoryOptions = (taxonomy.find((c) => c.name === form.category)?.subcategories || []).map((s) => s.name);
  useEffect(() => {
    api.get(`/custom-fields?ticket_type=${form.type}`).then(({ fields }) => setCustomFields(fields)).catch(() => setCustomFields([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.type]);
  useEffect(() => {
    if (form.type !== 'request') { setCatalogItems([]); return; }
    api.get('/catalog/items').then(({ items }) => setCatalogItems(items)).catch(() => setCatalogItems([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.type]);

  const setCustom = (key, value) => setForm((f) => ({ ...f, custom: { ...f.custom, [key]: value } }));

  // A "Set Field Value" action auto-populates a field -- sync it into real
  // form state as soon as its rule matches. Runs every render (cheap, pure)
  // but only ever calls setForm when a computed value actually differs, so
  // it settles after one extra render instead of looping.
  useEffect(() => {
    const builtinAuto = ['priority', 'category', 'subcategory', 'team', 'impact', 'risk', 'planned_start', 'planned_end', 'rollback_plan']
      .reduce((acc, f) => {
        const v = fieldRules.getAutoValue(f);
        if (v !== undefined && form[f] !== v) acc[f] = v;
        return acc;
      }, {});
    const customAuto = customFields.reduce((acc, f) => {
      const v = fieldRules.getAutoValue(f.field_key);
      if (v !== undefined && form.custom[f.field_key] !== v) acc[f.field_key] = v;
      return acc;
    }, {});
    if (Object.keys(builtinAuto).length || Object.keys(customAuto).length) {
      setForm((prev) => ({ ...prev, ...builtinAuto, custom: { ...prev.custom, ...customAuto } }));
    }
  });

  // Every field below falls back to its current hardcoded default when no
  // Business Rule exists for it, and is otherwise fully governed by that
  // rule — visibility, requiredness, conditions, format, options.
  const showPriority = fieldRules.isVisible('priority', true);
  const showCategory = fieldRules.isVisible('category', true);
  const showSubcategory = fieldRules.isVisible('subcategory', true);
  const showTeam = fieldRules.isVisible('team', true);
  const showImpact = fieldRules.isVisible('impact', true);
  const showServiceItem = isRequest && fieldRules.isVisible('catalog_item_name', true);
  const showRisk = fieldRules.isVisible('risk', isChange);
  const showPlannedStart = fieldRules.isVisible('planned_start', isChange);
  const showPlannedEnd = fieldRules.isVisible('planned_end', isChange);
  const showRollbackPlan = fieldRules.isVisible('rollback_plan', isChange);
  const selectedChangeType = changeTypes.find((t) => t.key === form.change_type) || null;
  const showChangeSection = showRisk || showPlannedStart || showPlannedEnd || showRollbackPlan;

  // A Business Rule's set_options wins if one applies; otherwise the options
  // an admin configured in Field Manager; the module constants are only a
  // fallback for the moment before /ticket-fields resolves.
  const configured = (key, fallback) => {
    const opts = fieldMeta?.builtin?.find((f) => f.key === key)?.options;
    return opts?.length ? opts.map((o) => ({ value: o.value, label: o.label })) : fallback;
  };
  const priorityOptions = fieldRules.getOptions('priority', null) || configured('priority', PRIORITIES);
  const impactOptions = fieldRules.getOptions('impact', null) || configured('impact', RISKS);
  const riskOptions = fieldRules.getOptions('risk', null) || configured('risk', RISKS);
  const teamOptions = fieldRules.getOptions('team', groups.map((g) => g.name));

  const ALL_RULED_FIELDS = ['priority', 'category', 'subcategory', 'team', 'impact', 'risk', 'planned_start', 'planned_end', 'rollback_plan'];
  const VISIBLE_BY_FIELD = {
    priority: showPriority, category: showCategory, subcategory: showSubcategory, team: showTeam, impact: showImpact,
    risk: showRisk, planned_start: showPlannedStart, planned_end: showPlannedEnd, rollback_plan: showRollbackPlan,
  };

  // A field hidden by a rule can't be filled in, so it can't be allowed to
  // block submission even if some other rule also marked it required — only
  // enforce "required" on a field the user can actually see and fix.
  const requiredError = (field, value, label, visible = true) =>
    (visible && fieldRules.isRequired(field) && isEmptyValue(value)) ? `${label} is required.` : null;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    const builtinRequired = ALL_RULED_FIELDS.map((f) => requiredError(f, form[f], FIELD_LABELS[f] || f, VISIBLE_BY_FIELD[f]));
    const customRequired = customFields.map((f) => requiredError(f.field_key, form.custom[f.field_key], f.label, fieldRules.isVisible(f.field_key, true)));
    const formatErrors = ALL_RULED_FIELDS.map((f) => fieldRules.getError(f)).concat(customFields.map((f) => fieldRules.getError(f.field_key)));
    const serviceItemError = showServiceItem && fieldRules.isRequired('catalog_item_name') && !form.catalog_item_id ? 'Service Item is required.' : null;
    const attachmentError = showAttachments && requireAttachment && files.length === 0 ? 'At least one attachment is required.' : null;
    const firstError = [...builtinRequired, ...customRequired, ...formatErrors, serviceItemError, attachmentError].find(Boolean);
    if (firstError) { setError(firstError); return; }
    setSaving(true);
    try {
      const { ticket } = await api.post('/tickets', form);
      if (files.length) {
        const formData = new FormData();
        for (const f of files) formData.append('files', f);
        // The ticket has to exist before files can attach to it -- best-effort:
        // a failed upload here shouldn't lose the ticket that was just created.
        await api.upload(`/tickets/${ticket.id}/attachments`, formData).catch(() => {});
      }
      onCreated(ticket);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title="New ticket"
      onClose={onClose}
      maxWidth="max-w-3xl"
      footer={
        <div className="flex items-center justify-between gap-3">
          <p className="hidden sm:block text-xs text-slate-400"><Required /> required field</p>
          <div className="flex items-center gap-2 ml-auto">
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
            <button type="submit" form="new-ticket-form" disabled={saving} className="btn-primary">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create ticket
            </button>
          </div>
        </div>
      }
    >
      <form id="new-ticket-form" onSubmit={submit} className="space-y-6">
        {error && (
          <div className="flex items-start gap-2 text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2.5">
            <Info size={15} className="shrink-0 mt-0.5" /> {error}
          </div>
        )}

        <div>
          <SectionHeading>What are you reporting?</SectionHeading>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {availableTypes.map((t) => {
              const meta = TYPE_META[t] || TYPE_META.request;
              const Icon = meta.icon;
              const active = form.type === t;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setForm({ ...form, type: t })}
                  className={`flex flex-col items-start gap-1.5 rounded-xl border-2 p-3 text-left transition-all duration-200 ${
                    active ? `${meta.tone} shadow-sm` : `${PILL_IDLE} border-slate-200`
                  }`}
                >
                  <Icon size={18} />
                  <span className="text-sm font-semibold capitalize">{t}</span>
                  <span className="text-[11px] leading-tight opacity-75">{meta.blurb}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="label">Title <Required /></label>
            <input
              className="input text-base font-medium"
              required
              autoFocus
              placeholder="Briefly summarize the issue or request"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <label className="label">Description</label>
            <textarea
              className="input"
              rows={4}
              placeholder="What's happening? Include anything that'll help whoever picks this up."
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>

        {showAttachments && (
          <div>
            <SectionHeading>Attachments</SectionHeading>
            <div className="space-y-1.5">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-sm bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
                  <span className="flex items-center gap-2 min-w-0">
                    <Paperclip size={13} className="shrink-0 text-slate-400" />
                    <span className="truncate">{f.name}</span>
                  </span>
                  <button type="button" onClick={() => setFiles((fs) => fs.filter((_, idx) => idx !== i))} className="text-slate-400 hover:text-red-500 shrink-0">
                    <X size={14} />
                  </button>
                </div>
              ))}
              <label className="btn-secondary text-xs cursor-pointer inline-flex">
                <Paperclip size={13} /> Attach files
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => setFiles((fs) => [...fs, ...Array.from(e.target.files || [])])}
                />
              </label>
              {requireAttachment && <span className="text-xs text-slate-400 ml-2">At least one file is required for this item.</span>}
            </div>
          </div>
        )}

        {(showPriority || showImpact) && (
          <div>
            <SectionHeading>Severity</SectionHeading>
            <div className="grid sm:grid-cols-2 gap-4">
              {showPriority && (
                <div>
                  <label className="label">Priority{fieldRules.isRequired('priority') && <Required />}</label>
                  <PillGroup options={priorityOptions} value={form.priority} onChange={(v) => setForm({ ...form, priority: v })} toneFor={toneForSeverity} />
                </div>
              )}
              {showImpact && (
                <div>
                  <label className="label">Impact{fieldRules.isRequired('impact') && <Required />}</label>
                  <PillGroup options={impactOptions} value={form.impact} onChange={(v) => setForm({ ...form, impact: v })} toneFor={toneForSeverity} />
                </div>
              )}
            </div>
          </div>
        )}

        {(showCategory || showSubcategory || showTeam || showServiceItem) && (
          <div>
            <SectionHeading>Classification</SectionHeading>
            <div className="grid sm:grid-cols-2 gap-3">
              {showServiceItem && (
                <div className="sm:col-span-2">
                  <label className="label">Service Item{fieldRules.isRequired('catalog_item_name') && <Required />}</label>
                  <Select
                    value={form.catalog_item_id}
                    onChange={(v) => setForm({ ...form, catalog_item_id: v })}
                    options={[
                      { value: '', label: 'Choose a service item…' },
                      ...catalogItems
                        .filter((item) => fieldRules.getOptions('catalog_item_name', catalogItems.map((i) => i.name)).includes(item.name))
                        .map((item) => ({ value: item.id, label: item.name })),
                    ]}
                  />
                  {fieldRules.getError('catalog_item_name') && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('catalog_item_name')}</p>}
                </div>
              )}
              {showCategory && (
                <div>
                  <label className="label">Category{fieldRules.isRequired('category') && <Required />}</label>
                  <Select
                    value={form.category}
                    // Changing category drops subcategories that belonged to
                    // the old one, matching the server's own rule in
                    // PATCH /tickets/:id.
                    onChange={(v) => setForm({ ...form, category: v, subcategory: '' })}
                    options={[
                      { value: '', label: fieldRules.isRequired('category') ? 'Choose a category…' : 'Uncategorised' },
                      ...fieldRules.getOptions('category', taxonomy.map((c) => c.name)),
                    ]}
                  />
                  {fieldRules.getError('category') && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('category')}</p>}
                </div>
              )}
              {showSubcategory && subcategoryOptions.length > 0 && (
                <div>
                  <label className="label">
                    Subcategory{fieldRules.isRequired('subcategory') && <Required />}
                    {selectedSubcategories.length > 0 && <span className="ml-1 text-slate-400">({selectedSubcategories.length})</span>}
                  </label>
                  <Select
                    multiple
                    value={selectedSubcategories}
                    onChange={(next) => setForm((cur) => ({ ...cur, subcategory: next.join(', ') }))}
                    options={subcategoryOptions}
                    placeholder="Choose one or more…"
                  />
                  {fieldRules.getError('subcategory') && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('subcategory')}</p>}
                </div>
              )}
              {showTeam && (
                <div>
                  <label className="label">Group{fieldRules.isRequired('team') && <Required />}</label>
                  <Select
                    value={form.team}
                    onChange={(v) => setForm({ ...form, team: v })}
                    options={[{ value: '', label: 'Unassigned' }, ...teamOptions.map((name) => ({ value: name, label: name }))]}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {customFields.some((f) => fieldRules.isVisible(f.field_key, true)) && (
          <div>
            <SectionHeading>Additional details</SectionHeading>
            <div className="space-y-3">
              {customFields.map((f) => {
                const visible = fieldRules.isVisible(f.field_key, true);
                if (!visible) return null;
                const required = fieldRules.isRequired(f.field_key, !!f.required);
                const value = form.custom[f.field_key];
                const err = fieldRules.getError(f.field_key);
                const options = fieldRules.getOptions(f.field_key, f.options);
                return (
                  <div key={f.id}>
                    <label className="label">{f.label}{required && <Required />}</label>
                    {f.field_type === 'text' && (
                      <input className="input" required={required} value={value || ''} onChange={(e) => setCustom(f.field_key, e.target.value)} />
                    )}
                    {f.field_type === 'textarea' && (
                      <textarea className="input" rows={3} required={required} value={value || ''} onChange={(e) => setCustom(f.field_key, e.target.value)} />
                    )}
                    {f.field_type === 'select' && (
                      <Select
                        value={value || ''}
                        onChange={(v) => setCustom(f.field_key, v)}
                        options={[{ value: '', label: 'Choose…' }, ...options.map((o) => ({ value: o, label: o }))]}
                      />
                    )}
                    {f.field_type === 'multiselect' && (
                      <div className="input h-auto flex flex-wrap gap-x-4 gap-y-1.5 py-2.5">
                        {options.map((o) => {
                          const arr = Array.isArray(value) ? value : [];
                          return (
                            <label key={o} className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                              <input
                                type="checkbox"
                                checked={arr.includes(o)}
                                onChange={(e) => setCustom(f.field_key, e.target.checked ? [...arr, o] : arr.filter((v) => v !== o))}
                              />
                              {o}
                            </label>
                          );
                        })}
                      </div>
                    )}
                    {err && <p className="text-xs text-red-600 mt-1">{err}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {showChangeSection && (
          <div className="rounded-xl border border-teal-200 dark:border-teal-500/25 bg-teal-50/50 dark:bg-teal-500/[0.06] p-4 space-y-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-teal-700 dark:text-teal-400">
              <GitBranch size={13} /> Change details
            </div>
            <p className="text-xs text-slate-500 dark:text-slate-400 -mt-2">
              Pick the change type and fill in the plans. Risk is scored automatically once the change is raised — from the CIs it touches, their blast radius, and how complete these plans are.
            </p>

            {/* Change type drives everything downstream: which approvals
                apply, which plans are mandatory, and whether a freeze can be
                overridden. It was missing from this form entirely, so every
                change arrived unclassified. */}
            <div>
              <label className="label">Change type<Required /></label>
              <div className="grid gap-2 sm:grid-cols-2">
                {(changeTypes.length ? changeTypes : FALLBACK_CHANGE_TYPES).map((t) => {
                  const active = form.change_type === t.key;
                  return (
                    <button
                      key={t.key} type="button"
                      onClick={() => setForm({ ...form, change_type: t.key })}
                      className={`rounded-xl border p-2.5 text-left transition-colors ${
                        active
                          ? 'border-teal-500 bg-white shadow-sm dark:border-teal-400 dark:bg-slate-900'
                          : 'border-slate-200 hover:bg-white/60 dark:border-white/10 dark:hover:bg-slate-900/40'
                      }`}
                    >
                      <span className="flex items-center gap-1.5">
                        <span className={`h-2 w-2 rounded-full ${
                          t.key === 'emergency' ? 'bg-red-500' : t.key === 'expedite' ? 'bg-violet-500'
                            : t.key === 'standard' ? 'bg-emerald-500' : 'bg-sky-500'
                        }`} />
                        <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{t.label}</span>
                        {t.approval_sla_hours ? (
                          <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{t.approval_sla_hours}h SLA</span>
                        ) : null}
                      </span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">{t.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label className="label">
                Implementation plan{selectedChangeType?.requires_implementation_plan && <Required />}
              </label>
              <textarea
                className="input" rows={4}
                value={form.implementation_plan}
                onChange={(e) => setForm({ ...form, implementation_plan: e.target.value })}
                placeholder={'1. Fail over to the replica.\n2. Apply the patch.\n3. Fail back and verify.'}
              />
            </div>

            {showRollbackPlan && (
              <div>
                <label className="label">
                  Backout plan{(selectedChangeType?.requires_backout ?? fieldRules.isRequired('rollback_plan')) && <Required />}
                </label>
                <textarea
                  className="input" rows={3}
                  value={form.rollback_plan}
                  onChange={(e) => setForm({ ...form, rollback_plan: e.target.value })}
                  placeholder="How this change is reversed if it fails."
                />
                {fieldRules.getError('rollback_plan') && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('rollback_plan')}</p>}
                <p className="mt-1 text-[11px] text-slate-500 dark:text-slate-400">
                  Implementation cannot start without one on a {form.change_type || 'normal'} change.
                </p>
              </div>
            )}

            <div>
              <label className="label">Test plan{selectedChangeType?.requires_test_plan && <Required />}</label>
              <textarea
                className="input" rows={2}
                value={form.test_plan}
                onChange={(e) => setForm({ ...form, test_plan: e.target.value })}
                placeholder="How you will confirm the change worked."
              />
            </div>

            {(showPlannedStart || showPlannedEnd) && (
              <div className="grid sm:grid-cols-2 gap-3">
                {showPlannedStart && (
                  <div>
                    <label className="label">Requested start{fieldRules.isRequired('planned_start') && <Required />}</label>
                    <input type="datetime-local" className="input" required={fieldRules.isRequired('planned_start')} value={form.planned_start} onChange={(e) => setForm({ ...form, planned_start: e.target.value })} />
                    {fieldRules.getError('planned_start') && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('planned_start')}</p>}
                  </div>
                )}
                {showPlannedEnd && (
                  <div>
                    <label className="label">Requested end{fieldRules.isRequired('planned_end') && <Required />}</label>
                    <input type="datetime-local" className="input" required={fieldRules.isRequired('planned_end')} value={form.planned_end} onChange={(e) => setForm({ ...form, planned_end: e.target.value })} />
                    {fieldRules.getError('planned_end') && <p className="text-xs text-red-600 mt-1">{fieldRules.getError('planned_end')}</p>}
                  </div>
                )}
              </div>
            )}
            <p className="text-[11px] text-slate-500 dark:text-slate-400">
              The window actually reserved on the change calendar is confirmed after approval, once it has been checked for conflicts and change freezes.
            </p>
          </div>
        )}
      </form>
    </Modal>
  );
}
