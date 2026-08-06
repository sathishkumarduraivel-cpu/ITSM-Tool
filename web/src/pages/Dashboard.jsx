import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid,
} from 'recharts';
import {
  Sparkles, Send, AlertTriangle, Clock, Inbox, Layers, Loader2, RefreshCw, LayoutGrid, Check, ArrowUp, ArrowDown, Eye, EyeOff,
  Bot, X, ExternalLink, Wand2, Tags, FileText, ChevronRight,
} from 'lucide-react';
import { api } from '../lib/api.js';
import StatCard from '../components/StatCard.jsx';
import PageHeader from '../components/PageHeader.jsx';
import { PriorityBadge } from '../components/Badge.jsx';

const PRIORITY_COLORS = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#94a3b8' };
const STATUS_COLORS = { open: '#6366f1', in_progress: '#f59e0b', on_hold: '#94a3b8', resolved: '#10b981', closed: '#64748b' };
const STAT_ICONS = { openCount: Inbox, slaBreached: AlertTriangle, totalCount: Clock, categoryCount: Layers };
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

function statValue(metric, stats) {
  if (metric === 'categoryCount') return stats.byCategory.filter((c) => c.category).length;
  return stats[metric] ?? 0;
}

function Widget({ widget, stats }) {
  if (widget.type === 'stat') {
    return <StatCard icon={STAT_ICONS[widget.metric] || Inbox} label={widget.label} value={statValue(widget.metric, stats)} tone={widget.tone} />;
  }
  if (widget.type === 'line') {
    const trendData = stats.last7days.map((d) => ({ date: d.d.slice(5), tickets: d.c }));
    return (
      <div className="card p-4 h-full">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-brand-500" />{widget.label}
        </h3>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={trendData}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="date" tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <YAxis tick={{ fontSize: 12 }} stroke="#94a3b8" allowDecimals={false} />
            <Tooltip />
            <Line type="monotone" dataKey="tickets" stroke="#6366f1" strokeWidth={2.5} dot={{ r: 3 }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    );
  }
  if (widget.type === 'pie') {
    const priorityData = stats.byPriority.map((p) => ({ name: p.priority, value: p.c }));
    return (
      <div className="card p-4 h-full">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />{widget.label}
        </h3>
        <ResponsiveContainer width="100%" height={220}>
          <PieChart>
            <Pie data={priorityData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
              {priorityData.map((entry, i) => <Cell key={i} fill={PRIORITY_COLORS[entry.name] || '#94a3b8'} />)}
            </Pie>
            <Tooltip />
          </PieChart>
        </ResponsiveContainer>
        <div className="flex flex-wrap gap-2 justify-center mt-1">
          {priorityData.map((p) => (
            <span key={p.name} className="badge" style={{ backgroundColor: `${PRIORITY_COLORS[p.name]}1a`, color: PRIORITY_COLORS[p.name] }}>
              {p.name} · {p.value}
            </span>
          ))}
        </div>
      </div>
    );
  }
  if (widget.type === 'bar') {
    const statusData = stats.byStatus.map((s) => ({ name: s.status.replace('_', ' '), value: s.c }));
    return (
      <div className="card p-4 h-full">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />{widget.label}
        </h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={statusData} layout="vertical" margin={{ left: 10 }}>
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={90} stroke="#94a3b8" />
            <Tooltip />
            <Bar dataKey="value" radius={[0, 6, 6, 0]}>
              {statusData.map((entry, i) => <Cell key={i} fill={STATUS_COLORS[entry.name.replace(' ', '_')] || '#6366f1'} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    );
  }
  return null;
}

function EditLayoutPanel({ layout, catalog, onChange, onDone }) {
  const move = (id, dir) => {
    const idx = layout.findIndex((w) => w.id === id);
    const swapWith = idx + dir;
    if (swapWith < 0 || swapWith >= layout.length) return;
    const next = [...layout];
    [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
    onChange(next);
  };

  const toggle = (widgetDef) => {
    const present = layout.some((w) => w.id === widgetDef.id);
    if (present) onChange(layout.filter((w) => w.id !== widgetDef.id));
    else onChange([...layout, widgetDef]);
  };

  return (
    <div className="card p-4 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5"><LayoutGrid size={14} /> Customize dashboard</h3>
        <button onClick={onDone} className="btn-primary text-xs"><Check size={13} /> Done</button>
      </div>
      <div className="space-y-1.5">
        {catalog.map((widgetDef) => {
          const present = layout.some((w) => w.id === widgetDef.id);
          return (
            <div key={widgetDef.id} className="flex items-center justify-between gap-2 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
              <button onClick={() => toggle(widgetDef)} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200 flex-1 text-left">
                {present ? <Eye size={14} className="text-brand-600" /> : <EyeOff size={14} className="text-slate-400" />}
                {widgetDef.label}
              </button>
              {present && (
                <div className="flex items-center gap-1">
                  <button onClick={() => move(widgetDef.id, -1)} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"><ArrowUp size={14} /></button>
                  <button onClick={() => move(widgetDef.id, 1)} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"><ArrowDown size={14} /></button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Predictive Triage Queue helpers (all computed from real ticket fields —
// no fabricated confidence scores; "predictive" here means real priority +
// SLA-deadline-based ordering, and the risk gauge is real elapsed-vs-budget time). ----

function timeAgo(iso) {
  if (!iso) return '—';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function slaRiskPct(ticket) {
  if (!ticket.sla_due_at) return null;
  const created = new Date(ticket.created_at).getTime();
  const due = new Date(ticket.sla_due_at).getTime();
  if (!(due > created)) return 100;
  const pct = ((Date.now() - created) / (due - created)) * 100;
  return Math.max(0, Math.min(100, Math.round(pct)));
}

function riskColor(pct) {
  if (pct === null) return '#94a3b8';
  if (pct >= 90) return '#ef4444';
  if (pct >= 65) return '#f59e0b';
  return '#10b981';
}

function RiskGauge({ pct, size = 'sm' }) {
  const color = riskColor(pct);
  const dash = 94.2; // arc length for the path below
  const offset = pct === null ? dash : dash - (dash * pct) / 100;
  const big = size === 'lg';
  return (
    <div className="flex items-center gap-2.5">
      <svg width={big ? 72 : 44} height={big ? 44 : 27} viewBox="0 0 72 44">
        <path d="M6,40 A30,30 0 0,1 66,40" fill="none" stroke="currentColor" className="text-slate-200 dark:text-slate-700" strokeWidth={big ? 7 : 5} strokeLinecap="round" />
        {pct !== null && (
          <path d="M6,40 A30,30 0 0,1 66,40" fill="none" stroke={color} strokeWidth={big ? 7 : 5} strokeLinecap="round" strokeDasharray={dash} strokeDashoffset={offset} />
        )}
      </svg>
      <div>
        <div className={`font-mono font-bold ${big ? 'text-xl' : 'text-xs'}`} style={{ color }}>{pct === null ? '—' : `${pct}%`}</div>
        {big && <div className="text-[10px] text-slate-400 dark:text-slate-500">SLA time budget used</div>}
      </div>
    </div>
  );
}

function TriageQueue({ tickets, loading, selectedId, onSelect }) {
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-100 dark:border-slate-800">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500" /> Predictive Triage Queue
          <span className="text-xs font-normal text-slate-400 font-mono">{tickets.length} open</span>
        </h3>
      </div>
      <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-white/95 dark:bg-slate-900/95 backdrop-blur text-[10px] uppercase tracking-wide text-slate-400">
            <tr>
              <th className="text-left px-4 py-2 font-medium">Priority</th>
              <th className="text-left px-4 py-2 font-medium">Ticket</th>
              <th className="text-left px-4 py-2 font-medium">AI Summary</th>
              <th className="text-left px-4 py-2 font-medium">SLA Risk</th>
              <th className="text-left px-4 py-2 font-medium">Age</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={5} className="text-center py-8 text-slate-400">Loading…</td></tr>
            )}
            {!loading && tickets.length === 0 && (
              <tr><td colSpan={5} className="text-center py-8 text-slate-400">No open tickets — queue is clear.</td></tr>
            )}
            {tickets.map((t) => {
              const pct = slaRiskPct(t);
              return (
                <tr
                  key={t.id}
                  onClick={() => onSelect(t.id)}
                  className={`cursor-pointer border-t border-slate-100 dark:border-slate-800 transition-colors ${
                    t.id === selectedId ? 'bg-brand-50 dark:bg-brand-500/10' : 'hover:bg-slate-50 dark:hover:bg-slate-800/60'
                  }`}
                >
                  <td className="px-4 py-2.5"><PriorityBadge priority={t.priority} /></td>
                  <td className="px-4 py-2.5">
                    <div className="font-mono text-[11px] text-slate-400">{t.number}</div>
                    <div className="font-medium text-slate-700 dark:text-slate-200 max-w-[220px] truncate">{t.title}</div>
                  </td>
                  <td className="px-4 py-2.5 max-w-[200px]">
                    {t.ai_summary ? (
                      <span className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2">{t.ai_summary}</span>
                    ) : (
                      <span className="text-xs text-slate-400 italic">Not yet analyzed</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5"><RiskGauge pct={pct} /></td>
                  <td className="px-4 py-2.5 text-xs text-slate-400 font-mono whitespace-nowrap">{timeAgo(t.created_at)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TicketDetailPanel({ ticketId, onOpenCopilot }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);

  const load = async () => {
    if (!ticketId) return;
    const res = await api.get(`/tickets/${ticketId}`);
    setData(res);
  };

  useEffect(() => { setData(null); load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [ticketId]);

  const analyze = async () => {
    setAnalyzing(true);
    try {
      await api.post(`/tickets/${ticketId}/ai/summarize`, {});
      await load();
    } catch (e) {
      alert(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  if (!ticketId) {
    return (
      <div className="card p-8 h-full flex flex-col items-center justify-center text-center text-slate-400">
        <Inbox size={28} className="mb-2 opacity-50" />
        <p className="text-sm">Select a ticket from the queue to see its detail.</p>
      </div>
    );
  }

  if (!data) {
    return <div className="card p-8 h-full flex items-center justify-center text-slate-400 text-sm">Loading…</div>;
  }

  const { ticket, history } = data;
  const pct = slaRiskPct(ticket);

  return (
    <div className="card p-4 h-full flex flex-col gap-4 overflow-y-auto max-h-[500px]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <PriorityBadge priority={ticket.priority} />
            <span className="font-mono text-xs text-slate-400">{ticket.number}</span>
          </div>
          <h3 className="text-base font-semibold text-slate-800 dark:text-slate-100 leading-snug">{ticket.title}</h3>
        </div>
        <button onClick={() => navigate(`/tickets/${ticket.id}`)} className="btn-ghost text-xs shrink-0" title="Open full ticket">
          <ExternalLink size={13} />
        </button>
      </div>

      <div className="text-xs text-slate-500 dark:text-slate-400 flex flex-wrap gap-x-4 gap-y-1">
        <span>Requester: <b className="text-slate-700 dark:text-slate-200 font-medium">{ticket.requester_name || '—'}</b></span>
        <span>Assignee: <b className="text-slate-700 dark:text-slate-200 font-medium">{ticket.assignee_name || 'Unassigned'}</b></span>
      </div>

      <div className="card-flat p-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-2 flex items-center gap-1.5">
          <Sparkles size={12} /> AI Summary
        </div>
        {ticket.ai_summary ? (
          <p className="text-sm text-slate-700 dark:text-slate-200 leading-relaxed">{ticket.ai_summary}</p>
        ) : (
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-slate-400 italic">AI hasn't analyzed this ticket yet.</p>
            <button onClick={analyze} disabled={analyzing} className="btn-secondary text-xs shrink-0">
              {analyzing ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} Analyze
            </button>
          </div>
        )}
      </div>

      <div className="card-flat p-3">
        <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-2">SLA Risk</div>
        <RiskGauge pct={pct} size="lg" />
      </div>

      <div className="card-flat p-3 flex-1">
        <div className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold mb-2">Activity Timeline</div>
        <div className="space-y-2.5">
          {history.length === 0 && <p className="text-xs text-slate-400">No activity recorded yet.</p>}
          {history.map((h, i) => (
            <div key={h.id} className="flex gap-2.5">
              <div className="flex flex-col items-center">
                <span className={`w-2 h-2 rounded-full shrink-0 ${i === history.length - 1 ? 'bg-brand-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                {i < history.length - 1 && <span className="w-px flex-1 bg-slate-200 dark:bg-slate-700 mt-1" />}
              </div>
              <div className="pb-1">
                <div className="text-xs font-medium text-slate-700 dark:text-slate-200 capitalize">{h.event.replace('_', ' ')}</div>
                {h.detail && <div className="text-[11px] text-slate-400">{h.detail}</div>}
                <div className="text-[10px] text-slate-400 font-mono">{timeAgo(h.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      <button onClick={onOpenCopilot} className="btn-primary text-xs w-full justify-center">
        <Bot size={13} /> Open in AI Copilot
      </button>
    </div>
  );
}

function CopilotDrawer({ ticketId, open, onClose }) {
  const [ticket, setTicket] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [busy, setBusy] = useState('');
  const endRef = useRef(null);

  useEffect(() => {
    setTranscript([]);
    if (ticketId && open) {
      api.get(`/tickets/${ticketId}`).then((d) => setTicket(d.ticket));
    }
  }, [ticketId, open]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [transcript]);

  const run = async (action, label, endpoint, extract) => {
    setBusy(action);
    setTranscript((t) => [...t, { role: 'action', text: label }]);
    try {
      const res = await api.post(`/tickets/${ticketId}/ai/${endpoint}`, {});
      setTranscript((t) => [...t, { role: 'ai', text: extract(res) }]);
    } catch (e) {
      setTranscript((t) => [...t, { role: 'error', text: e.message }]);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className={`fixed inset-y-0 right-0 w-full sm:w-96 z-40 transition-transform duration-300 ${open ? 'translate-x-0' : 'translate-x-full'}`}>
      <div className="h-full glass-panel border-l border-white/60 dark:border-white/[0.07] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100 dark:border-slate-800">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center">
              <Bot size={14} className="text-white" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">AI Copilot</div>
              {ticket && <div className="text-[11px] text-slate-400 font-mono">{ticket.number}</div>}
            </div>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"><X size={16} /></button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
          {!ticket && <p className="text-sm text-slate-400 text-center mt-6">Select a ticket to bring it into the Copilot.</p>}
          {ticket && (
            <div className="text-xs text-slate-500 dark:text-slate-400 bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
              {ticket.title}
            </div>
          )}
          {transcript.map((m, i) => (
            <div
              key={i}
              className={`text-sm rounded-lg px-3 py-2 whitespace-pre-line ${
                m.role === 'action' ? 'text-xs text-slate-400 italic' :
                m.role === 'error' ? 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400' :
                'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
              }`}
            >
              {m.text}
            </div>
          ))}
          <div ref={endRef} />
        </div>

        {ticket && (
          <div className="p-3 border-t border-slate-100 dark:border-slate-800 grid grid-cols-3 gap-1.5">
            <button disabled={!!busy} onClick={() => run('summarize', 'Summarizing ticket…', 'summarize', (r) => r.summary)} className="btn-secondary text-[11px] flex-col h-14 gap-1">
              {busy === 'summarize' ? <Loader2 size={14} className="animate-spin" /> : <FileText size={14} />} Summarize
            </button>
            <button disabled={!!busy} onClick={() => run('suggest', 'Drafting a suggested resolution…', 'suggest-resolution', (r) => r.suggestion)} className="btn-secondary text-[11px] flex-col h-14 gap-1">
              {busy === 'suggest' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Suggest fix
            </button>
            <button disabled={!!busy} onClick={() => run('categorize', 'Auto-categorizing…', 'categorize', (r) => `Category: ${r.result.category}${r.result.subcategory ? ' / ' + r.result.subcategory : ''}\nSentiment: ${r.result.sentiment || '—'}`)} className="btn-secondary text-[11px] flex-col h-14 gap-1">
              {busy === 'categorize' ? <Loader2 size={14} className="animate-spin" /> : <Tags size={14} />} Categorize
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [layout, setLayout] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [editing, setEditing] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [insights, setInsights] = useState('');
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState('');
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState([]);
  const [asking, setAsking] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const chatEndRef = useRef(null);

  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [copilotOpen, setCopilotOpen] = useState(false);

  const loadStats = async () => {
    const { stats } = await api.get('/ai/dashboard-stats');
    setStats(stats);
  };

  const loadLayout = async () => {
    const [{ layout }, { available }] = await Promise.all([api.get('/dashboard/layout'), api.get('/dashboard/catalog')]);
    setLayout(layout);
    setCatalog(available);
  };

  const loadQueue = async () => {
    setQueueLoading(true);
    try {
      const [open, inProgress] = await Promise.all([api.get('/tickets?status=open'), api.get('/tickets?status=in_progress')]);
      const rows = [...open.tickets, ...inProgress.tickets].sort((a, b) => {
        const p = (PRIORITY_ORDER[a.priority] ?? 9) - (PRIORITY_ORDER[b.priority] ?? 9);
        if (p !== 0) return p;
        const da = a.sla_due_at ? new Date(a.sla_due_at).getTime() : Infinity;
        const db = b.sla_due_at ? new Date(b.sla_due_at).getTime() : Infinity;
        return da - db;
      });
      setQueue(rows);
      if (rows.length && !selectedId) setSelectedId(rows[0].id);
    } finally {
      setQueueLoading(false);
    }
  };

  useEffect(() => {
    loadStats();
    loadLayout();
    loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  const saveLayout = async (next) => {
    setLayout(next);
    setSavingLayout(true);
    try {
      await api.put('/dashboard/layout', { layout: next });
    } finally {
      setSavingLayout(false);
    }
  };

  const generateInsights = async () => {
    setInsightsLoading(true);
    setInsightsError('');
    try {
      const { insights } = await api.post('/ai/dashboard-insights', {});
      setInsights(insights);
    } catch (e) {
      setInsightsError(e.message);
    } finally {
      setInsightsLoading(false);
    }
  };

  const askAI = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;
    const q = question.trim();
    setShowChat(true);
    setChat((c) => [...c, { role: 'user', text: q }]);
    setQuestion('');
    setAsking(true);
    try {
      const { answer } = await api.post('/ai/ask', { question: q });
      setChat((c) => [...c, { role: 'ai', text: answer }]);
    } catch (e) {
      setChat((c) => [...c, { role: 'ai', text: `Error: ${e.message}` }]);
    } finally {
      setAsking(false);
    }
  };

  if (!stats || !layout) {
    return <div className="text-slate-400 text-sm py-20 text-center">Loading dashboard…</div>;
  }

  const statWidgets = layout.filter((w) => w.type === 'stat');
  const chartWidgets = layout.filter((w) => w.type !== 'stat');

  return (
    <div className="space-y-6">
      <PageHeader
        title="Command Center"
        description="Live overview of your service desk"
        actions={
          <>
            <button onClick={() => setEditing((e) => !e)} className="btn-secondary">
              <LayoutGrid size={14} /> {editing ? 'Close' : 'Edit layout'}
            </button>
            <button onClick={() => { loadStats(); loadQueue(); }} className="btn-secondary">
              <RefreshCw size={14} /> Refresh
            </button>
          </>
        }
      />

      {/* AI Command Bar */}
      <div>
        <form onSubmit={askAI} className="command-glow rounded-full">
          <div className="flex items-center gap-3 card !rounded-full px-4 py-1">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shrink-0">
              <Sparkles size={14} className="text-white" />
            </div>
            <input
              className="flex-1 bg-transparent border-none outline-none text-sm py-2.5 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
              placeholder="Ask AI which tickets need attention, or anything about your service desk…"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onFocus={() => chat.length > 0 && setShowChat(true)}
            />
            <button type="submit" disabled={asking} className="btn-primary !rounded-full !px-3 !py-1.5 shrink-0">
              {asking ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </form>
        {showChat && (
          <div className="card p-3 mt-2 animate-fade-in">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Conversation</span>
              <button onClick={() => setShowChat(false)} className="text-slate-400 hover:text-slate-600"><X size={14} /></button>
            </div>
            <div className="max-h-56 overflow-y-auto space-y-2 pr-1">
              {chat.map((m, i) => (
                <div key={i} className={`text-sm rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-line ${m.role === 'user' ? 'bg-brand-600 text-white ml-auto' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}`}>
                  {m.text}
                </div>
              ))}
              {asking && (
                <div className="text-sm rounded-lg px-3 py-2 bg-slate-100 dark:bg-slate-800 text-slate-400 w-fit flex items-center gap-1.5">
                  <Loader2 size={12} className="animate-spin" /> thinking…
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          </div>
        )}
      </div>

      {editing && (
        <EditLayoutPanel layout={layout} catalog={catalog} onChange={saveLayout} onDone={() => setEditing(false)} />
      )}
      {savingLayout && <div className="text-xs text-slate-400">Saving layout…</div>}

      {statWidgets.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {statWidgets.map((w) => <Widget key={w.id} widget={w} stats={stats} />)}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {chartWidgets.map((w) => (
          <div key={w.id} className={w.type === 'line' || w.type === 'bar' ? 'lg:col-span-2' : ''}>
            <Widget widget={w} stats={stats} />
          </div>
        ))}

        <div className="relative card p-4 bg-gradient-to-br from-brand-600 via-brand-700 to-purple-800 text-white overflow-hidden border-none shadow-glow-brand">
          <div className="pointer-events-none absolute -top-10 -right-10 w-40 h-40 rounded-full bg-white/10 blur-2xl" />
          <div className="relative flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <Sparkles size={15} /> AI Insights
            </h3>
            <button
              onClick={generateInsights}
              disabled={insightsLoading}
              className="text-xs bg-white/15 hover:bg-white/25 rounded-md px-2 py-1 flex items-center gap-1 transition-colors"
            >
              {insightsLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              Generate
            </button>
          </div>
          {insightsError && (
            <p className="text-xs text-red-100 bg-red-500/30 rounded-md p-2 mb-2">{insightsError}</p>
          )}
          <p className="text-sm text-brand-50/90 whitespace-pre-line leading-relaxed">
            {insights || 'Click "Generate" to have your configured AI provider analyze current ticket data and surface trends, SLA risk, and recommendations. Configure a provider first under AI Settings.'}
          </p>
        </div>
      </div>

      {/* Predictive Triage Queue — master/detail */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4 items-start">
        <TriageQueue tickets={queue} loading={queueLoading} selectedId={selectedId} onSelect={setSelectedId} />
        <TicketDetailPanel ticketId={selectedId} onOpenCopilot={() => setCopilotOpen(true)} />
      </div>

      {!copilotOpen && (
        <button
          onClick={() => setCopilotOpen(true)}
          className="fixed bottom-6 right-6 z-30 w-14 h-14 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 shadow-glow-brand flex items-center justify-center text-white hover:scale-105 transition-transform"
          title="Open AI Copilot"
        >
          <Bot size={22} />
        </button>
      )}
      <CopilotDrawer ticketId={selectedId} open={copilotOpen} onClose={() => setCopilotOpen(false)} />
    </div>
  );
}
