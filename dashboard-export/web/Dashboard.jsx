import { useEffect, useMemo, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid,
} from 'recharts';
import {
  Sparkles, Send, AlertTriangle, Clock, Inbox, Loader2, RefreshCw, ShieldCheck, Workflow, Heart,
  ChevronDown, ExternalLink, Users, ClipboardList,
} from 'lucide-react';
import { api } from '../lib/api.js';

const PRIORITY_COLORS = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#94a3b8' };
const STATUS_COLORS = { open: '#6366f1', in_progress: '#f59e0b', on_hold: '#94a3b8', resolved: '#10b981', closed: '#64748b' };
const TYPE_COLORS = { incident: '#ef4444', request: '#6366f1', problem: '#8b5cf6', change: '#0ea5e9' };

const HEALTH_STYLES = {
  Healthy: 'bg-emerald-50 text-emerald-700',
  Stable: 'bg-brand-50 text-brand-700',
  'At Risk': 'bg-red-50 text-red-600',
};

const CHIP_TONE = {
  green: { border: 'border-emerald-400', bg: 'bg-emerald-50/70', text: 'text-emerald-700' },
  amber: { border: 'border-amber-400', bg: 'bg-amber-50/70', text: 'text-amber-700' },
  blue: { border: 'border-brand-400', bg: 'bg-brand-50/70', text: 'text-brand-700' },
  red: { border: 'border-red-400', bg: 'bg-red-50/70', text: 'text-red-600' },
};

const EXEC_TONE = { green: 'text-emerald-600', red: 'text-red-600', blue: 'text-brand-600', amber: 'text-amber-600', purple: 'text-purple-600' };
const KPI_TAG_TONE = { slate: 'text-slate-400', green: 'text-emerald-600', amber: 'text-amber-600', red: 'text-red-600', blue: 'text-brand-600' };

const TIME_RANGES = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
];
const PRIORITIES = ['critical', 'high', 'medium', 'low'];
const TYPES = ['incident', 'request', 'problem', 'change'];
const STATUSES = ['open', 'in_progress', 'on_hold', 'resolved', 'closed'];

function StatCard({ icon: Icon, label, value, tone = 'brand' }) {
  const tones = {
    brand: 'bg-brand-50 text-brand-600',
    red: 'bg-red-50 text-red-600',
    amber: 'bg-amber-50 text-amber-600',
    green: 'bg-emerald-50 text-emerald-600',
  };
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${tones[tone]}`}>
        <Icon size={18} />
      </div>
      <div>
        <div className="text-2xl font-semibold text-slate-800 leading-none">{value}</div>
        <div className="text-xs text-slate-500 mt-1">{label}</div>
      </div>
    </div>
  );
}

function ExecStat({ icon: Icon, value, label, tone }) {
  return (
    <div className="flex flex-col items-center text-center gap-1">
      <Icon size={17} className={EXEC_TONE[tone] || 'text-slate-500'} />
      <div className="text-lg font-bold text-slate-800 leading-none">{value}</div>
      <div className="text-[10px] text-slate-400 leading-tight">{label}</div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options, allLabel = 'All' }) {
  return (
    <div className="relative">
      <select
        className="appearance-none text-xs font-medium bg-slate-50 border border-slate-200 rounded-lg pl-2.5 pr-6 py-1.5 text-slate-600 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500 cursor-pointer"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {allLabel !== null && <option value="">{label}: {allLabel}</option>}
        {options.map((o) => (
          typeof o === 'string'
            ? <option key={o} value={o}>{label}: {o.replace('_', ' ')}</option>
            : <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown size={12} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
    </div>
  );
}

function TeamAvatar({ member, selected, onClick }) {
  const initials = member.name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase();
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-1 shrink-0 group">
      <div className="relative">
        <div
          className={`w-11 h-11 rounded-full flex items-center justify-center text-white text-sm font-semibold ring-2 shadow-sm transition-all ${selected ? 'ring-brand-500' : 'ring-white group-hover:ring-brand-200'}`}
          style={{ backgroundColor: member.avatar_color }}
        >
          {initials}
        </div>
        <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full ring-2 ring-white ${member.active ? 'bg-emerald-500' : 'bg-slate-300'}`} />
      </div>
      <div className="text-center leading-tight">
        <div className="text-xs font-medium text-slate-700 whitespace-nowrap">{member.name.split(' ')[0]}</div>
        <div className="text-[10px] text-slate-400 whitespace-nowrap">{member.team || member.role}</div>
      </div>
    </button>
  );
}

function ChipCard({ chip }) {
  const tone = CHIP_TONE[chip.tone] || CHIP_TONE.blue;
  return (
    <div className={`rounded-xl border-l-4 ${tone.border} ${tone.bg} px-3 py-2.5 min-w-0`}>
      <div className="flex items-start justify-between gap-1.5 mb-1">
        <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wide leading-tight">{chip.label}</span>
        <span className={`text-[10px] font-medium ${tone.text} whitespace-nowrap shrink-0`}>{chip.status}</span>
      </div>
      <div className="text-xl font-bold text-slate-800">{chip.value}</div>
    </div>
  );
}

function KpiCard({ title, tag, tagTone = 'slate', children }) {
  return (
    <div className="card p-4 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">{title}</h4>
        {tag && <span className={`text-[10px] font-medium whitespace-nowrap ${KPI_TAG_TONE[tagTone]}`}>{tag}</span>}
      </div>
      {children}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [stats, setStats] = useState(null);
  const [cc, setCc] = useState(null);
  const [filters, setFilters] = useState({ days: '30', team: '', priority: '', type: '', status: '', owner: '' });
  const [insights, setInsights] = useState('');
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState('');
  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState([]);
  const [asking, setAsking] = useState(false);
  const chatEndRef = useRef(null);

  const loadAll = async (f) => {
    const active = f || filters;
    const query = new URLSearchParams(Object.entries(active).filter(([, v]) => v)).toString();
    const [dash, command] = await Promise.all([
      api.get('/ai/dashboard-stats'),
      api.get(`/ai/command-center-stats${query ? `?${query}` : ''}`),
    ]);
    setStats(dash.stats);
    setCc(command.stats);
  };

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

  const applyFilter = (key, value) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    loadAll(next);
  };

  const resetFilters = () => {
    const next = { days: '30', team: '', priority: '', type: '', status: '', owner: '' };
    setFilters(next);
    loadAll(next);
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

  const teamOptions = useMemo(() => {
    if (!cc) return [];
    return [...new Set(cc.team.map((m) => m.team).filter(Boolean))];
  }, [cc]);

  const ownerOptions = useMemo(() => {
    if (!cc) return [];
    return cc.team.map((m) => ({ value: m.id, label: m.name }));
  }, [cc]);

  if (!stats || !cc) {
    return <div className="text-slate-400 text-sm py-20 text-center">Loading command center…</div>;
  }

  const priorityData = stats.byPriority.map((p) => ({ name: p.priority, value: p.c }));
  const statusData = stats.byStatus.map((s) => ({ name: s.status.replace('_', ' '), value: s.c }));
  const trendData = stats.last7days.map((d) => ({ date: d.d.slice(5), tickets: d.c }));

  const reliabilityTrend = cc.kpi.reliability.trend.map((t) => ({ d: t.d.slice(5), c: t.c }));
  const workloadTrend = cc.kpi.workload.trend.map((t) => ({ d: t.d.slice(5), c: t.c }));
  const maxRisk = cc.kpi.riskExposure.breakdown[0]?.c || 1;
  const readinessRows = [
    { label: 'Documentation', value: cc.kpi.readiness.documentation },
    { label: 'Known Errors', value: cc.kpi.readiness.knownErrorReadiness },
    { label: 'Ownership', value: cc.kpi.readiness.triageCoverage },
    { label: 'Automation', value: cc.kpi.readiness.automationCoverage },
  ];
  const lastUpdated = new Date(cc.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="space-y-5">
      {/* Header + Executive Status */}
      <div className="flex flex-col xl:flex-row xl:items-start justify-between gap-4">
        <div>
          <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Module · Service Desk Operations</div>
          <h1 className="text-2xl font-bold text-slate-800">ITSM Command Center</h1>
          <p className="text-sm text-slate-500 mt-1 max-w-xl">
            Protect ticket SLAs, changes, problems, and major incidents while scaling the service desk operating model.
          </p>
        </div>
        <div className="card p-4 w-full xl:min-w-[420px] xl:w-auto">
          <div className="flex items-center justify-between mb-3">
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">Executive Status</span>
            <button onClick={() => navigate('/reports')} className="text-[11px] text-brand-600 hover:underline flex items-center gap-1">
              View full report <ExternalLink size={11} />
            </button>
          </div>
          <div className="grid grid-cols-5 gap-3">
            <ExecStat icon={ShieldCheck} value={`${cc.execStatus.reliabilityHealth}%`} label="Reliability" tone="green" />
            <ExecStat icon={AlertTriangle} value={cc.execStatus.openRisks} label="Open Risks" tone="red" />
            <ExecStat icon={Workflow} value={`${cc.execStatus.automationCoverage}%`} label="Automation" tone="blue" />
            <ExecStat icon={Heart} value={cc.execStatus.csatScore != null ? `${cc.execStatus.csatScore}%` : '—'} label="CSAT" tone="purple" />
            <ExecStat icon={ShieldCheck} value={`${cc.execStatus.cabApprovalRate}%`} label="CAB Approved" tone="amber" />
          </div>
        </div>
      </div>

      {/* Live status bar */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge bg-emerald-50 text-emerald-700">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> LIVE
        </span>
        <span className="text-xs text-slate-400">Last updated: {lastUpdated}</span>
        <span className={`badge ${HEALTH_STYLES[cc.operatingHealth] || 'bg-slate-100 text-slate-600'}`}>
          Operating Health: {cc.operatingHealth}
        </span>
        <span className="badge bg-brand-50 text-brand-700">
          Maturity: {cc.maturityStage.from} → {cc.maturityStage.to}
        </span>
        <button onClick={() => loadAll()} className="btn-secondary ml-auto text-xs">
          <RefreshCw size={12} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="card p-3 flex flex-wrap items-center gap-2">
        <FilterSelect label="Team" value={filters.team} onChange={(v) => applyFilter('team', v)} options={teamOptions} />
        <FilterSelect label="Priority" value={filters.priority} onChange={(v) => applyFilter('priority', v)} options={PRIORITIES} />
        <FilterSelect label="Type" value={filters.type} onChange={(v) => applyFilter('type', v)} options={TYPES} />
        <FilterSelect label="Status" value={filters.status} onChange={(v) => applyFilter('status', v)} options={STATUSES} />
        <FilterSelect label="Owner" value={filters.owner} onChange={(v) => applyFilter('owner', v)} options={ownerOptions} />
        <FilterSelect label="Time Range" value={filters.days} onChange={(v) => applyFilter('days', v)} options={TIME_RANGES} allLabel={null} />
        <button onClick={resetFilters} className="text-xs text-brand-600 hover:underline ml-auto">Reset filters</button>
      </div>

      {/* Engagement team */}
      <div className="card p-3 flex items-center gap-4 overflow-x-auto">
        <button onClick={() => applyFilter('owner', '')} className="flex flex-col items-center gap-1 shrink-0">
          <div className={`w-11 h-11 rounded-full flex items-center justify-center ring-2 ${!filters.owner ? 'ring-brand-500 bg-brand-50' : 'ring-slate-200 bg-slate-100'}`}>
            <Users size={17} className={!filters.owner ? 'text-brand-600' : 'text-slate-400'} />
          </div>
          <div className="text-center leading-tight">
            <div className="text-xs font-medium text-slate-700 whitespace-nowrap">Full Team</div>
            <div className="text-[10px] text-slate-400 whitespace-nowrap">{cc.team.length} agents</div>
          </div>
        </button>
        <div className="w-px h-10 bg-slate-100 shrink-0" />
        {cc.team.map((member) => (
          <TeamAvatar
            key={member.id}
            member={member}
            selected={filters.owner === member.id}
            onClick={() => applyFilter('owner', filters.owner === member.id ? '' : member.id)}
          />
        ))}
      </div>

      {/* Data orchestration chip rows */}
      {cc.orchestration.map((section) => (
        <div key={section.title}>
          <div className="text-xs font-semibold text-brand-600 uppercase tracking-wide mb-2">{section.title} →</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {section.chips.map((chip) => (
              <ChipCard key={chip.label} chip={chip} />
            ))}
          </div>
        </div>
      ))}

      {/* KPI grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
        <KpiCard title="Reliability Health" tag={cc.kpi.reliability.value >= 90 ? 'Healthy' : 'Watch'} tagTone={cc.kpi.reliability.value >= 90 ? 'green' : 'amber'}>
          <div className="text-3xl font-bold text-emerald-600">{cc.kpi.reliability.value}%</div>
          {reliabilityTrend.length > 1 && (
            <div className="w-full h-10 mt-1">
              <ResponsiveContainer width="100%" height="100%" debounce={0}>
                <LineChart data={reliabilityTrend} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                  <Line type="monotone" dataKey="c" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          <ul className="mt-2 space-y-1">
            {cc.kpi.reliability.contributors.map((c, i) => (
              <li key={i} className="text-[11px] text-slate-500 flex items-start gap-1">
                <span className="text-emerald-500 mt-0.5">•</span>{c}
              </li>
            ))}
          </ul>
        </KpiCard>

        <KpiCard title="Risk Exposure" tag={cc.kpi.riskExposure.total > 0 ? 'Elevated' : 'Clear'} tagTone={cc.kpi.riskExposure.total > 0 ? 'red' : 'green'}>
          <div className="text-3xl font-bold text-red-600">{cc.kpi.riskExposure.total}</div>
          <div className="text-[11px] text-slate-400 mb-2">Open critical / SLA-risk tickets</div>
          <div className="space-y-1.5">
            {cc.kpi.riskExposure.breakdown.length === 0 && <div className="text-[11px] text-slate-400">No risk categories flagged</div>}
            {cc.kpi.riskExposure.breakdown.map((b) => (
              <div key={b.category} className="flex items-center gap-2">
                <span className="text-[11px] text-slate-500 w-16 truncate">{b.category}</span>
                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-red-400 rounded-full" style={{ width: `${Math.min(100, (b.c / maxRisk) * 100)}%` }} />
                </div>
                <span className="text-[11px] text-slate-500 w-4 text-right">{b.c}</span>
              </div>
            ))}
          </div>
        </KpiCard>

        <KpiCard title="Change & Problem Debt" tag={`${cc.kpi.changeProblemDebt.resolvedPct}% resolved`} tagTone="blue">
          <div className="flex items-center gap-3">
            <div className="w-[72px] h-[72px] shrink-0">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={[{ name: 'resolved', value: cc.kpi.changeProblemDebt.resolvedPct }, { name: 'remaining', value: cc.kpi.changeProblemDebt.remainingPct }]}
                    dataKey="value" innerRadius={22} outerRadius={34} startAngle={90} endAngle={-270}
                  >
                    <Cell fill="#6366f1" />
                    <Cell fill="#e2e8f0" />
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div>
              <div className="text-xl font-bold text-slate-800">{cc.kpi.changeProblemDebt.resolvedPct}%</div>
              <div className="text-[11px] text-slate-400">Resolved</div>
            </div>
          </div>
          <div className="mt-2 space-y-1">
            {cc.kpi.changeProblemDebt.topDebt.length === 0 && <div className="text-[11px] text-slate-400">No outstanding debt</div>}
            {cc.kpi.changeProblemDebt.topDebt.map((d) => (
              <div key={d.label} className="flex justify-between text-[11px] text-slate-500">
                <span>{d.label}</span><span className="font-medium text-slate-700">{d.value}</span>
              </div>
            ))}
          </div>
        </KpiCard>

        <KpiCard title="Team Workload" tag="On track" tagTone="blue">
          <div className="text-3xl font-bold text-brand-600">{cc.kpi.workload.avgPerAgent}</div>
          <div className="text-[11px] text-slate-400 mb-1">Avg open tickets / agent</div>
          {workloadTrend.length > 1 && (
            <div className="w-full h-10">
              <ResponsiveContainer width="100%" height="100%" debounce={0}>
                <LineChart data={workloadTrend} margin={{ top: 2, right: 2, bottom: 2, left: 2 }}>
                  <Line type="monotone" dataKey="c" stroke="#6366f1" strokeWidth={2} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
          {cc.kpi.workload.unassignedOpen > 0 && (
            <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-1.5">
              <div className="text-[11px] text-amber-700 font-medium">Unassigned backlog</div>
              <div className="text-sm font-bold text-amber-800">{cc.kpi.workload.unassignedOpen} ticket{cc.kpi.workload.unassignedOpen === 1 ? '' : 's'}</div>
            </div>
          )}
        </KpiCard>

        <KpiCard title="Team Readiness" tag={`${Math.round(readinessRows.reduce((s, r) => s + r.value, 0) / readinessRows.length)}%`} tagTone="green">
          <div className="space-y-2 mt-1">
            {readinessRows.map((r) => (
              <div key={r.label}>
                <div className="flex justify-between text-[11px] text-slate-500 mb-0.5">
                  <span>{r.label}</span><span className="font-medium text-slate-700">{r.value}%</span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-purple-400 rounded-full" style={{ width: `${r.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </KpiCard>
      </div>

      {/* Posture / Process resilience / Executive insights */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Ticket Mix by Type</h3>
          <ResponsiveContainer width="100%" height={150}>
            <PieChart>
              <Pie data={cc.ticketMix.map((t) => ({ name: t.type, value: t.c }))} dataKey="value" nameKey="name" innerRadius={38} outerRadius={62} paddingAngle={2}>
                {cc.ticketMix.map((t, i) => (
                  <Cell key={i} fill={TYPE_COLORS[t.type] || '#94a3b8'} />
                ))}
              </Pie>
              <Tooltip />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-1.5 justify-center mt-1">
            {cc.ticketMix.map((t) => (
              <span key={t.type} className="badge" style={{ backgroundColor: `${TYPE_COLORS[t.type]}1a`, color: TYPE_COLORS[t.type] }}>
                {t.type} · {t.c}
              </span>
            ))}
          </div>
        </div>

        <div className="card p-4 xl:col-span-2">
          <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
            <ClipboardList size={14} /> Critical Process Resilience
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[10px] text-slate-400 uppercase tracking-wide">
                  <th className="pb-2 font-medium pr-2">Process</th>
                  <th className="pb-2 font-medium pr-2">Health</th>
                  <th className="pb-2 font-medium pr-2">Owner</th>
                  <th className="pb-2 font-medium pr-2">Key Dependencies</th>
                  <th className="pb-2 font-medium">Insight</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {cc.workflowResilience.map((w) => (
                  <tr key={w.workflow}>
                    <td className="py-2 pr-2 font-medium text-slate-700 whitespace-nowrap">{w.workflow}</td>
                    <td className="py-2 pr-2"><span className={`badge ${HEALTH_STYLES[w.health] || 'bg-slate-100 text-slate-600'}`}>{w.health}</span></td>
                    <td className="py-2 pr-2 text-slate-500 whitespace-nowrap">{w.owner}</td>
                    <td className="py-2 pr-2 text-slate-500">{w.deps}</td>
                    <td className="py-2 text-slate-500">{w.insight}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card p-4 bg-gradient-to-br from-brand-600 to-brand-800 text-white flex flex-col">
          <h3 className="text-sm font-semibold flex items-center gap-1.5 mb-2">
            <AlertTriangle size={15} /> Executive Insights
          </h3>
          <ul className="space-y-1.5 mb-3">
            {cc.risks.map((r, i) => (
              <li key={i} className="text-xs text-brand-50/90 flex items-start gap-1.5">
                <span className="mt-0.5">•</span>{r}
              </li>
            ))}
          </ul>
          <div className="border-t border-white/15 pt-3 mt-auto">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold flex items-center gap-1"><Sparkles size={12} /> AI Analysis</span>
              <button
                onClick={generateInsights}
                disabled={insightsLoading}
                className="text-[11px] bg-white/15 hover:bg-white/25 rounded-md px-2 py-1 flex items-center gap-1"
              >
                {insightsLoading ? <Loader2 size={11} className="animate-spin" /> : <Sparkles size={11} />} Generate
              </button>
            </div>
            {insightsError && <p className="text-[11px] text-red-100 bg-red-500/30 rounded-md p-1.5 mb-1">{insightsError}</p>}
            <p className="text-xs text-brand-50/90 whitespace-pre-line leading-relaxed">
              {insights || 'Click Generate for an AI-authored risk & trend summary. Configure a provider under AI Settings.'}
            </p>
          </div>
        </div>
      </div>

      {/* Detail charts */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <StatCard icon={Inbox} label="Open tickets" value={stats.openCount} tone="brand" />
        <StatCard icon={AlertTriangle} label="SLA at risk / breached" value={stats.slaBreached} tone="red" />
        <StatCard icon={Clock} label="Total tickets" value={stats.totalCount} tone="amber" />
        <StatCard icon={Sparkles} label="Categories tracked" value={stats.byCategory.filter((c) => c.category).length} tone="green" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card p-4 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Ticket volume — last 7 days</h3>
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

        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">By priority</h3>
          <ResponsiveContainer width="100%" height={220}>
            <PieChart>
              <Pie data={priorityData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={75} paddingAngle={2}>
                {priorityData.map((entry, i) => (
                  <Cell key={i} fill={PRIORITY_COLORS[entry.name] || '#94a3b8'} />
                ))}
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
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3">By status</h3>
        <ResponsiveContainer width="100%" height={200}>
          <BarChart data={statusData} layout="vertical" margin={{ left: 10 }}>
            <XAxis type="number" allowDecimals={false} tick={{ fontSize: 12 }} stroke="#94a3b8" />
            <YAxis type="category" dataKey="name" tick={{ fontSize: 12 }} width={90} stroke="#94a3b8" />
            <Tooltip />
            <Bar dataKey="value" radius={[0, 6, 6, 0]}>
              {statusData.map((entry, i) => (
                <Cell key={i} fill={STATUS_COLORS[entry.name.replace(' ', '_')] || '#6366f1'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-1.5">
          <Sparkles size={15} className="text-brand-600" /> Ask AI about your service desk
        </h3>
        <div className="max-h-64 overflow-y-auto space-y-2 mb-3 pr-1">
          {chat.length === 0 && (
            <p className="text-sm text-slate-400">
              Try: "Which team has the most open tickets?" or "What's our SLA breach risk right now?"
            </p>
          )}
          {chat.map((m, i) => (
            <div key={i} className={`text-sm rounded-lg px-3 py-2 max-w-[85%] whitespace-pre-line ${m.role === 'user' ? 'bg-brand-600 text-white ml-auto' : 'bg-slate-100 text-slate-700'}`}>
              {m.text}
            </div>
          ))}
          {asking && (
            <div className="text-sm rounded-lg px-3 py-2 bg-slate-100 text-slate-400 w-fit flex items-center gap-1.5">
              <Loader2 size={12} className="animate-spin" /> thinking…
            </div>
          )}
          <div ref={chatEndRef} />
        </div>
        <form onSubmit={askAI} className="flex gap-2">
          <input
            className="input"
            placeholder="Ask a question about your tickets…"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={asking}>
            <Send size={14} />
          </button>
        </form>
      </div>
    </div>
  );
}
