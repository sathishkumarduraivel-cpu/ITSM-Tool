import { useState } from 'react';
import { ChevronDown, ChevronUp, ListChecks, PlayCircle, Loader2 } from 'lucide-react';
import { api } from '../../lib/api.js';

const STATUS_STYLE = {
  success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  test_match: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
  awaiting_approval: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
  rejected: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
  error: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
};
const STATUS_LABEL = { success: 'Ran', test_match: 'Would run', awaiting_approval: 'Needs approval', rejected: 'Rejected', error: 'Error' };

export default function ActivityPanel({ automationId, onHighlight }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('test'); // 'test' | 'log'
  const [logs, setLogs] = useState(null);
  const [testResult, setTestResult] = useState(null);
  const [testing, setTesting] = useState(false);
  const [activeResultIdx, setActiveResultIdx] = useState(null);

  const ensureOpen = async (nextTab) => {
    setTab(nextTab);
    setOpen(true);
    if (nextTab === 'log' && !logs) {
      const { logs: rows } = await api.get(`/automations/${automationId}/logs`);
      setLogs(rows);
    }
  };

  const runTest = async () => {
    setTesting(true);
    try {
      const res = await api.post(`/automations/${automationId}/test-run`, {});
      setTestResult(res);
      setActiveResultIdx(null);
      onHighlight?.(null);
    } finally {
      setTesting(false);
    }
  };

  const selectResult = (idx, r) => {
    setActiveResultIdx(idx);
    onHighlight?.(r);
  };

  return (
    <div className="card overflow-hidden shrink-0">
      <div className="flex items-center justify-between px-4 py-2.5">
        <div className="flex items-center gap-1">
          <button
            onClick={() => ensureOpen('test')}
            className={`text-xs font-semibold px-2.5 py-1 rounded-lg flex items-center gap-1.5 ${open && tab === 'test' ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            <PlayCircle size={13} /> Test against last 30 days
          </button>
          <button
            onClick={() => ensureOpen('log')}
            className={`text-xs font-semibold px-2.5 py-1 rounded-lg flex items-center gap-1.5 ${open && tab === 'log' ? 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
          >
            <ListChecks size={13} /> Run log
          </button>
        </div>
        <button onClick={() => setOpen((o) => !o)} className="text-slate-400 hover:text-slate-600">
          {open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
        </button>
      </div>

      {open && (
        <div className="border-t border-slate-100 dark:border-slate-800 px-4 py-3 max-h-64 overflow-y-auto">
          {tab === 'test' && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500 dark:text-slate-400">Checks real tickets from the last 30 days — no actions are executed, nothing is written.</p>
                <button onClick={runTest} disabled={testing} className="btn-secondary text-xs shrink-0">
                  {testing ? <Loader2 size={12} className="animate-spin" /> : <PlayCircle size={12} />} Run check
                </button>
              </div>
              {testResult && (
                <div className="space-y-1.5">
                  <p className="text-xs text-slate-500">
                    Checked {testResult.checked} ticket(s) — {testResult.matched} would have matched. Click a ticket to highlight the path it took on the canvas.
                  </p>
                  {testResult.results.slice(0, 20).map((r, i) => (
                    <button
                      key={r.ticket.id}
                      onClick={() => selectResult(i, activeResultIdx === i ? null : r)}
                      className={`w-full text-left text-xs rounded-md px-2 py-1.5 border transition-colors ${
                        activeResultIdx === i ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-500/10' : 'border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-900 hover:border-slate-300 dark:hover:border-slate-600'
                      }`}
                    >
                      <span className="font-mono text-slate-400">{r.ticket.number}</span>{' '}
                      <span className="text-slate-700 dark:text-slate-200">{r.ticket.title}</span>
                      <div className="text-slate-400 mt-0.5">
                        {r.would.join('; ')}
                        {r.gatedNodeIds?.length > 0 && <span className="text-red-500 dark:text-red-400"> · would require approval to continue</span>}
                      </div>
                    </button>
                  ))}
                  {testResult.results.length > 20 && (
                    <p className="text-[11px] text-slate-400">+ {testResult.results.length - 20} more not shown</p>
                  )}
                </div>
              )}
            </div>
          )}

          {tab === 'log' && (
            <div className="space-y-1.5">
              {!logs && <p className="text-xs text-slate-400">Loading…</p>}
              {logs?.length === 0 && <p className="text-xs text-slate-400">No runs recorded yet.</p>}
              {logs?.slice(0, 30).map((log) => (
                <div key={log.id} className="text-xs flex items-start gap-2">
                  <span className={`badge shrink-0 ${STATUS_STYLE[log.status] || STATUS_STYLE.error}`}>{STATUS_LABEL[log.status] || log.status}</span>
                  <span className="text-slate-500 dark:text-slate-400">{log.detail}</span>
                  <span className="text-slate-300 dark:text-slate-600 ml-auto shrink-0 font-mono">{new Date(log.created_at).toLocaleString()}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
