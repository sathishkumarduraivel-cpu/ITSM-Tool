import { useEffect, useState } from 'react';
import { Plus, X, Loader2, Timer, Trash2, AlertTriangle } from 'lucide-react';
import { api } from '../lib/api.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function NewPolicyModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', priority: '', category: '', team: '', response_minutes: 60, resolution_minutes: 1440, business_hours_only: false });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/sla/policies', form);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">New SLA policy</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
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
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input type="checkbox" checked={form.business_hours_only} onChange={(e) => setForm({ ...form, business_hours_only: e.target.checked })} />
          Count only business hours toward this SLA
        </label>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save policy
          </button>
        </div>
      </form>
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
  const [showNew, setShowNew] = useState(false);
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">SLA Policies</h1>
          <p className="text-sm text-slate-500">Response &amp; resolution targets, business hours, breach risk</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New policy</button>
      </div>

      {atRisk.length > 0 && (
        <div className="card p-4 bg-red-50 border-red-100">
          <h3 className="text-sm font-semibold text-red-700 mb-2 flex items-center gap-1.5"><AlertTriangle size={14} /> {atRisk.length} ticket(s) at risk or breached</h3>
          <div className="space-y-1">
            {atRisk.slice(0, 6).map((t) => (
              <div key={t.id} className="text-sm text-red-700 flex items-center justify-between">
                <span>{t.number} — {t.title}</span>
                <span className="text-xs">{new Date(t.sla_due_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
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
              <tr key={p.id} className="border-t border-slate-100">
                <td className="px-4 py-2.5 font-medium text-slate-800">{p.name}</td>
                <td className="px-4 py-2.5 text-slate-600 text-xs">
                  {[p.priority && `priority=${p.priority}`, p.category && `category=${p.category}`, p.team && `team=${p.team}`].filter(Boolean).join(', ') || 'any ticket'}
                </td>
                <td className="px-4 py-2.5 text-slate-600">{p.response_minutes}m</td>
                <td className="px-4 py-2.5 text-slate-600">{p.resolution_minutes}m</td>
                <td className="px-4 py-2.5 text-right"><button onClick={() => remove(p.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">Business hours (used when a policy has "business hours only" checked)</h3>
        <div className="space-y-2">
          {businessHours.map((h, i) => (
            <div key={i} className="flex items-center gap-3">
              <label className="flex items-center gap-2 w-24 text-sm text-slate-600">
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

      {showNew && <NewPolicyModal onClose={() => setShowNew(false)} onSaved={() => { setShowNew(false); load(); }} />}
    </div>
  );
}
