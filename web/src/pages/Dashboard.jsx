import { useEffect, useState, useRef } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line, CartesianGrid,
} from 'recharts';
import { Sparkles, Send, AlertTriangle, Clock, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { api } from '../lib/api.js';

const PRIORITY_COLORS = { critical: '#ef4444', high: '#f59e0b', medium: '#6366f1', low: '#94a3b8' };
const STATUS_COLORS = { open: '#6366f1', in_progress: '#f59e0b', on_hold: '#94a3b8', resolved: '#10b981', closed: '#64748b' };

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

export default function Dashboard() {
  const [stats, setStats] = useState(null);
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

  useEffect(() => {
    loadStats();
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chat]);

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

  if (!stats) {
    return <div className="text-slate-400 text-sm py-20 text-center">Loading dashboard…</div>;
  }

  const priorityData = stats.byPriority.map((p) => ({ name: p.priority, value: p.c }));
  const statusData = stats.byStatus.map((s) => ({ name: s.status.replace('_', ' '), value: s.c }));
  const trendData = stats.last7days.map((d) => ({ date: d.d.slice(5), tickets: d.c }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold text-slate-800">Dashboard</h1>
          <p className="text-sm text-slate-500">Live overview of your service desk</p>
        </div>
        <button onClick={loadStats} className="btn-secondary">
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard icon={Inbox} label="Open tickets" value={stats.openCount} tone="brand" />
        <StatCard icon={AlertTriangle} label="SLA at risk / breached" value={stats.slaBreached} tone="red" />
        <StatCard icon={Clock} label="Total tickets" value={stats.totalCount} tone="amber" />
        <StatCard
          icon={Sparkles}
          label="Categories tracked"
          value={stats.byCategory.filter((c) => c.category).length}
          tone="green"
        />
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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="card p-4 lg:col-span-2">
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

        <div className="card p-4 bg-gradient-to-br from-brand-600 to-brand-800 text-white">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-1.5">
              <Sparkles size={15} /> AI Insights
            </h3>
            <button
              onClick={generateInsights}
              disabled={insightsLoading}
              className="text-xs bg-white/15 hover:bg-white/25 rounded-md px-2 py-1 flex items-center gap-1"
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
