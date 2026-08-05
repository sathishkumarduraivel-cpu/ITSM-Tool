import { useEffect, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { Download, Star, Clock } from 'lucide-react';
import { api, getStoredToken } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import StatCard from '../components/StatCard.jsx';

export default function Reports() {
  const [summary, setSummary] = useState(null);
  const [csatList, setCsatList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    (async () => {
      const [s, c] = await Promise.all([api.get('/reports/tickets-summary'), api.get('/reports/csat')]);
      setSummary(s);
      setCsatList(c.surveys);
      setLoading(false);
    })();
  }, []);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const resp = await fetch('/api/reports/export/tickets.csv', {
        headers: { authorization: `Bearer ${getStoredToken()}` },
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'tickets.csv';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  if (loading) return <div className="text-slate-400 text-sm py-20 text-center">Loading reports…</div>;

  const byMonthData = summary.byMonth.map((m) => ({ month: m.month, created: m.c, resolved: m.resolved }));

  return (
    <div className="space-y-6">
      <PageHeader
        title="Reports"
        description="Volume trends, agent performance, satisfaction"
        actions={<button onClick={exportCsv} disabled={exporting} className="btn-secondary"><Download size={14} /> Export tickets CSV</button>}
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard icon={Clock} label="Avg resolution time" value={summary.avgResolutionHours ? `${summary.avgResolutionHours.toFixed(1)}h` : '—'} tone="brand" />
        <StatCard icon={Star} label={`CSAT (${summary.csat.responses} responses)`} value={summary.csat.avg_rating ? `${summary.csat.avg_rating.toFixed(1)} / 5` : '—'} tone="amber" />
        <StatCard icon={Clock} label="Tickets assigned" value={summary.byAgent.reduce((s, a) => s + a.total, 0)} tone="green" />
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Created vs. resolved by month</h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={byMonthData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" allowDecimals={false} />
            <Tooltip />
            <Bar dataKey="created" fill="#a5b4fc" radius={[4, 4, 0, 0]} />
            <Bar dataKey="resolved" fill="#6366f1" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card overflow-hidden overflow-x-auto">
        <div className="px-4 py-3 border-b border-slate-100 dark:border-slate-800"><h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Agent performance</h3></div>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 dark:bg-slate-800/60 text-slate-500 dark:text-slate-400 text-xs uppercase tracking-wide">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Agent</th>
              <th className="text-left px-4 py-2 font-medium">Total</th>
              <th className="text-left px-4 py-2 font-medium">Resolved</th>
              <th className="text-left px-4 py-2 font-medium">Breached</th>
            </tr>
          </thead>
          <tbody>
            {summary.byAgent.map((a) => (
              <tr key={a.name} className="border-t border-slate-100 dark:border-slate-800">
                <td className="px-4 py-2 font-medium text-slate-800 dark:text-slate-100">{a.name}</td>
                <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{a.total}</td>
                <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{a.resolved}</td>
                <td className="px-4 py-2 text-red-600 dark:text-red-400">{a.breached}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Recent CSAT feedback</h3>
        {csatList.length === 0 && <p className="text-sm text-slate-400">No feedback submitted yet.</p>}
        <div className="space-y-2">
          {csatList.slice(0, 10).map((c) => (
            <div key={c.id} className="flex items-start gap-3 bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
              <div className="flex gap-0.5 shrink-0">
                {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={13} className={n <= c.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />)}
              </div>
              <div className="text-sm text-slate-600 dark:text-slate-300">
                <span className="font-mono text-xs text-slate-400 mr-1">{c.number}</span>
                {c.comment || <span className="text-slate-400 italic">No comment</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
