import { useEffect, useState } from 'react';
import { Plus, Loader2, FileText, Trash2, AlertTriangle, ClipboardList, Pencil } from 'lucide-react';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Select from '../components/Select.jsx';

function daysUntil(dateStr) {
  if (!dateStr) return null;
  return Math.round((new Date(dateStr).getTime() - Date.now()) / 86400000);
}

function ContractModal({ initial, onClose, onSaved }) {
  const [form, setForm] = useState({
    vendor: initial?.vendor || '', name: initial?.name || '', type: initial?.type || 'support',
    start_date: initial?.start_date || '', end_date: initial?.end_date || '', value: initial?.value ?? '',
    renewal_notice_days: initial?.renewal_notice_days ?? 30,
  });
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (initial?.id) await api.patch(`/procurement/contracts/${initial.id}`, form);
      else await api.post('/procurement/contracts', form);
      onSaved();
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={initial?.id ? 'Edit contract' : 'New contract'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Vendor</label><input className="input" required value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></div>
          <div><label className="label">Contract name</label><input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
          <div>
            <label className="label">Type</label>
            <Select value={form.type} onChange={(v) => setForm({ ...form, type: v })} options={['support', 'license', 'lease', 'service']} />
          </div>
          <div><label className="label">Value ($)</label><input type="number" className="input" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} /></div>
          <div><label className="label">Start date</label><input type="date" className="input" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} /></div>
          <div><label className="label">End date</label><input type="date" className="input" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} /></div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

function POModal({ initial, onClose, onSaved }) {
  const [form, setForm] = useState({
    po_number: initial?.po_number || '', vendor: initial?.vendor || '', item: initial?.item || '',
    amount: initial?.amount ?? '', status: initial?.status || 'draft',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (initial?.id) await api.patch(`/procurement/purchase-orders/${initial.id}`, form);
      else await api.post('/procurement/purchase-orders', form);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title={initial?.id ? 'Edit purchase order' : 'New purchase order'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">PO number</label><input className="input" required disabled={!!initial?.id} value={form.po_number} onChange={(e) => setForm({ ...form, po_number: e.target.value })} placeholder="PO-1001" /></div>
          <div><label className="label">Vendor</label><input className="input" required value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></div>
          <div className="col-span-2"><label className="label">Item</label><input className="input" required value={form.item} onChange={(e) => setForm({ ...form, item: e.target.value })} /></div>
          <div><label className="label">Amount ($)</label><input type="number" className="input" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></div>
          <div>
            <label className="label">Status</label>
            <Select value={form.status} onChange={(v) => setForm({ ...form, status: v })} options={['draft', 'ordered', 'received', 'cancelled']} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">{saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}

export default function Procurement() {
  const [tab, setTab] = useState('contracts');
  const [contracts, setContracts] = useState([]);
  const [pos, setPos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [contractModal, setContractModal] = useState(null); // null | 'new' | contract
  const [poModal, setPoModal] = useState(null); // null | 'new' | po

  const load = async () => {
    setLoading(true);
    try {
      const [c, p] = await Promise.all([api.get('/procurement/contracts'), api.get('/procurement/purchase-orders')]);
      setContracts(c.contracts);
      setPos(p.purchaseOrders);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const removeContract = async (id) => { await api.del(`/procurement/contracts/${id}`); load(); };
  const removePO = async (id) => { await api.del(`/procurement/purchase-orders/${id}`); load(); };

  return (
    <div className="space-y-4">
      <PageHeader
        title="Contracts & Purchase Orders"
        description="Vendor agreements, renewal tracking, procurement"
        actions={
          <button onClick={() => tab === 'contracts' ? setContractModal('new') : setPoModal('new')} className="btn-primary">
            <Plus size={14} /> {tab === 'contracts' ? 'New contract' : 'New PO'}
          </button>
        }
      />

      <div className="flex gap-2">
        <button onClick={() => setTab('contracts')} className={tab === 'contracts' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}>Contracts</button>
        <button onClick={() => setTab('pos')} className={tab === 'pos' ? 'btn-primary text-xs' : 'btn-secondary text-xs'}>Purchase Orders</button>
      </div>

      {loading && <div className="text-slate-400 text-sm py-10 text-center">Loading…</div>}

      {tab === 'contracts' && !loading && (
        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
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
                  <tr key={c.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">{c.vendor}</td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{c.name}</td>
                    <td className="px-4 py-2.5 capitalize text-slate-600 dark:text-slate-300">{c.type}</td>
                    <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{c.value ? `$${Number(c.value).toLocaleString()}` : '—'}</td>
                    <td className="px-4 py-2.5">
                      {days !== null ? (
                        <span className={`badge ${urgent ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
                          {urgent && <AlertTriangle size={11} />} {days >= 0 ? `${days}d left` : 'expired'}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button onClick={() => setContractModal(c)} className="text-slate-400 hover:text-brand-600"><Pencil size={14} /></button>
                        <button onClick={() => removeContract(c.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'pos' && !loading && (
        <div className="card overflow-hidden overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
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
                <tr key={p.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="px-4 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-300">{p.po_number}</td>
                  <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">{p.vendor}</td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{p.item}</td>
                  <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{p.amount ? `$${Number(p.amount).toLocaleString()}` : '—'}</td>
                  <td className="px-4 py-2.5"><span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 capitalize">{p.status}</span></td>
                  <td className="px-4 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => setPoModal(p)} className="text-slate-400 hover:text-brand-600"><Pencil size={14} /></button>
                      <button onClick={() => removePO(p.id)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {contractModal && <ContractModal initial={contractModal === 'new' ? null : contractModal} onClose={() => setContractModal(null)} onSaved={() => { setContractModal(null); load(); }} />}
      {poModal && <POModal initial={poModal === 'new' ? null : poModal} onClose={() => setPoModal(null)} onSaved={() => { setPoModal(null); load(); }} />}
    </div>
  );
}
