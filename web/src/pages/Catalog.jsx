import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X, Loader2, ShoppingBag, Settings, Trash2, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';

const FIELD_TYPES = ['text', 'textarea', 'select', 'number', 'date'];

function RequestModal({ item, onClose, onSubmitted }) {
  const [formData, setFormData] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const schema = item.form_schema || [];

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { ticket } = await api.post(`/catalog/items/${item.id}/request`, { form_data: formData });
      onSubmitted(ticket);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-md p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">{item.name}</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <p className="text-sm text-slate-500">{item.description}</p>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
        {schema.map((f) => (
          <div key={f.key}>
            <label className="label">{f.label}{f.required && ' *'}</label>
            {f.type === 'textarea' ? (
              <textarea className="input" rows={3} required={f.required} onChange={(e) => setFormData({ ...formData, [f.key]: e.target.value })} />
            ) : f.type === 'select' ? (
              <select className="input" required={f.required} onChange={(e) => setFormData({ ...formData, [f.key]: e.target.value })}>
                <option value="">Select…</option>
                {(f.options || '').split(',').map((o) => o.trim()).filter(Boolean).map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <input className="input" type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} required={f.required} onChange={(e) => setFormData({ ...formData, [f.key]: e.target.value })} />
            )}
          </div>
        ))}
        {item.approval_required ? (
          <p className="text-xs text-amber-600 bg-amber-50 rounded-lg px-3 py-2">This request requires manager approval before work begins.</p>
        ) : (
          <p className="text-xs text-emerald-600 bg-emerald-50 rounded-lg px-3 py-2">No approval needed — this goes straight to the queue.</p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Submit request
          </button>
        </div>
      </form>
    </div>
  );
}

function ManageCategoryModal({ onClose, onSaved }) {
  const [name, setName] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    await api.post('/catalog/categories', { name });
    onSaved();
  };
  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-sm p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">New category</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <input className="input" required placeholder="e.g. Hardware" value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-secondary">Cancel</button><button className="btn-primary">Save</button></div>
      </form>
    </div>
  );
}

function ManageItemModal({ categories, onClose, onSaved }) {
  const [form, setForm] = useState({ category_id: categories[0]?.id || '', name: '', description: '', approval_required: true, approver_role: 'admin', default_priority: 'medium' });
  const [fields, setFields] = useState([{ key: 'reason', label: 'Reason', type: 'text', required: true, options: '' }]);
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
      await api.post('/catalog/items', { ...form, form_schema: fields.filter((f) => f.key) });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4 py-8 overflow-y-auto">
      <form onSubmit={submit} className="card w-full max-w-lg p-5 space-y-3 my-auto">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">New catalog item</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Category</label>
            <select className="input" value={form.category_id} onChange={(e) => setForm({ ...form, category_id: e.target.value })}>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
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
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Default priority</label>
            <select className="input" value={form.default_priority} onChange={(e) => setForm({ ...form, default_priority: e.target.value })}>
              {['low', 'medium', 'high', 'critical'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Approver role</label>
            <select className="input" value={form.approver_role} onChange={(e) => setForm({ ...form, approver_role: e.target.value })}>
              <option value="admin">Admin</option>
              <option value="agent">Agent</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600 mt-6">
            <input type="checkbox" checked={form.approval_required} onChange={(e) => setForm({ ...form, approval_required: e.target.checked })} />
            Requires approval
          </label>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="label mb-0">Request form fields</label>
            <button type="button" onClick={addField} className="text-xs text-brand-600 font-medium">+ Add field</button>
          </div>
          <div className="space-y-2">
            {fields.map((f, i) => (
              <div key={i} className="flex gap-2 items-center">
                <input className="input" placeholder="key" value={f.key} onChange={(e) => updateField(i, { key: e.target.value })} />
                <input className="input" placeholder="Label" value={f.label} onChange={(e) => updateField(i, { label: e.target.value })} />
                <select className="input w-auto" value={f.type} onChange={(e) => updateField(i, { type: e.target.value })}>
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                {f.type === 'select' && (
                  <input className="input" placeholder="opt1,opt2" value={f.options} onChange={(e) => updateField(i, { options: e.target.value })} />
                )}
                <button type="button" onClick={() => removeField(i)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save item
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Catalog() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [categories, setCategories] = useState([]);
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [requestItem, setRequestItem] = useState(null);
  const [manageMode, setManageMode] = useState(false);
  const [newCategory, setNewCategory] = useState(false);
  const [newItem, setNewItem] = useState(false);
  const [submitted, setSubmitted] = useState(null);

  const load = async () => {
    setLoading(true);
    const [cats, itms] = await Promise.all([api.get('/catalog/categories'), api.get('/catalog/items')]);
    setCategories(cats.categories);
    setItems(itms.items);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const removeItem = async (id) => {
    if (!confirm('Remove this catalog item?')) return;
    await api.del(`/catalog/items/${id}`);
    load();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Service Catalog</h1>
          <p className="text-sm text-slate-500">Request hardware, software &amp; access — approvals routed automatically</p>
        </div>
        {(user.role === 'admin') && (
          <div className="flex gap-2">
            <button onClick={() => setManageMode((m) => !m)} className="btn-secondary"><Settings size={14} /> {manageMode ? 'Done' : 'Manage'}</button>
            {manageMode && <button onClick={() => setNewCategory(true)} className="btn-secondary"><Plus size={14} /> Category</button>}
            {manageMode && <button onClick={() => setNewItem(true)} className="btn-primary"><Plus size={14} /> Item</button>}
          </div>
        )}
      </div>

      {submitted && (
        <div className="card p-4 bg-emerald-50 border-emerald-200 flex items-center justify-between">
          <span className="text-sm text-emerald-700 flex items-center gap-2"><CheckCircle2 size={16} /> Request {submitted.number} submitted — {submitted.status === 'pending_approval' ? 'awaiting approval.' : 'now in the queue.'}</span>
          <button onClick={() => navigate(`/tickets/${submitted.id}`)} className="text-sm font-medium text-emerald-700 hover:underline">View ticket</button>
        </div>
      )}

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}

      {!loading && items.length === 0 && (
        <div className="card p-10 text-center text-slate-400">
          <ShoppingBag className="mx-auto mb-2 text-slate-300" size={28} /> No catalog items yet.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {items.map((item) => (
          <div key={item.id} className="card p-4 flex flex-col">
            <div className="w-9 h-9 rounded-lg bg-brand-50 text-brand-600 flex items-center justify-center mb-2"><ShoppingBag size={16} /></div>
            <div className="font-medium text-slate-800">{item.name}</div>
            <div className="text-sm text-slate-500 flex-1 mt-1">{item.description}</div>
            <div className="flex items-center justify-between mt-3">
              <button onClick={() => setRequestItem(item)} className="btn-primary text-xs">Request</button>
              {manageMode && (
                <button onClick={() => removeItem(item.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
              )}
            </div>
          </div>
        ))}
      </div>

      {requestItem && (
        <RequestModal item={requestItem} onClose={() => setRequestItem(null)} onSubmitted={(ticket) => { setSubmitted(ticket); setRequestItem(null); }} />
      )}
      {newCategory && <ManageCategoryModal onClose={() => setNewCategory(false)} onSaved={() => { setNewCategory(false); load(); }} />}
      {newItem && <ManageItemModal categories={categories} onClose={() => setNewItem(false)} onSaved={() => { setNewItem(false); load(); }} />}
    </div>
  );
}
