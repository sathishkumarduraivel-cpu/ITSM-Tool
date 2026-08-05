import { useEffect, useState } from 'react';
import { Plus, X, Loader2, Boxes, Link2, Ticket as TicketIcon, Trash2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';

const REL_TYPES = ['depends_on', 'hosted_on', 'connected_to'];

function AssetDetailModal({ asset, allAssets, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [relTarget, setRelTarget] = useState('');
  const [relType, setRelType] = useState('depends_on');
  const navigate = useNavigate();

  const load = async () => {
    const data = await api.get(`/assets/${asset.id}/detail`);
    setDetail(data);
  };

  useEffect(() => { load(); }, [asset.id]);

  const addRelationship = async () => {
    if (!relTarget) return;
    await api.post(`/assets/${asset.id}/relationships`, { related_asset_id: relTarget, relationship_type: relType });
    setRelTarget('');
    load();
    onChanged();
  };

  const removeRelationship = async (relId) => {
    await api.del(`/assets/relationships/${relId}`);
    load();
    onChanged();
  };

  if (!detail) return null;

  return (
    <div className="fixed inset-0 bg-slate-900/40 flex items-center justify-center z-50 px-4 py-8 overflow-y-auto" onClick={onClose}>
      <div className="card w-full max-w-2xl p-5 space-y-4 my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-slate-800">{asset.name}</h2>
            <span className="font-mono text-xs text-slate-400">{asset.tag}</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5"><Link2 size={14} /> Depends on</h3>
          <div className="space-y-1">
            {detail.dependsOn.length === 0 && <p className="text-xs text-slate-400">No dependencies recorded.</p>}
            {detail.dependsOn.map((r) => (
              <div key={r.rel_id} className="flex items-center justify-between text-sm bg-slate-50 rounded-md px-2 py-1.5">
                <span>{r.name} <span className="text-xs text-slate-400">({r.relationship_type.replace('_', ' ')})</span></span>
                <button onClick={() => removeRelationship(r.rel_id)} className="text-slate-400 hover:text-red-500"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <select className="input" value={relTarget} onChange={(e) => setRelTarget(e.target.value)}>
              <option value="">Link to asset…</option>
              {allAssets.filter((a) => a.id !== asset.id).map((a) => <option key={a.id} value={a.id}>{a.name} ({a.tag})</option>)}
            </select>
            <select className="input w-auto" value={relType} onChange={(e) => setRelType(e.target.value)}>
              {REL_TYPES.map((t) => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
            </select>
            <button onClick={addRelationship} className="btn-secondary shrink-0"><Plus size={14} /></button>
          </div>
        </div>

        {detail.dependedOnBy.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Impact — depended on by</h3>
            <div className="space-y-1">
              {detail.dependedOnBy.map((r) => (
                <div key={r.rel_id} className="text-sm bg-amber-50 text-amber-700 rounded-md px-2 py-1.5">
                  {r.name} would be impacted ({r.relationship_type.replace('_', ' ')} this asset)
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5"><TicketIcon size={14} /> Linked tickets</h3>
          {detail.linkedTickets.length === 0 && <p className="text-xs text-slate-400">No tickets linked to this asset.</p>}
          <div className="space-y-1">
            {detail.linkedTickets.map((t) => (
              <button key={t.id} onClick={() => navigate(`/tickets/${t.id}`)} className="w-full text-left text-sm bg-slate-50 hover:bg-slate-100 rounded-md px-2 py-1.5">
                {t.number} — {t.title}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const TYPES = ['hardware', 'software', 'license', 'service'];
const STATUSES = ['in_use', 'in_stock', 'retired', 'maintenance'];

const STATUS_STYLES = {
  in_use: 'bg-emerald-50 text-emerald-700',
  in_stock: 'bg-brand-50 text-brand-700',
  retired: 'bg-slate-100 text-slate-500',
  maintenance: 'bg-amber-50 text-amber-700',
};

function NewAssetModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ tag: '', name: '', type: 'hardware', status: 'in_stock', vendor: '', location: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { asset } = await api.post('/assets', form);
      onCreated(asset);
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
          <h2 className="font-semibold text-slate-800">New asset</h2>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>
        {error && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Asset tag</label>
            <input className="input" required value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value })} placeholder="e.g. LAP-1099" />
          </div>
          <div>
            <label className="label">Name</label>
            <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <label className="label">Type</label>
            <select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Status</label>
            <select className="input" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {STATUSES.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Vendor</label>
            <input className="input" value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
          </div>
          <div>
            <label className="label">Location</label>
            <input className="input" value={form.location} onChange={(e) => setForm({ ...form, location: e.target.value })} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add asset
          </button>
        </div>
      </form>
    </div>
  );
}

export default function Assets() {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showNew, setShowNew] = useState(false);
  const [detailAsset, setDetailAsset] = useState(null);

  const load = async () => {
    setLoading(true);
    const { assets } = await api.get('/assets');
    setAssets(assets);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Assets</h1>
          <p className="text-sm text-slate-500">Hardware, software, licenses &amp; services</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New asset</button>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Tag</th>
              <th className="text-left px-4 py-2.5 font-medium">Name</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-left px-4 py-2.5 font-medium">Vendor</th>
              <th className="text-left px-4 py-2.5 font-medium">Location</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={6} className="text-center py-10 text-slate-400">Loading…</td></tr>}
            {!loading && assets.length === 0 && (
              <tr><td colSpan={6} className="text-center py-10 text-slate-400">
                <Boxes className="mx-auto mb-2 text-slate-300" size={28} /> No assets yet.
              </td></tr>
            )}
            {!loading && assets.map((a) => (
              <tr key={a.id} onClick={() => setDetailAsset(a)} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer">
                <td className="px-4 py-2.5 font-mono text-xs text-slate-600">{a.tag}</td>
                <td className="px-4 py-2.5 font-medium text-slate-800">{a.name}</td>
                <td className="px-4 py-2.5 capitalize text-slate-600">{a.type}</td>
                <td className="px-4 py-2.5"><span className={`badge ${STATUS_STYLES[a.status]}`}>{a.status.replace('_', ' ')}</span></td>
                <td className="px-4 py-2.5 text-slate-600">{a.vendor || '—'}</td>
                <td className="px-4 py-2.5 text-slate-600">{a.location || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showNew && (
        <NewAssetModal onClose={() => setShowNew(false)} onCreated={() => { setShowNew(false); load(); }} />
      )}
      {detailAsset && (
        <AssetDetailModal asset={detailAsset} allAssets={assets} onClose={() => setDetailAsset(null)} onChanged={load} />
      )}
    </div>
  );
}
