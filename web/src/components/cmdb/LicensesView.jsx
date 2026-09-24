import { useEffect, useState } from 'react';
import { Loader2, Plus, Trash2, KeyRound, AlertTriangle, Check, Info } from 'lucide-react';
import { api } from '../../lib/api.js';
import EmptyState from '../EmptyState.jsx';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import { fmtDateTime } from '../../lib/dates.js';

const STATUS_STYLE = {
  over_deployed: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  exact: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  under_deployed: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  not_applicable: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};
const STATUS_LABEL = {
  over_deployed: 'Over-deployed',
  exact: 'Exactly licensed',
  under_deployed: 'Spare licences',
  not_applicable: 'Not licensed',
};

// Software licence compliance.
//
// The whole screen is built around one number per product: entitled minus
// consumed. How "consumed" is worked out depends on the licensing metric,
// which is why every row shows the basis of its own count -- an audit
// conversation turns on being able to explain the arithmetic, not just assert
// the total.
export default function LicensesView({ isAdmin }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState(null);

  const load = () => api.get('/itam/licenses').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  if (error) return <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>;
  if (!data) return <Loading />;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card label="Products tracked" value={data.summary.products} />
        <Card label="Over-deployed" value={data.summary.over_deployed} tone={data.summary.over_deployed ? 'red' : 'ok'} />
        <Card label="Licences short" value={data.summary.total_shortfall} tone={data.summary.total_shortfall ? 'red' : 'ok'} />
        <Card label="Spare licences" value={data.summary.total_spare} />
      </div>

      {isAdmin && (
        <div className="flex justify-end">
          <button onClick={() => setCreating(true)} className="btn-primary text-xs"><Plus size={13} /> Track a product</button>
        </div>
      )}

      {data.products.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No software products tracked"
          description="Add a product, record what you are entitled to, and record where it is installed. The gap between the two is your compliance position."
        />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {data.products.map((p) => (
            <button
              key={p.product.id}
              onClick={() => setOpen(p.product.id)}
              className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left hover:bg-slate-50 dark:hover:bg-slate-800/50"
            >
              <div className="min-w-[180px] flex-1">
                <div className="text-sm font-medium text-slate-800 dark:text-slate-100">
                  {p.product.name}
                  {p.product.edition && <span className="ml-1 text-xs text-slate-400">{p.product.edition}</span>}
                </div>
                <div className="text-[11px] text-slate-400">{p.product.publisher || 'No publisher'} · {p.metric?.label || p.product.licensing_metric}</div>
              </div>

              <div className="text-xs text-slate-500 dark:text-slate-400">
                <span className="font-semibold text-slate-700 dark:text-slate-200">{p.consumed}</span> used
                {' / '}
                <span className="font-semibold text-slate-700 dark:text-slate-200">{p.entitled}</span> owned
              </div>

              <span className={`badge ${STATUS_STYLE[p.status]}`}>
                {p.status === 'over_deployed' && <AlertTriangle size={10} />}
                {p.status === 'exact' && <Check size={10} />}
                {STATUS_LABEL[p.status]}
                {p.shortfall > 0 && ` · ${p.shortfall} short`}
                {p.spare > 0 && ` · ${p.spare} spare`}
              </span>
            </button>
          ))}
        </div>
      )}

      {creating && <ProductModal onClose={() => setCreating(false)} onSaved={() => { setCreating(false); load(); }} />}
      {open && <ProductDetail productId={open} isAdmin={isAdmin} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
}

function ProductDetail({ productId, isAdmin, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [qty, setQty] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cost, setCost] = useState('');

  const load = () => api.get(`/itam/licenses/products/${productId}`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [productId]);

  const addEntitlement = async () => {
    setError('');
    try {
      await api.post(`/itam/licenses/products/${productId}/entitlements`, {
        quantity: Number(qty), expiry_date: expiry || null, unit_cost: cost === '' ? null : Number(cost),
      });
      setQty(''); setExpiry(''); setCost('');
      await load(); onChanged();
    } catch (e) { setError(e.message); }
  };

  if (!data) {
    return <Modal title="Product" onClose={onClose}><Loading /></Modal>;
  }

  const p = data.position;

  return (
    <Modal title={p.product.name} onClose={onClose} maxWidth="max-w-3xl">
      <div className="space-y-4">
        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

        <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/50 sm:grid-cols-4">
          <Card label="Entitled" value={p.entitled} flat />
          <Card label="Consumed" value={p.consumed} flat />
          <Card label="Balance" value={p.balance} flat tone={p.balance < 0 ? 'red' : 'ok'} />
          <Card label="Licence cost" value={p.total_cost} flat />
        </div>

        {/* How the count was reached. An audit conversation is about the
            arithmetic, not the headline. */}
        <p className="flex items-start gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span><strong>{p.metric?.label}:</strong> {p.basis}</span>
        </p>

        {p.caveats?.length > 0 && (
          <div className="space-y-1 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
            {p.caveats.map((c) => <div key={c} className="flex items-start gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{c}</div>)}
          </div>
        )}

        <div>
          <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">Entitlements</h4>
          {data.entitlements.length === 0 && <p className="text-xs text-slate-400">None recorded, so everything installed counts as a shortfall.</p>}
          <div className="space-y-1">
            {data.entitlements.map((e) => (
              <div key={e.id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-xs dark:bg-slate-800/60">
                <span className="text-slate-700 dark:text-slate-200">
                  {e.quantity} licence{e.quantity === 1 ? '' : 's'}
                  {e.expiry_date && <span className="ml-1 text-slate-400">· expires {String(e.expiry_date).slice(0, 10)}</span>}
                  {e.unit_cost != null && <span className="ml-1 text-slate-400">· {e.unit_cost} each</span>}
                </span>
                {isAdmin && (
                  <button
                    onClick={async () => { await api.del(`/itam/licenses/entitlements/${e.id}`); await load(); onChanged(); }}
                    className="text-slate-400 hover:text-red-500"
                  ><Trash2 size={12} /></button>
                )}
              </div>
            ))}
          </div>

          {isAdmin && (
            <div className="mt-2 flex flex-wrap gap-2">
              <input className="input w-24" type="number" placeholder="Qty" value={qty} onChange={(e) => setQty(e.target.value)} />
              <input className="input w-auto flex-1" type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} title="Expiry (leave blank for perpetual)" />
              <input className="input w-28" type="number" placeholder="Unit cost" value={cost} onChange={(e) => setCost(e.target.value)} />
              <button onClick={addEntitlement} disabled={!qty} className="btn-secondary shrink-0 text-xs disabled:opacity-40">
                <Plus size={12} /> Add
              </button>
            </div>
          )}
        </div>

        <div>
          <h4 className="mb-2 text-xs font-semibold text-slate-600 dark:text-slate-300">
            Installations <span className="font-normal text-slate-400">({data.installations.length})</span>
          </h4>
          {data.installations.length === 0 && <p className="text-xs text-slate-400">Nothing recorded as installed.</p>}
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {data.installations.map((i) => (
              <div key={i.id} className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-xs dark:bg-slate-800/60">
                <span className="text-slate-700 dark:text-slate-200">
                  {i.ci_name || 'No device'}
                  {i.user_name && <span className="text-slate-400"> · {i.user_name}</span>}
                  {i.version && <span className="text-slate-400"> · v{i.version}</span>}
                </span>
                <span className="text-[10px] text-slate-400">{i.source}{i.last_seen_at ? ` · ${fmtDateTime(i.last_seen_at)}` : ''}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

function ProductModal({ onClose, onSaved }) {
  const [form, setForm] = useState({ name: '', publisher: '', edition: '', licensing_metric: 'per_device' });
  const [metrics, setMetrics] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.get('/itam/meta').then((m) => setMetrics(m.licensing_metrics || [])).catch(() => {}); }, []);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try { await api.post('/itam/licenses/products', form); onSaved(); } catch (err) { setError(err.message); } finally { setSaving(false); }
  };

  const chosen = metrics.find((m) => m.key === form.licensing_metric);

  return (
    <Modal title="Track a software product" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}
        <div><label className="label">Product name<span className="text-red-500">*</span></label>
          <input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><label className="label">Publisher</label>
            <input className="input" value={form.publisher} onChange={(e) => setForm({ ...form, publisher: e.target.value })} /></div>
          <div><label className="label">Edition</label>
            <input className="input" value={form.edition} onChange={(e) => setForm({ ...form, edition: e.target.value })} /></div>
        </div>
        <div>
          <label className="label">Licensing metric<span className="text-red-500">*</span></label>
          <Select
            value={form.licensing_metric}
            onChange={(v) => setForm({ ...form, licensing_metric: v })}
            options={metrics.map((m) => ({ value: m.key, label: m.label }))}
          />
          {/* The metric decides the arithmetic, so say what it will do before
              somebody picks the wrong one. */}
          {chosen && <p className="mt-1 text-[11px] text-slate-400">Counts: {chosen.counts}</p>}
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving && <Loader2 size={14} className="animate-spin" />} Add product
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Card({ label, value, tone, flat }) {
  const toneCls = tone === 'red'
    ? 'text-red-600 dark:text-red-400'
    : tone === 'ok' ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-800 dark:text-slate-100';
  return (
    <div className={flat ? '' : 'card p-3'}>
      <div className="text-[10px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`font-display text-xl font-bold ${toneCls}`}>{value}</div>
    </div>
  );
}

function Loading() {
  return <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>;
}
