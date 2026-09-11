import { useEffect, useState } from 'react';
import { Plus, X, Loader2, Boxes, Link2, Ticket as TicketIcon, Trash2, Pencil } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import Modal from '../components/Modal.jsx';
import PageHeader from '../components/PageHeader.jsx';
import Select from '../components/Select.jsx';

const REL_TYPES = ['depends_on', 'hosted_on', 'connected_to'];

function AssetDetailModal({ asset, allAssets, onClose, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [relTarget, setRelTarget] = useState('');
  const [relType, setRelType] = useState('depends_on');
  const navigate = useNavigate();

  const load = async () => {
    setLoadError('');
    try {
      const data = await api.get(`/assets/${asset.id}/detail`);
      setDetail(data);
    } catch (e) {
      // Without this catch, a failed fetch left `detail` null forever and
      // the `if (!detail) return null` below rendered NOTHING at all --
      // clicking an asset row silently did nothing, with no error, no
      // spinner, and no way to dismiss it.
      setLoadError(e.message);
    }
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

  if (!detail) {
    return (
      <div className="fixed inset-0 bg-slate-900/40 dark:bg-slate-950/60 flex items-center justify-center z-50 px-4 py-8" onClick={onClose}>
        <div className="card w-full max-w-sm p-5 text-center space-y-3" onClick={(e) => e.stopPropagation()}>
          {loadError ? (
            <>
              <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
              <div className="flex items-center justify-center gap-2">
                <button onClick={onClose} className="btn-secondary text-xs">Close</button>
                <button onClick={load} className="btn-primary text-xs">Retry</button>
              </div>
            </>
          ) : (
            <p className="text-sm text-slate-400 flex items-center justify-center gap-2"><Loader2 size={14} className="animate-spin" /> Loading…</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-slate-900/40 dark:bg-slate-950/60 flex items-center justify-center z-50 px-4 py-8 overflow-y-auto" onClick={onClose}>
      <div className="card w-full max-w-2xl p-5 space-y-4 my-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold text-slate-800 dark:text-slate-100">{asset.name}</h2>
            <span className="font-mono text-xs text-slate-400">{asset.tag}</span>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={18} /></button>
        </div>

        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-1.5"><Link2 size={14} /> Depends on</h3>
          <div className="space-y-1">
            {detail.dependsOn.length === 0 && <p className="text-xs text-slate-400">No dependencies recorded.</p>}
            {detail.dependsOn.map((r) => (
              <div key={r.rel_id} className="flex items-center justify-between text-sm bg-slate-50 dark:bg-slate-800/60 rounded-md px-2 py-1.5">
                <span>{r.name} <span className="text-xs text-slate-400">({r.relationship_type.replace('_', ' ')})</span></span>
                <button onClick={() => removeRelationship(r.rel_id)} className="text-slate-400 hover:text-red-500"><Trash2 size={13} /></button>
              </div>
            ))}
          </div>
          <div className="flex gap-2 mt-2">
            <Select
              value={relTarget}
              onChange={setRelTarget}
              options={[
                { value: '', label: 'Link to asset…' },
                ...allAssets.filter((a) => a.id !== asset.id).map((a) => ({ value: a.id, label: `${a.name} (${a.tag})` })),
              ]}
            />
            <Select
              className="w-auto"
              value={relType}
              onChange={setRelType}
              options={REL_TYPES.map((t) => ({ value: t, label: t.replace('_', ' ') }))}
            />
            <button onClick={addRelationship} className="btn-secondary shrink-0"><Plus size={14} /></button>
          </div>
        </div>

        {detail.dependedOnBy.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Impact — depended on by</h3>
            <div className="space-y-1">
              {detail.dependedOnBy.map((r) => (
                <div key={r.rel_id} className="text-sm bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 rounded-md px-2 py-1.5">
                  {r.name} would be impacted ({r.relationship_type.replace('_', ' ')} this asset)
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-1.5"><TicketIcon size={14} /> Linked tickets</h3>
          {detail.linkedTickets.length === 0 && <p className="text-xs text-slate-400">No tickets linked to this asset.</p>}
          <div className="space-y-1">
            {detail.linkedTickets.map((t) => (
              <button key={t.id} onClick={() => navigate(`/tickets/${t.id}`)} className="w-full text-left text-sm bg-slate-50 dark:bg-slate-800/60 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-md px-2 py-1.5">
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
  in_use: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  in_stock: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
  retired: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  maintenance: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
};

function AssetModal({ initial, onClose, onSaved }) {
  const [form, setForm] = useState({
    tag: initial?.tag || '', name: initial?.name || '', type: initial?.type || 'hardware', status: initial?.status || 'in_stock',
    vendor: initial?.vendor || '', location: initial?.location || '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      if (initial?.id) await api.patch(`/assets/${initial.id}`, form);
      else await api.post('/assets', form);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit asset' : 'New asset'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
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
            <Select value={form.type} onChange={(v) => setForm({ ...form, type: v })} options={TYPES} />
          </div>
          <div>
            <label className="label">Status</label>
            <Select
              value={form.status}
              onChange={(v) => setForm({ ...form, status: v })}
              options={STATUSES.map((s) => ({ value: s, label: s.replace('_', ' ') }))}
            />
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
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {initial?.id ? 'Save changes' : 'Add asset'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function Assets() {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | asset object
  const [detailAsset, setDetailAsset] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const { assets } = await api.get('/assets');
      setAssets(assets);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Assets"
        description="Hardware, software, licenses & services"
        actions={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New asset</button>}
      />

      <div className="card overflow-hidden overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Tag</th>
              <th className="text-left px-4 py-2.5 font-medium">Name</th>
              <th className="text-left px-4 py-2.5 font-medium">Type</th>
              <th className="text-left px-4 py-2.5 font-medium">Status</th>
              <th className="text-left px-4 py-2.5 font-medium">Vendor</th>
              <th className="text-left px-4 py-2.5 font-medium">Location</th>
              <th className="text-left px-4 py-2.5 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={7} className="text-center py-10 text-slate-400">Loading…</td></tr>}
            {!loading && assets.length === 0 && (
              <tr><td colSpan={7} className="text-center py-10 text-slate-400">
                <Boxes className="mx-auto mb-2 text-slate-300" size={28} /> No assets yet.
              </td></tr>
            )}
            {!loading && assets.map((a) => (
              <tr key={a.id} onClick={() => setDetailAsset(a)} className="border-t border-slate-100 dark:border-slate-800 row-interactive">
                <td className="px-4 py-2.5 font-mono text-xs text-slate-600 dark:text-slate-300">{a.tag}</td>
                <td className="px-4 py-2.5 font-medium text-slate-800 dark:text-slate-100">{a.name}</td>
                <td className="px-4 py-2.5 capitalize text-slate-600 dark:text-slate-300">{a.type}</td>
                <td className="px-4 py-2.5"><span className={`badge ${STATUS_STYLES[a.status]}`}>{a.status.replace('_', ' ')}</span></td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{a.vendor || '—'}</td>
                <td className="px-4 py-2.5 text-slate-600 dark:text-slate-300">{a.location || '—'}</td>
                <td className="px-4 py-2.5 text-right">
                  <button onClick={(e) => { e.stopPropagation(); setModal(a); }} className="text-slate-400 hover:text-brand-600"><Pencil size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal && (
        <AssetModal initial={modal === 'new' ? null : modal} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} />
      )}
      {detailAsset && (
        <AssetDetailModal asset={detailAsset} allAssets={assets} onClose={() => setDetailAsset(null)} onChanged={load} />
      )}
    </div>
  );
}
