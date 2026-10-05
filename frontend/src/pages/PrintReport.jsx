import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Printer } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';

const METRIC_LABELS = {
  count: 'Total tickets', resolved: 'Resolved', breached: 'SLA breached',
  avg_resolution_hours: 'Avg resolution (hrs)', first_response_on_time_pct: 'First response on time %', avg_csat: 'Avg CSAT',
};
const METRIC_FORMAT = {
  count: (v) => v ?? 0,
  resolved: (v) => v ?? 0,
  breached: (v) => v ?? 0,
  avg_resolution_hours: (v) => (v ? `${v.toFixed(1)}h` : '—'),
  first_response_on_time_pct: (v) => (v === null || v === undefined ? '—' : `${v}%`),
  avg_csat: (v) => (v ? `${v.toFixed(1)} / 5` : '—'),
};

// Deliberately outside AppShell -- no sidebar/header chrome to fight with
// the browser's print layout. "Export to PDF" here just means "use the
// browser's own print-to-PDF" rather than pulling in a server-side PDF
// library for one button.
export default function PrintReport() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  const groupBy = params.get('group_by');
  const metrics = (params.get('metrics') || 'count,resolved,breached').split(',');
  const dimLabel = groupBy ? groupBy.charAt(0).toUpperCase() + groupBy.slice(1) : '';

  useEffect(() => {
    const query = new URLSearchParams(params);
    query.delete('mode');
    query.delete('metrics');
    query.delete('chart');
    api.get(`/reports/custom?${query.toString()}`)
      .then((d) => setRows(d.rows))
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeFilters = ['type', 'priority', 'team', 'category', 'status', 'from', 'to']
    .map((k) => [k, params.get(k)]).filter(([, v]) => v);

  return (
    <div className="min-h-screen bg-white text-slate-900 p-8 max-w-3xl mx-auto">
      <style>{'@media print { .no-print { display: none !important; } body { padding: 0; } }'}</style>

      <div className="no-print flex justify-end mb-4">
        <button onClick={() => window.print()} className="btn-primary"><Printer size={14} /> Print / Save as PDF</button>
      </div>

      <div className="border-b border-slate-200 pb-4 mb-4">
        <h1 className="text-xl font-display font-bold">Report: Tickets by {dimLabel}</h1>
        <p className="text-sm text-slate-500 mt-1">
          Generated {new Date().toLocaleString()} by {user?.name} · {user?.workspace_name}
        </p>
        {activeFilters.length > 0 && (
          <p className="text-sm text-slate-500 mt-1">
            Filters: {activeFilters.map(([k, v]) => `${k}=${v}`).join(', ')}
          </p>
        )}
      </div>

      {error && <p className="text-red-600 text-sm">{error}</p>}
      {!error && !rows && <p className="text-slate-400 text-sm">Loading…</p>}

      {rows && (
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b-2 border-slate-800">
              <th className="text-left py-2 pr-4">{dimLabel}</th>
              {metrics.map((m) => <th key={m} className="text-left py-2 pr-4">{METRIC_LABELS[m] || m}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.group_key} className="border-b border-slate-200">
                <td className="py-1.5 pr-4 font-medium">{r.group_key}</td>
                {metrics.map((m) => <td key={m} className="py-1.5 pr-4">{METRIC_FORMAT[m] ? METRIC_FORMAT[m](r[m]) : r[m]}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p className="no-print text-xs text-slate-400 mt-6">Use your browser's Print dialog and choose "Save as PDF" as the destination to export this report.</p>
    </div>
  );
}
