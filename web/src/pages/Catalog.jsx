import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, Loader2, ShoppingBag, Settings, Trash2, CheckCircle2, Pencil, Paperclip, X } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { hasPermission } from '../lib/permissions.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import Select from '../components/Select.jsx';

const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'date'];
const SHOW_IF_OPS = [
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'contains', label: 'contains' },
  { value: 'in', label: 'is one of (comma list)' },
];

// Same 4-op vocabulary as routes/catalog.js's server-side re-check (and
// Business Rules / the automation engine's condition nodes) -- one condition
// language everywhere in the app, and this is what the server re-evaluates
// on submit too, so a field hidden here can never sneak a value through.
function matchShowIf(actual, op, expected) {
  const a = actual === undefined || actual === null ? '' : actual;
  switch (op) {
    case 'equals': return String(a) === String(expected ?? '');
    case 'not_equals': return String(a) !== String(expected ?? '');
    case 'contains': return String(a).toLowerCase().includes(String(expected || '').toLowerCase());
    case 'in': return String(expected || '').split(',').map((s) => s.trim().toLowerCase()).includes(String(a).toLowerCase());
    default: return true;
  }
}
function fieldVisible(f, formData) {
  if (!f.show_if) return true;
  return matchShowIf(formData[f.show_if.field], f.show_if.op, f.show_if.value);
}

function RequestModal({ item, onClose, onSubmitted }) {
  const [formData, setFormData] = useState({});
  const [files, setFiles] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const schema = item.form_schema || [];
  const visibleSchema = schema.filter((f) => fieldVisible(f, formData));
  const showAttachments = item.allow_attachments ?? true;

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    // The dropdown field below is a custom component, not a native <select>,
    // so it can't rely on the browser's own HTML5 `required` validation the
    // way the plain text/textarea/number/date fields on this same form
    // still do -- checked explicitly here instead so a required dropdown
    // can't silently be skipped. Only a currently-VISIBLE field can block
    // submission -- one hidden by its own show_if can't legitimately be
    // required right now (routes/catalog.js strips its value either way).
    const missingField = visibleSchema.find((f) => f.required && f.type === 'select' && !formData[f.key]);
    if (missingField) {
      setError(`${missingField.label} is required.`);
      return;
    }
    if (showAttachments && item.require_attachment && files.length === 0) {
      setError('At least one attachment is required for this item.');
      return;
    }
    setSaving(true);
    try {
      const { ticket } = await api.post(`/catalog/items/${item.id}/request`, { form_data: formData });
      if (files.length) {
        const uploadData = new FormData();
        for (const f of files) uploadData.append('files', f);
        await api.upload(`/tickets/${ticket.id}/attachments`, uploadData).catch(() => {});
      }
      onSubmitted(ticket);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={item.name} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-500">{item.description}</p>
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        {visibleSchema.map((f) => (
          <div key={f.key}>
            <label className="label">{f.label}{f.required && ' *'}</label>
            {f.type === 'textarea' ? (
              <textarea className="input" rows={3} required={f.required} onChange={(e) => setFormData({ ...formData, [f.key]: e.target.value })} />
            ) : f.type === 'select' ? (
              <Select
                placeholder="Select…" value={formData[f.key] || ''} onChange={(v) => setFormData({ ...formData, [f.key]: v })}
                options={(f.options || '').split(',').map((o) => o.trim()).filter(Boolean)}
              />
            ) : (
              <input className="input" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} required={f.required} onChange={(e) => setFormData({ ...formData, [f.key]: e.target.value })} />
            )}
          </div>
        ))}
        {showAttachments && (
          <div>
            <label className="label">Attachments{item.require_attachment && ' *'}</label>
            <div className="space-y-1.5">
              {files.map((f, i) => (
                <div key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 text-sm bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
                  <span className="flex items-center gap-2 min-w-0"><Paperclip size={13} className="shrink-0 text-slate-400" /><span className="truncate">{f.name}</span></span>
                  <button type="button" onClick={() => setFiles((fs) => fs.filter((_, idx) => idx !== i))} className="text-slate-400 hover:text-red-500 shrink-0"><X size={14} /></button>
                </div>
              ))}
              <label className="btn-secondary text-xs cursor-pointer inline-flex">
                <Paperclip size={13} /> Attach files
                <input type="file" multiple className="hidden" onChange={(e) => setFiles((fs) => [...fs, ...Array.from(e.target.files || [])])} />
              </label>
            </div>
          </div>
        )}
        {item.approval_required ? (
          <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-500/10 rounded-lg px-3 py-2">This request requires manager approval before work begins.</p>
        ) : (
          <p className="text-xs text-emerald-600 bg-emerald-50 dark:bg-emerald-500/10 rounded-lg px-3 py-2">No approval needed — this goes straight to the queue.</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Submit request
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CategoryModal({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const submit = async (e) => {
    e.preventDefault();
    if (initial?.id) await api.patch(`/catalog/categories/${initial.id}`, { name });
    else await api.post('/catalog/categories', { name });
    onSaved();
  };
  return (
    <Modal title={initial?.id ? 'Edit category' : 'New category'} onClose={onClose} maxWidth="max-w-sm">
      <form onSubmit={submit} className="space-y-3">
        <input className="input" required placeholder="e.g. Hardware" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-secondary">Cancel</button><button className="btn-primary">Save</button></div>
      </form>
    </Modal>
  );
}

function ItemModal({ initial, categories, groups, agents, onClose, onSaved }) {
  const [form, setForm] = useState({
    category_id: initial?.category_id || categories[0]?.id || '',
    name: initial?.name || '',
    description: initial?.description || '',
    approval_required: initial ? !!initial.approval_required : true,
    approver_type: initial?.approver_type || 'role',
    approver_role: initial?.approver_role || 'admin',
    approver_id: initial?.approver_id || '',
    approver_group_id: initial?.approver_group_id || '',
    default_priority: initial?.default_priority || 'medium',
    allow_attachments: initial ? (initial.allow_attachments ?? true) : true,
    require_attachment: initial ? !!initial.require_attachment : false,
  });
  const [fields, setFields] = useState(initial?.form_schema?.length ? initial.form_schema : [{ key: 'reason', label: 'Reason', type: 'text', required: true, options: '' }]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const addField = () => setFields([...fields, { key: '', label: '', type: 'text', required: false, options: '' }]);
  const updateField = (i, patch) => setFields(fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const removeField = (i) => setFields(fields.filter((_, idx) => idx !== i));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const payload = { ...form, form_schema: fields.filter((f) => f.key) };
      if (initial?.id) await api.patch(`/catalog/items/${initial.id}`, payload);
      else await api.post('/catalog/items', payload);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit catalog item' : 'New catalog item'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Category</label>
            <Select value={form.category_id} onChange={(v) => setForm({ ...form, category_id: v })} options={categories.map((c) => ({ value: c.id, label: c.name }))} />
          </div>
          <div>
            <label className="label">Name</label>
            <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Default priority</label>
            <Select value={form.default_priority} onChange={(v) => setForm({ ...form, default_priority: v })} options={['low', 'medium', 'high', 'critical']} />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300 mt-6">
            <input type="checkbox" checked={form.approval_required} onChange={(e) => setForm({ ...form, approval_required: e.target.checked })} />
            Requires approval
          </label>
        </div>

        {form.approval_required && (
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 dark:border-slate-700 p-3">
            <div>
              <label className="label">Approver</label>
              <Select
                value={form.approver_type} onChange={(v) => setForm({ ...form, approver_type: v })}
                options={[
                  { value: 'role', label: 'Anyone with a role' },
                  { value: 'user', label: 'A specific person' },
                  { value: 'group_manager', label: "A group's manager" },
                ]}
              />
            </div>
            <div>
              <label className="label">&nbsp;</label>
              {form.approver_type === 'role' && (
                <Select value={form.approver_role} onChange={(v) => setForm({ ...form, approver_role: v })} options={[{ value: 'admin', label: 'Admin' }, { value: 'agent', label: 'Agent' }]} />
              )}
              {form.approver_type === 'user' && (
                <Select placeholder="Select person…" value={form.approver_id} onChange={(v) => setForm({ ...form, approver_id: v })} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
              )}
              {form.approver_type === 'group_manager' && (
                <Select placeholder="Select group…" value={form.approver_group_id} onChange={(v) => setForm({ ...form, approver_group_id: v })} options={groups.map((g) => ({ value: g.id, label: g.name }))} />
              )}
            </div>
          </div>
        )}

        <div className="flex items-center gap-4 -mt-1">
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
            <input
              type="checkbox"
              checked={form.allow_attachments}
              onChange={(e) => setForm({ ...form, allow_attachments: e.target.checked, require_attachment: e.target.checked ? form.require_attachment : false })}
            />
            <Paperclip size={13} className="text-slate-400" /> Allow attachments
          </label>
          <label className={`flex items-center gap-2 text-sm ${form.allow_attachments ? 'text-slate-600 dark:text-slate-300' : 'text-slate-300 dark:text-slate-600'}`}>
            <input type="checkbox" disabled={!form.allow_attachments} checked={form.require_attachment} onChange={(e) => setForm({ ...form, require_attachment: e.target.checked })} />
            Require at least one
          </label>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="label mb-0">Request form fields</label>
            <button type="button" onClick={addField} className="text-xs text-brand-600 font-medium">+ Add field</button>
          </div>
          <div className="space-y-2">
            {fields.map((f, i) => {
              const otherFields = fields.filter((of, oi) => oi !== i && of.key);
              return (
                <div key={i} className="border border-slate-200 dark:border-slate-700 rounded-lg p-2 space-y-1.5">
                  <div className="flex gap-2 items-center">
                    <input className="input" placeholder="key" value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} />
                    <input className="input" placeholder="Label" value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} />
                    <Select className="w-auto" value={f.type} onChange={(v) => updateField(i, { type: v })} options={FIELD_TYPES} />
                    {f.type === 'select' && (
                      <input className="input" placeholder="opt1,opt2" value={f.options} onChange={(e) => updateField(i, { options: e.target.value })} />
                    )}
                    <button type="button" onClick={() => removeField(i)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={15} /></button>
                  </div>
                  {f.show_if ? (
                    <div className="flex gap-1.5 items-center pl-1">
                      <span className="text-[11px] text-slate-400 shrink-0">Only show if</span>
                      <Select
                        size="xs" value={f.show_if.field} onChange={(v) => updateField(i, { show_if: { ...f.show_if, field: v } })}
                        options={otherFields.map((of) => ({ value: of.key, label: of.label || of.key }))}
                      />
                      <Select size="xs" className="w-auto" value={f.show_if.op} onChange={(v) => updateField(i, { show_if: { ...f.show_if, op: v } })} options={SHOW_IF_OPS} />
                      <input className="input py-1 text-xs" placeholder="value" value={f.show_if.value} onChange={(e) => updateField(i, { show_if: { ...f.show_if, value: e.target.value } })} />
                      <button type="button" onClick={() => updateField(i, { show_if: null })} className="text-slate-400 hover:text-red-500 shrink-0" title="Remove condition"><X size={13} /></button>
                    </div>
                  ) : otherFields.length > 0 && (
                    <button
                      type="button"
                      onClick={() => updateField(i, { show_if: { field: otherFields[0].key, op: 'equals', value: '' } })}
                      className="text-[11px] text-brand-600 hover:text-brand-700 font-medium pl-1"
                    >
                      + Only show conditionally
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Save item'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Catalog() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [groups, setGroups] = useState([]);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [requestItem, setRequestItem] = useState(null);
  const [manageMode, setManageMode] = useState(false);
  const [categoryModal, setCategoryModal] = useState(null); // null | 'new' | category
  const [itemModal, setItemModal] = useState(null); // null | 'new' | item
  const [submitted, setSubmitted] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const [cats, itms] = await Promise.all([api.get('/catalog/categories'), api.get('/catalog/items')]);
      setCategories(cats.categories);
      setItems(itms.items);
    } finally {
      // Without this, a failed request left `loading` stuck true forever --
      // the catalog page permanently stuck on its skeleton with no error.
      setLoading(false);
    }
  };

  // Only needed by the manage-mode item editor (approver_type pickers) --
  // fetched once up front rather than gated behind manageMode so toggling
  // "Manage" on doesn't have a loading flicker the first time.
  useEffect(() => {
    if (!hasPermission(user, 'catalog.manage')) return;
    api.get('/groups').then((r) => setGroups(r.groups)).catch(() => {});
    api.get('/auth/users').then((r) => setAgents(r.users.filter((u) => u.role === 'agent' || u.role === 'admin'))).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, []);

  const removeItem = async (id) => {
    if (!confirm('Remove this catalog item?')) return;
    await api.del(`/catalog/items/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Service Catalog"
        description="Request hardware, software & access — approvals routed automatically"
        actions={hasPermission(user, 'catalog.manage') && (
          <>
            <button onClick={() => setManageMode((m) => !m)} className="btn-secondary"><Settings size={14} /> {manageMode ? 'Done' : 'Manage'}</button>
            {manageMode && <button onClick={() => setCategoryModal('new')} className="btn-secondary"><Plus size={14} /> Category</button>}
            {manageMode && <button onClick={() => setItemModal('new')} className="btn-primary"><Plus size={14} /> Item</button>}
          </>
        )}
      />

      {submitted && (
        <div className="card p-4 bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-800 flex items-center justify-between">
          <span className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2"><CheckCircle2 size={16} /> Request {submitted.number} submitted — {submitted.status === 'pending_approval' ? 'awaiting approval.' : 'now in the queue.'}</span>
          <button onClick={() => navigate(`/tickets/${submitted.id}`)} className="text-sm font-medium text-emerald-700 dark:text-emerald-400 hover:underline">View ticket</button>
        </div>
      )}

      {manageMode && categories.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {categories.map((c) => (
            <button key={c.id} onClick={() => setCategoryModal(c)} className="badge bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700">
              <Pencil size={11} /> {c.name}
            </button>
          ))}
        </div>
      )}

      {loading && <SkeletonRows count={3} />}

      {!loading && items.length === 0 && (
        <EmptyState icon={ShoppingBag} description="No catalog items yet." />
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {items.map((item) => (
          <div key={item.id} className="card p-4 flex flex-col">
            <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 flex items-center justify-center mb-2"><ShoppingBag size={16} /></div>
            <div className="font-medium text-slate-800 dark:text-slate-100">{item.name}</div>
            <div className="text-sm text-slate-500 flex-1 mt-1">{item.description}</div>
            <div className="flex items-center justify-between mt-3">
              <button onClick={() => setRequestItem(item)} className="btn-primary text-xs">Request</button>
              {manageMode && (
                <div className="flex items-center gap-2">
                  <button onClick={() => setItemModal(item)} className="text-slate-400 hover:text-brand-600"><Pencil size={15} /></button>
                  <button onClick={() => removeItem(item.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {requestItem && (
        <RequestModal item={requestItem} onClose={() => setRequestItem(null)} onSubmitted={(ticket) => { setSubmitted(ticket); setRequestItem(null); }} />
      )}
      {categoryModal && <CategoryModal initial={categoryModal === 'new' ? null : categoryModal} onClose={() => setCategoryModal(null)} onSaved={() => { setCategoryModal(null); load(); }} />}
      {itemModal && <ItemModal initial={itemModal === 'new' ? null : itemModal} categories={categories} groups={groups} agents={agents} onClose={() => setItemModal(null)} onSaved={() => { setItemModal(null); load(); }} />}
    </div>
  );
}
