import { useEffect, useState } from 'react';
import { Plus, X, Loader2, FileText, Trash2, AlertTriangle, ClipboardList } from 'lucide-react';
import { api } from '../lib/api.js';

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function NewContractModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ vendor: '', name: '', type: 'support', start_date: '', end_date: '', value: '', renewal_notice_days: 30 });
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/procurement/contracts', form);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-lg p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-slate-800">New contract</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Vendor</label><input className="input" required value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></div>
          <div><label className="label">Contract name</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div>
            <label className="label">Type</label>
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {['support', 'license', 'lease', 'service'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div><label className="label">Value ($)</label><input type="number" className="input" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></div>
          <div><label className="label">Start date</label><input type="date" className="input" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></div>
          <div><label className="label">End date</label><input type="date" className="input" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save</button>
        </div>
      </form>
    </div>
  );
}

function NewPOModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ po_number: '', vendor: '', item: '', amount: '', status: 'draft' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post('/procurement/purchase-orders', form);
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
          <h2 className="font-semibold text-slate-800">New purchase order</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">PO number</label><input className="input" required value={form.po_number} onChange={(e) => setForm({ ...form, po_number: e.target.value })} placeholder="PO-1001" /></div>
          <div><label className="label">Vendor</label><input className="input" required value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></div>
          <div className="col-span-2"><label className="label">Item</label><input className="input" required value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} /></div>
          <div><label className="label">Amount ($)</label><input type="number" className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {['draft', 'ordered', 'received', 'cancelled'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Save</button>
        </div>
      </form>
    </div>
  );
}

export default function Procurement() {
  const [tab, setTab] = useState('contracts');
  const [contracts, setContracts] = useState([]);
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNewContract, setShowNewContract] = useState(false);
  const [showNewPO, setShowNewPO] = useState(false);

  const load = async () => {
    setLoading(true);
    const [c, p] = await Promise.all([api.get('/procurement/contracts'), api.get('/procurement/purchase-orders')]);
    setContracts(c.contracts);
    setPos(p.purchaseOrders);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const removeContract = async (id) => { await api.del(`/procurement/contracts/${id}`); load(); };
  const removePO = async (id) => { await api.del(`/procurement/purchase-orders/${id}`); load(); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Contracts &amp; Purchase Orders</h1>
          <p className="text-sm text-slate-500">Vendor agreements, renewal tracking, procurement</p>
        </div>
        <button onClick={() => tab === 'contracts' ? setShowNewContract(true) : setShowNewPO(true)} className="btn-primary">
          <Plus size={14} /> {tab === 'contracts' ? 'New contract' : 'New PO'}
        </button>
      </div>

      <div className="flex gap-2">
        <button onClick={() => setTab('contracts')} className={tab === 'contracts' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}>Contracts</button>
        <button onClick={() => setTab('pos')} className={tab === 'pos' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}>Purchase Orders</button>
      </div>

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}

      {tab === 'contracts' && !loading && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">Vendor</th>
                <th className="text-left px-4 py-2.5 font-medium">Contract</th>
                <th className="text-left px-4 py-2.5 font-medium">Type</th>
                <th className="text-left px-4 py-2.5 font-medium">Value</th>
                <th className="text-left px-4 py-2.5 font-medium">Renewal</th>
                <th className="text-left px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {contracts.length === 0 && (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400"><FileText className="mx-auto mb-2 text-slate-300" size={26} /> No contracts yet.</td></tr>
              )}
              {contracts.map((c) => {
                const days = daysUntil(c.end_date);
                const urgent = days !== null && days <= c.renewal_notice_days;
                return (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-4 py-2.5 font-medium text-slate-800">{c.vendor}</td>
                    <td className="px-4 py-2.5 text-slate-600">{c.name}</td>
                    <td className="px-4 py-2.5 capitalize text-slate-600">{c.type}</td>
                    <td className="px-4 py-2.5 text-slate-600">{c.value ? `$${Number(c.value).toLocaleString()}` : '—'}</td>
                    <td className="px-4 py-2.5">
                      {days !== null ? (
                        <span className={`badge ${urgent ? 'bg-red-50 text-red-600' : 'bg-slate-100 text-slate-600'}`}>
                          {urgent && <AlertTriangle size={11} />} {days >= 0 ? `${days}d left` : 'expired'}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right"><button onClick={() => removeContract(c.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'pos' && !loading && (
        <div className="card overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium">PO #</th>
                <th className="text-left px-4 py-2.5 font-medium">Vendor</th>
                <th className="text-left px-4 py-2.5 font-medium">Item</th>
                <th className="text-left px-4 py-2.5 font-medium">Amount</th>
                <th className="text-left px-4 py-2.5 font-medium">Status</th>
                <th className="text-left px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {pos.length === 0 && (
                <tr><td colSpan={6} className="text-center py-10 text-slate-400"><ClipboardList className="mx-auto mb-2 text-slate-300" size={26} /> No purchase orders yet.</td></tr>
              )}
              {pos.map((p) => (
                <tr key={p.id} className="border-t border-slate-100">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{p.po_number}</td>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{p.vendor}</td>
                  <td className="px-4 py-2.5 text-slate-600">{p.item}</td>
                  <td className="px-4 py-2.5 text-slate-600">{p.amount ? `$${Number(p.amount).toLocaleString()}` : '—'}</td>
                  <td className="px-4 py-2.5"><span className="badge bg-slate-100 text-slate-600 capitalize">{p.status}</span></td>
                  <td className="px-4 py-2.5 text-right"><button onClick={() => removePO(p.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showNewContract && <NewContractModal onClose={() => setShowNewContract(false)} onSaved={() => { setShowNewContract(false); load(); }} />}
      {showNewPO && <NewPOModal onClose={() => setShowNewPO(false)} onSaved={() => { setShowNewPO(false); load(); }} />}
    </div>
  );
}
