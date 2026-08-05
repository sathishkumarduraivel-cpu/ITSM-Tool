import { useEffect, useState } from 'react';
import { Plus, Loader2, Timer, Trash2, AlertTriangle, Pencil } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function PolicyModal({ initial, onClose, onSaved }) {
  const [form, setForm] = useState({
    name: initial?.name || '', priority: initial?.priority || '', category: initial?.category || '', team: initial?.team || '',
    response_minutes: initial?.response_minutes ?? 60, resolution_minutes: initial?.resolution_minutes ?? 1440,
    business_hours_only: initial ? !!initial.business_hours_only : false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (initial?.id) await api.patch(`/sla/policies/${initial.id}`, form);
      else await api.post('/sla/policies', form);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit SLA policy' : 'New SLA policy'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Name</label>
          <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Priority (optional)</label>
            <select className="input" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              <option value="">Any</option>
              {['low', 'medium', 'high', 'critical'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Category (optional)</label>
            <input className="input" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
          </div>
          <div>
            <label className="label">Team (optional)</label>
            <input className="input" value={form.team} onChange={(e) => setForm({ ...form, team: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Response target (minutes)</label>
            <input type="number" className="input" value={form.response_minutes} onChange={(e) => setForm({ ...form, response_minutes: Number(e.target.value) })} />
          </div>
          <div>
            <label className="label">Resolution target (minutes)</label>
            <input type="number" className="input" value={form.resolution_minutes} onChange={(e) => setForm({ ...form, resolution_minutes: Number(e.target.value) })} />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
          <input type="checkbox" checked={form.business_hours_only} onChange={(e) => setForm({ ...form, business_hours_only: e.target.checked })} />
          Count only business hours toward this SLA
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

export default function SlaPolicies() {
  const [policies, setPolicies] = useState([]);
  const [businessHours, setBusinessHours] = useState(
    DAYS.map((_, i) => ({ day_of_week: i, enabled: i >= 1 && i <= 5, start_time: '09:00', end_time: '17:00' }))
  );
  const [atRisk, setAtRisk] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | policy
  const [savingHours, setSavingHours] = useState(false);

  const load = async () => {
    setLoading(true);
    const [pol, risk, hours] = await Promise.all([
      api.get('/sla/policies'),
      api.get('/sla/at-risk'),
      api.get('/sla/business-hours'),
    ]);
    setPolicies(pol.policies);
    setAtRisk(risk.tickets);
    if (hours.businessHours.length) {
      setBusinessHours(DAYS.map((_, i) => {
        const existing = hours.businessHours.find((h) => h.day_of_week === i);
        return existing ? { ...existing, enabled: true } : { day_of_week: i, enabled: false, start_time: '09:00', end_time: '17:00' };
      }));
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const remove = async (id) => {
    if (!confirm('Delete this policy?')) return;
    await api.del(`/sla/policies/${id}`);
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
        description="Response & resolution targets, business hours, breach risk"
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

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}

      <div className="card overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Name</th>
              <th className="text-left px-4 py-2.5 font-medium">Matches</th>
              <th className="text-left px-4 py-2.5 font-medium">Response</th>
              <th className="text-left px-4 py-2.5 font-medium">Resolution</th>
              <th className="text-left px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {!loading && policies.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-slate-400"><Timer className="mx-auto mb-1 text-slate-300" size={22} /> No custom policies — a flat default applies.</td></tr>
            )}
            {policies.map((p) => (
              <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">{p.name}</td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300 text-xs">
                  {[p.priority && `priority=${p.priority}`, p.category && `category=${p.category}`, p.team && `team=${p.team}`].filter(Boolean).join(', ') || 'any ticket'}
                </td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{p.response_minutes}m</td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{p.resolution_minutes}m</td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button onClick={() => setModal(p)} className="text-slate-400 hover:text-brand-600"><Pencil size={14} /></button>
                    <button onClick={() => remove(p.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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

      {modal && <PolicyModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />}
    </div>
  );
}
