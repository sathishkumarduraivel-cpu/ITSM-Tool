import { useEffect, useState, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid,
} from 'recharts';
import { Sparkles, Send, AlertTriangle, Clock, Inbox, Layers, Loader2, RefreshCw, LayoutGrid, Check, ArrowUp, ArrowDown, Eye, EyeOff } from 'lucide-react';
import { api } from '../lib/api.js';
import StatCard from '../components/StatCard.jsx';
import PageHeader from '../components/PageHeader.jsx';

const PRIORITY_COLORS = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#94a3b8' };
const STATUS_COLORS = { open: '#6366f1', in_progress: '#f59e0b', on_hold: '#94a3b8', resolved: '#10b981', closed: '#64748b' };
const STAT_ICONS = { openCount: Inbox, slaBreached: AlertTriangle, totalCount: Clock, categoryCount: Layers };

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

export default function Dashboard() {
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
  const chatEndRef = useRef(null);

  const loadStats = async () => {
    const { stats } = await api.get('/ai/dashboard-stats');
    setStats(stats);
  };

  const loadLayout = async () => {
    const [{ layout }, { available }] = await Promise.all([api.get('/dashboard/layout'), api.get('/dashboard/catalog')]);
    setLayout(layout);
    setCatalog(available);
  };

  useEffect(() => {
    loadStats();
    loadLayout();
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
        title="Dashboard"
        description="Live overview of your service desk"
        actions={
          <>
            <button onClick={() => setEditing((e) => !e)} className="btn-secondary">
              <LayoutGrid size={14} /> {editing ? 'Close' : 'Edit layout'}
            </button>
            <button onClick={loadStats} className="btn-secondary">
              <RefreshCw size={14} /> Refresh
            </button>
          </>
        }
      />

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

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5">
          <Sparkles size={15} className="text-brand-600" /> Ask AI about your service desk
        </h3>
        <div className="max-h-64 overflow-y-auto space-y-2 mb-3 pr-1">
          {chat.length === 0 && (
            <p className="text-sm text-slate-400">
              Try: "Which team has the most open tickets?" or "What's our SLA breach risk right now?"
            </p>
          )}
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
