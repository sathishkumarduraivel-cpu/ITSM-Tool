import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  Plus, Loader2, Boxes, Network, Briefcase, KeyRound, Wallet, HeartPulse,
  Search, Upload, Download, Pencil, Trash2, Filter, X,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Select from '../components/Select.jsx';
import CiFormModal from '../components/cmdb/CiFormModal.jsx';
import CiDetailModal from '../components/cmdb/CiDetailModal.jsx';
import CiExplorer from '../components/cmdb/CiExplorer.jsx';
import ServiceMapView from '../components/cmdb/ServiceMapView.jsx';
import LicensesView from '../components/cmdb/LicensesView.jsx';
import FinancialsView from '../components/cmdb/FinancialsView.jsx';
import HealthView from '../components/cmdb/HealthView.jsx';
import ImportWizard from '../components/cmdb/ImportWizard.jsx';

const VIEWS = [
  { key: 'inventory', label: 'Inventory', icon: Boxes },
  { key: 'explorer', label: 'CI Explorer', icon: Network },
  { key: 'services', label: 'Service Map', icon: Briefcase },
  { key: 'licenses', label: 'Licences', icon: KeyRound },
  { key: 'financials', label: 'Financials', icon: Wallet, adminOnly: true },
  { key: 'health', label: 'Health', icon: HeartPulse },
];

const STATUS_STYLES = {
  in_use: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  in_stock: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
  retired: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  maintenance: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
};

// Assets and CMDB, as one workspace with six views over the same estate.
//
// They are one module because they are one set of records seen from different
// angles: a laptop is an asset when finance asks and a CI when an incident
// asks. Splitting them means maintaining the laptop twice and having the two
// copies disagree, which is the failure mode this whole module exists to
// avoid. The views keep the questions separate without splitting the data.
export default function Assets() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  const view = params.get('view') || 'inventory';
  const isAdmin = user?.role === 'admin' || (user?.permissions || []).includes('cmdb.manage');

  const setView = (key) => {
    const next = new URLSearchParams(params);
    next.set('view', key);
    setParams(next, { replace: true });
  };

  const [openCi, setOpenCi] = useState(params.get('ci') || null);
  const [refreshKey, setRefreshKey] = useState(0);
  const bump = () => setRefreshKey((k) => k + 1);

  const visible = VIEWS.filter((v) => !v.adminOnly || isAdmin);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Assets & CMDB"
        description="One record per thing you own or depend on — what it is, what it runs on, who has it, what it cost and whether the record can be trusted."
      />

      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-white/10">
        {visible.map((v) => {
          const Icon = v.icon;
          return (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                view === v.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <Icon size={14} /> {v.label}
            </button>
          );
        })}
      </div>

      {view === 'inventory' && <InventoryView key={refreshKey} isAdmin={isAdmin} onOpenCi={setOpenCi} />}
      {view === 'explorer' && <CiExplorer onOpenCi={setOpenCi} />}
      {view === 'services' && <ServiceMapView onOpenCi={setOpenCi} />}
      {view === 'licenses' && <LicensesView isAdmin={isAdmin} />}
      {view === 'financials' && isAdmin && <FinancialsView />}
      {view === 'health' && <HealthView onOpenCi={setOpenCi} />}

      {openCi && (
        <CiDetailModal
          ciId={openCi}
          isAdmin={isAdmin}
          onClose={() => setOpenCi(null)}
          onChanged={(nextId) => { bump(); if (typeof nextId === 'string') setOpenCi(nextId); }}
        />
      )}
    </div>
  );
}

// ------------------------------------------------------------- inventory ---

function InventoryView({ isAdmin, onOpenCi }) {
  const [assets, setAssets] = useState(null);
  const [summary, setSummary] = useState(null);
  const [classes, setClasses] = useState([]);
  const [classId, setClassId] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState(undefined); // undefined closed, null new, object edit
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const qs = new URLSearchParams();
      if (classId) qs.set('class_id', classId);
      if (status) qs.set('status', status);
      if (q.trim()) qs.set('q', q.trim());
      const [a, s] = await Promise.all([
        api.get(`/assets${qs.toString() ? `?${qs}` : ''}`),
        api.get('/cmdb/summary'),
      ]);
      setAssets(a.assets || []);
      setSummary(s);
    } catch (e) { setError(e.message); setAssets([]); }
  };

  useEffect(() => { api.get('/cmdb-config/classes').then((d) => setClasses(d.classes || [])).catch(() => {}); }, []);
  useEffect(() => { load(); }, [classId, status]);
  useEffect(() => {
    // Debounced so typing does not fire a request per keystroke.
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [q]);

  const remove = async (asset) => {
    if (!confirm(`Delete ${asset.name}? Its relationships and attribute history go with it.`)) return;
    await api.del(`/assets/${asset.id}`);
    load();
  };

  const exportCsv = async () => {
    const token = localStorage.getItem('itsm_token');
    const resp = await fetch(`/api/itam/export/${classId}`, { headers: { authorization: `Bearer ${token}` } });
    const text = await resp.text();
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'cmdb-export.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  const withCounts = useMemo(
    () => (summary?.by_class || []).filter((c) => c.count > 0),
    [summary],
  );

  return (
    <div className="space-y-4">
      {summary && (
        <div className="flex flex-wrap items-center gap-2">
          <Chip label="All CIs" count={summary.total} active={!classId} onClick={() => setClassId('')} />
          {withCounts.map((c) => (
            <Chip key={c.id} label={c.label} count={c.count} color={c.color} active={classId === c.id} onClick={() => setClassId(c.id)} />
          ))}
          {summary.unclassified > 0 && (
            <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" title="These predate the class model">
              {summary.unclassified} unclassified
            </span>
          )}
          <span className="ml-auto text-xs text-slate-400">{summary.relationships} relationship{summary.relationships === 1 ? '' : 's'} mapped</span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9" placeholder="Search by name or tag…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select
          className="w-auto min-w-[150px]" value={status} onChange={setStatus} placeholder="Any status"
          options={[{ value: '', label: 'Any status' }, ...Object.keys(STATUS_STYLES).map((s) => ({ value: s, label: s.replace('_', ' ') }))]}
        />
        {(classId || status || q) && (
          <button onClick={() => { setClassId(''); setStatus(''); setQ(''); }} className="btn-ghost text-xs">
            <X size={12} /> Clear
          </button>
        )}
        {isAdmin && (
          <>
            <button onClick={() => setImporting(true)} className="btn-secondary text-xs"><Upload size={13} /> Import</button>
            <button onClick={exportCsv} disabled={!classId} className="btn-secondary text-xs disabled:opacity-40" title={classId ? 'Export this class' : 'Pick a class first'}>
              <Download size={13} /> Export
            </button>
          </>
        )}
        <button onClick={() => setEditing(null)} className="btn-primary text-xs"><Plus size={13} /> New CI</button>
      </div>

      {error && <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>}

      {!assets ? (
        <p className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading…</p>
      ) : assets.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title={classId || status || q ? 'Nothing matches those filters' : 'No configuration items yet'}
          description={classId || status || q
            ? 'Try clearing the filters.'
            : 'Add a CI, or import a spreadsheet. Pick the class that describes what it is and the form will ask for the right fields.'}
          action={!classId && !status && !q && <button onClick={() => setEditing(null)} className="btn-primary text-xs"><Plus size={13} /> New CI</button>}
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
              <tr>
                <th className="px-4 py-2.5 font-medium">CI</th>
                <th className="px-4 py-2.5 font-medium">Class</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Key detail</th>
                <th className="px-4 py-2.5 font-medium">Location</th>
                <th className="w-20 px-4 py-2.5" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {assets.map((a) => (
                <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="cursor-pointer px-4 py-2.5" onClick={() => onOpenCi(a.id)}>
                    <div className="font-medium text-slate-800 dark:text-slate-100">{a.name}</div>
                    <div className="font-mono text-[11px] text-slate-400">{a.tag}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    {a.ci_class ? (
                      <span className="badge" style={{ backgroundColor: `${a.ci_class.color}1a`, color: a.ci_class.color }}>
                        {a.ci_class.label}
                      </span>
                    ) : <span className="text-xs text-slate-400">—</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <span className={`badge ${STATUS_STYLES[a.status] || 'bg-slate-100 text-slate-500'}`}>{String(a.status || '').replace('_', ' ')}</span>
                  </td>
                  {/* Whatever identifies this class of CI, rather than a
                      column that is blank for most rows. */}
                  <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400">{keyDetail(a)}</td>
                  <td className="px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400">{a.location || '—'}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-1">
                      <button onClick={() => setEditing(a)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-brand-600 dark:hover:bg-slate-800"><Pencil size={13} /></button>
                      {isAdmin && (
                        <button onClick={() => remove(a)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-red-500 dark:hover:bg-slate-800"><Trash2 size={13} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing !== undefined && (
        <CiFormModal initial={editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); load(); }} />
      )}
      {importing && (
        <ImportWizard classes={classes} onClose={() => setImporting(false)} onDone={load} />
      )}
    </div>
  );
}

// The most informative attribute a CI happens to carry, so the table says
// something useful for a Server and for a Business Service without needing a
// different column set per class.
function keyDetail(asset) {
  const a = asset.attributes || {};
  for (const key of ['hostname', 'instance_name', 'app_code', 'management_ip', 'ip_address', 'serial_number', 'resource_id', 'product_name', 'sla_tier', 'site_code']) {
    if (a[key]) return `${key.replace(/_/g, ' ')}: ${a[key]}`;
  }
  return '—';
}

function Chip({ label, count, color, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors ${
        active
          ? 'border-brand-300 bg-brand-50 text-brand-700 dark:border-brand-500/40 dark:bg-brand-500/10 dark:text-brand-300'
          : 'border-slate-200 text-slate-600 hover:bg-slate-50 dark:border-white/10 dark:text-slate-300 dark:hover:bg-slate-800'
      }`}
    >
      {color && <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} />}
      {label}
      <span className="font-semibold">{count}</span>
    </button>
  );
}
