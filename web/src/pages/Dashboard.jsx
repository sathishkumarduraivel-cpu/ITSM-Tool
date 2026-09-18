import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid,
} from 'recharts';
import {
  Sparkles, AlertTriangle, Clock, Inbox, Layers, Loader2, RefreshCw, LayoutGrid, Check, ArrowUp, ArrowDown, Eye, EyeOff,
  Bot, ExternalLink, Wand2, ChevronRight, ShieldCheck, Workflow, Heart, ChevronDown, Users, SlidersHorizontal,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useTranslation } from '../i18n/I18nContext.jsx';
import StatCard from '../components/StatCard.jsx';
import { PriorityBadge } from '../components/Badge.jsx';
import Select from '../components/Select.jsx';

function greetingKeyForHour(h) {
  if (h < 5) return 'dashboard.greetingLateNight';
  if (h < 12) return 'dashboard.greetingMorning';
  if (h < 17) return 'dashboard.greetingAfternoon';
  if (h < 21) return 'dashboard.greetingEvening';
  return 'dashboard.greetingWorkingLate';
}

const PRIORITY_COLORS = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#94a3b8' };
const STATUS_COLORS = { open: '#6366f1', in_progress: '#f59e0b', on_hold: '#94a3b8', resolved: '#10b981', closed: '#64748b' };
const STAT_ICONS = { openCount: Inbox, slaBreached: AlertTriangle, totalCount: Clock, categoryCount: Layers };
const PRIORITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

const HEALTH_STYLES = {
  Healthy: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
  Stable: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400',
  'At Risk': 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
};
const CHIP_TONE = {
  green: { border: 'border-emerald-400 dark:border-emerald-500/40', bg: 'bg-emerald-50/70 dark:bg-emerald-500/10', text: 'text-emerald-700 dark:text-emerald-400' },
  amber: { border: 'border-amber-400 dark:border-amber-500/40', bg: 'bg-amber-50/70 dark:bg-amber-500/10', text: 'text-amber-700 dark:text-amber-400' },
  blue: { border: 'border-brand-400 dark:border-brand-500/40', bg: 'bg-brand-50/70 dark:bg-brand-500/10', text: 'text-brand-700 dark:text-brand-400' },
  red: { border: 'border-red-400 dark:border-red-500/40', bg: 'bg-red-50/70 dark:bg-red-500/10', text: 'text-red-600 dark:text-red-400' },
};
const EXEC_TONE = { green: 'text-emerald-600 dark:text-emerald-400', red: 'text-red-600 dark:text-red-400', blue: 'text-brand-600 dark:text-brand-400', amber: 'text-amber-600 dark:text-amber-400', purple: 'text-purple-600 dark:text-purple-400' };

const TIME_RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const TYPES = ['incident', 'request', 'problem', 'change'];
const STATUSES = ['open', 'in_progress', 'on_hold', 'resolved', 'closed'];

function ExecStat({ icon: Icon, value, label, tone }) {
  return (
    <div className="flex flex-col items-center text-center gap-1">
      <Icon size={17} className={EXEC_TONE[tone] || 'text-slate-500 dark:text-slate-400'} />
      <div className="text-lg font-bold text-slate-800 dark:text-slate-100 leading-none">{value}</div>
      <div className="text-[10px] text-slate-400 dark:text-slate-500 leading-tight">{label}</div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options, allLabel = 'All' }) {
  const normalized = options.map((o) => (
    typeof o === 'string' ? { value: o, label: `${label}: ${o.replace('_', ' ')}` } : o
  ));
  return (
    <Select
      size="xs"
      value={value}
      onChange={onChange}
      className="bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-white/10 rounded-lg text-slate-600 dark:text-slate-300 font-medium shadow-none hover:border-slate-300 dark:hover:border-white/20"
      options={allLabel !== null ? [{ value: '', label: `${label}: ${allLabel}` }, ...normalized] : normalized}
    />
  );
}

function TeamAvatar({ member, selected, onClick }) {
  const initials = member.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1 shrink-0 group">
      <div className="relative">
        <div
          className={`w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-semibold ring-2 shadow-sm transition-all ${selected ? 'ring-brand-500' : 'ring-white dark:ring-slate-900 group-hover:ring-brand-200 dark:group-hover:ring-brand-500/40'}`}
          style={{ backgroundColor: member.avatar_color }}
        >
          {initials}
        </div>
        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-white dark:ring-slate-900 ${member.active ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
      </div>
      <div className="text-center leading-tight">
        <div className="text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap">{member.name.split(' ')[0]}</div>
        <div className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">{member.team || member.role}</div>
      </div>
    </button>
  );
}

function ChipCard({ chip }) {
  const tone = CHIP_TONE[chip.tone] || CHIP_TONE.blue;
  return (
    <div className={`rounded-xl border-l-4 ${tone.border} ${tone.bg} px-3 py-2.5 min-w-0`}>
      <div className="flex items-start justify-between gap-1.5 mb-1">
        <span className="text-[10px] font-semibold text-slate-500 dark:text-slate-400 uppercase tracking-wide leading-tight">{chip.label}</span>
        <span className={`text-[10px] font-medium ${tone.text} whitespace-nowrap shrink-0`}>{chip.status}</span>
      </div>
      <div className="text-xl font-bold text-slate-800 dark:text-slate-100">{chip.value}</div>
    </div>
  );
}

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
      {/* Desktop/tablet: the full table, its own scroll region. Hidden below
          sm: -- a horizontally-scrolling table nested inside a vertically-
          scrolling panel fights a touch swipe in the wrong axis, so mobile
          gets the stacked card list below instead of this. */}
      <div className="hidden sm:block overflow-x-auto max-h-[420px] overflow-y-auto">
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
                  className={`border-t border-slate-100 dark:border-slate-800 ${
                    t.id === selectedId ? 'cursor-pointer bg-brand-50 dark:bg-brand-500/10' : 'row-interactive'
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

      {/* Mobile: a plain vertically-scrolling card list, same data, no
          horizontal scroll axis to fight with the page's own scroll. */}
      <div className="sm:hidden divide-y divide-slate-100 dark:divide-slate-800 max-h-[420px] overflow-y-auto">
        {loading && <div className="text-center py-8 text-slate-400 text-sm">Loading…</div>}
        {!loading && tickets.length === 0 && <div className="text-center py-8 text-slate-400 text-sm">No open tickets — queue is clear.</div>}
        {tickets.map((t) => {
          const pct = slaRiskPct(t);
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={`w-full text-left px-4 py-3 ${t.id === selectedId ? 'bg-brand-50 dark:bg-brand-500/10' : 'active:bg-slate-50 dark:active:bg-slate-800/60'}`}
            >
              <div className="flex items-center justify-between gap-2 mb-1">
                <PriorityBadge priority={t.priority} />
                <span className="text-xs text-slate-400 font-mono whitespace-nowrap">{timeAgo(t.created_at)}</span>
              </div>
              <div className="font-mono text-[11px] text-slate-400">{t.number}</div>
              <div className="font-medium text-slate-700 dark:text-slate-200 truncate">{t.title}</div>
              {t.ai_summary && <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-2 mt-1">{t.ai_summary}</p>}
              <div className="mt-1.5"><RiskGauge pct={pct} /></div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TicketDetailPanel({ ticketId }) {
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [analyzing, setAnalyzing] = useState(false);
  // Tracks whichever ticket is currently selected so a slow response for a
  // ticket the user has already clicked away from can't land after a faster
  // response for the new one and silently overwrite the panel -- the row
  // stays highlighted on the new ticket while showing the old one's detail.
  const currentIdRef = useRef(ticketId);
  currentIdRef.current = ticketId;

  const load = async () => {
    if (!ticketId) return;
    const requestedId = ticketId;
    const res = await api.get(`/tickets/${requestedId}`);
    if (currentIdRef.current !== requestedId) return;
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

      <button onClick={() => navigate(`/tickets/${ticket.id}?copilot=1`)} className="btn-primary w-full justify-center !py-2.5">
        <Bot size={15} /> Open in Sona
      </button>
    </div>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const { t } = useTranslation();
  const [showFilters, setShowFilters] = useState(false);
  const [stats, setStats] = useState(null);
  const [layout, setLayout] = useState(null);
  const [catalog, setCatalog] = useState([]);
  const [editing, setEditing] = useState(false);
  const [savingLayout, setSavingLayout] = useState(false);
  const [insights, setInsights] = useState('');
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState('');

  const [queue, setQueue] = useState([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);

  const [cc, setCc] = useState(null);
  const [filters, setFilters] = useState({ days: '30', team: '', priority: '', type: '', status: '', owner: '' });
  const [loadError, setLoadError] = useState('');
  // Mirrors `filters` for the presence poll below -- that interval is set up
  // once (empty deps) so its closure over `loadCc` would otherwise keep
  // reading whatever `filters` was at mount, silently reverting the roster
  // to stale filter values every 30s after the user changes one.
  const filtersRef = useRef(filters);
  useEffect(() => { filtersRef.current = filters; }, [filters]);

  // Each of these three feeds a piece of state the initial render is gated
  // on (see the "Loading dashboard..." check below) -- without a catch here,
  // any single failed request (a spent rate limit, a dropped connection)
  // left that state permanently null and the page stuck loading forever with
  // no visible error.
  const loadStats = async () => {
    try {
      const { stats } = await api.get('/ai/dashboard-stats');
      setStats(stats);
    } catch (e) {
      setLoadError(e.message);
    }
  };

  const loadCc = async (f) => {
    const active = f || filtersRef.current;
    const query = new URLSearchParams(Object.entries(active).filter(([, v]) => v)).toString();
    try {
      const { stats: command } = await api.get(`/ai/command-center-stats${query ? `?${query}` : ''}`);
      setCc(command);
    } catch (e) {
      setLoadError(e.message);
    }
  };

  const loadLayout = async () => {
    try {
      const [{ layout }, { available }] = await Promise.all([api.get('/dashboard/layout'), api.get('/dashboard/catalog')]);
      setLayout(layout);
      setCatalog(available);
    } catch (e) {
      setLoadError(e.message);
    }
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
    loadCc();
    // Keeps the team roster's online/offline dots close to live while this
    // page is open -- everything else here is fetch-on-load/action like the
    // rest of the app, but presence specifically goes stale within seconds,
    // not minutes, so it alone gets a light poll rather than a full-page one.
    const presenceTimer = setInterval(loadCc, 30000);
    return () => clearInterval(presenceTimer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilter = (key, value) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    loadCc(next);
  };

  const resetFilters = () => {
    const next = { days: '30', team: '', priority: '', type: '', status: '', owner: '' };
    setFilters(next);
    loadCc(next);
  };

  const teamOptions = useMemo(() => {
    if (!cc) return [];
    return [...new Set(cc.team.map((m) => m.team).filter(Boolean))];
  }, [cc]);

  const ownerOptions = useMemo(() => {
    if (!cc) return [];
    return cc.team.map((m) => ({ value: m.id, label: m.name }));
  }, [cc]);

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

  if (!stats || !layout || !cc) {
    if (loadError) {
      return (
        <div className="max-w-sm mx-auto py-20 text-center space-y-3">
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
          <button
            onClick={() => { setLoadError(''); loadStats(); loadLayout(); loadCc(); }}
            className="btn-secondary text-xs mx-auto"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      );
    }
    return <div className="text-slate-400 text-sm py-20 text-center">Loading dashboard…</div>;
  }

  const statWidgets = layout.filter((w) => w.type === 'stat');
  const chartWidgets = layout.filter((w) => w.type !== 'stat');
  const lastUpdated = new Date(cc.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const firstName = user?.name?.split(' ')[0] || 'there';
  const urgent = stats.slaBreached || 0;

  return (
    <div className="space-y-6">
      {/* Personalized greeting instead of a generic page title -- the first
          thing read on the page says who it's for and what needs attention
          today, not an abstract "Command Center" label. Layout/Refresh
          controls live here too so there's one header, not a header plus a
          second exec-status block competing for the same visual weight. */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-display font-bold text-slate-800 dark:text-slate-100 tracking-tight">
            {t(greetingKeyForHour(new Date().getHours()))} {firstName}
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {urgent > 0
              ? `${stats.openCount} open ticket${stats.openCount === 1 ? '' : 's'}, ${urgent} at SLA risk — here's where to start.`
              : `${stats.openCount} open ticket${stats.openCount === 1 ? '' : 's'} and nothing breaching SLA right now.`}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button onClick={() => setEditing((e) => !e)} className="btn-secondary">
            <LayoutGrid size={14} /> {editing ? 'Close' : 'Edit layout'}
          </button>
          <button onClick={() => { loadStats(); loadQueue(); loadCc(); }} className="btn-secondary">
            <RefreshCw size={14} /> Refresh
          </button>
        </div>
      </div>

      {editing && (
        <EditLayoutPanel layout={layout} catalog={catalog} onChange={saveLayout} onDone={() => setEditing(false)} />
      )}
      {savingLayout && <div className="text-xs text-slate-400">Saving layout…</div>}

      {/* Row 1 — the numbers a person opens this page to check first. */}
      {statWidgets.length > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {statWidgets.map((w) => <Widget key={w.id} widget={w} stats={stats} />)}
        </div>
      )}

      {/* Row 2 — the actual work: what needs picking up right now. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1.6fr_1fr] gap-4 items-start">
        <TriageQueue tickets={queue} loading={queueLoading} selectedId={selectedId} onSelect={setSelectedId} />
        <TicketDetailPanel ticketId={selectedId} />
      </div>

      {/* Row 3 — trend charts + AI insights: a quick visual pulse, useful
          but secondary to the queue above. */}
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

      {/* Row 4 — executive rollup: the bigger-picture health/maturity view,
          real and live, just not what you need to start your day. */}
      <div className="flex flex-col xl:flex-row gap-4">
        <div className="card p-4 flex-1">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wide">Executive Status</span>
            <span className="text-[11px] text-slate-400 dark:text-slate-500">Updated {lastUpdated}</span>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-3">
            <ExecStat icon={ShieldCheck} value={`${cc.execStatus.reliabilityHealth}%`} label="Reliability" tone="green" />
            <ExecStat icon={AlertTriangle} value={cc.execStatus.openRisks} label="Open Risks" tone="red" />
            <ExecStat icon={Workflow} value={`${cc.execStatus.automationCoverage}%`} label="Automation" tone="blue" />
            <ExecStat icon={Heart} value={cc.execStatus.csatScore != null ? `${cc.execStatus.csatScore}%` : '—'} label="CSAT" tone="purple" />
            <ExecStat icon={ShieldCheck} value={`${cc.execStatus.cabApprovalRate}%`} label="CAB Approved" tone="amber" />
          </div>
        </div>
        <div className="flex flex-row xl:flex-col flex-wrap items-start gap-2 xl:justify-center xl:w-56 shrink-0">
          <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> LIVE
          </span>
          <span className={`badge ${HEALTH_STYLES[cc.operatingHealth] || 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'}`}>
            Operating Health: {cc.operatingHealth}
          </span>
          <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-400">
            Maturity: {cc.maturityStage.from} → {cc.maturityStage.to}
          </span>
        </div>
      </div>

      {/* Row 5 — filters, team roster, orchestration detail: advanced /
          deep-dive tools tucked behind a toggle so they don't compete with
          the actionable rows above for first-glance attention. */}
      <div>
        <button
          onClick={() => setShowFilters((s) => !s)}
          className="text-xs font-medium text-slate-500 dark:text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 flex items-center gap-1.5 mb-2"
        >
          <SlidersHorizontal size={13} /> Filters, team & orchestration detail
          <ChevronDown size={13} className={`transition-transform ${showFilters ? 'rotate-180' : ''}`} />
        </button>

        {showFilters && (
          <div className="space-y-4 animate-fade-in">
            <div className="card p-3 flex flex-wrap items-center gap-2">
              <FilterSelect label="Team" value={filters.team} onChange={(v) => applyFilter('team', v)} options={teamOptions} />
              <FilterSelect label="Priority" value={filters.priority} onChange={(v) => applyFilter('priority', v)} options={PRIORITIES} />
              <FilterSelect label="Type" value={filters.type} onChange={(v) => applyFilter('type', v)} options={TYPES} />
              <FilterSelect label="Status" value={filters.status} onChange={(v) => applyFilter('status', v)} options={STATUSES} />
              <FilterSelect label="Owner" value={filters.owner} onChange={(v) => applyFilter('owner', v)} options={ownerOptions} />
              <FilterSelect label="Time Range" value={filters.days} onChange={(v) => applyFilter('days', v)} options={TIME_RANGES} allLabel={null} />
              <button onClick={resetFilters} className="text-xs text-brand-600 dark:text-brand-400 hover:underline ml-auto">Reset filters</button>
            </div>

            <div className="card p-3 flex items-center gap-4 overflow-x-auto">
              <button onClick={() => applyFilter('owner', '')} className="flex flex-col items-center gap-1 shrink-0">
                <div className={`w-11 h-11 rounded-full flex items-center justify-center ring-2 ${!filters.owner ? 'ring-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'ring-slate-200 dark:ring-white/10 bg-slate-100 dark:bg-slate-800'}`}>
                  <Users size={17} className={!filters.owner ? 'text-brand-600 dark:text-brand-400' : 'text-slate-400 dark:text-slate-500'} />
                </div>
                <div className="text-center leading-tight">
                  <div className="text-xs font-medium text-slate-700 dark:text-slate-200 whitespace-nowrap">Full Team</div>
                  <div className="text-[10px] text-slate-400 dark:text-slate-500 whitespace-nowrap">{cc.team.length} agents</div>
                </div>
              </button>
              <div className="w-px h-10 bg-slate-100 dark:bg-white/10 shrink-0" />
              {cc.team.map((member) => (
                <TeamAvatar
                  key={member.id}
                  member={member}
                  selected={filters.owner === member.id}
                  onClick={() => applyFilter('owner', filters.owner === member.id ? '' : member.id)}
                />
              ))}
            </div>

            {cc.orchestration.map((section) => (
              <div key={section.title}>
                <div className="text-xs font-semibold text-brand-600 dark:text-brand-400 uppercase tracking-wide mb-2">{section.title} →</div>
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {section.chips.map((chip) => (
                    <ChipCard key={chip.label} chip={chip} />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
