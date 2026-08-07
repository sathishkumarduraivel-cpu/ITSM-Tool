import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, ShoppingBag, BookOpen, Ticket, Bot, Wand2, Send, Loader2, Copy, Check } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

function SonaPanel() {
  const [tab, setTab] = useState('describe'); // 'describe' | 'status'

  const [rough, setRough] = useState('');
  const [described, setDescribed] = useState('');
  const [describing, setDescribing] = useState(false);
  const [describeError, setDescribeError] = useState('');
  const [copied, setCopied] = useState(false);

  const [question, setQuestion] = useState('');
  const [chat, setChat] = useState([]);
  const [asking, setAsking] = useState(false);
  const chatEndRef = useRef(null);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chat]);

  const runDescribe = async (e) => {
    e.preventDefault();
    if (!rough.trim()) return;
    setDescribing(true);
    setDescribeError('');
    setDescribed('');
    try {
      const { description } = await api.post('/ai/describe-problem', { text: rough });
      setDescribed(description);
    } catch (err) {
      setDescribeError(err.message);
    } finally {
      setDescribing(false);
    }
  };

  const copyDescribed = async () => {
    try {
      await navigator.clipboard.writeText(described);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard API unavailable — nothing to do, text is still visible to select manually
    }
  };

  const runAsk = async (e) => {
    e.preventDefault();
    if (!question.trim()) return;
    const q = question.trim();
    setChat((c) => [...c, { role: 'user', text: q }]);
    setQuestion('');
    setAsking(true);
    try {
      const { answer } = await api.post('/ai/my-tickets-ask', { question: q });
      setChat((c) => [...c, { role: 'ai', text: answer }]);
    } catch (err) {
      setChat((c) => [...c, { role: 'ai', text: `Error: ${err.message}` }]);
    } finally {
      setAsking(false);
    }
  };

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3">
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shrink-0">
          <Bot size={14} className="text-white" />
        </div>
        <h3 className="text-sm font-semibold text-slate-800 dark:text-slate-100">Sona</h3>
      </div>

      <div className="flex gap-1 mb-3 border-b border-slate-100 dark:border-slate-800">
        <button
          onClick={() => setTab('describe')}
          className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${tab === 'describe' ? 'border-brand-600 text-brand-700 dark:text-brand-400' : 'border-transparent text-slate-500'}`}
        >
          Help me describe my problem
        </button>
        <button
          onClick={() => setTab('status')}
          className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px ${tab === 'status' ? 'border-brand-600 text-brand-700 dark:text-brand-400' : 'border-transparent text-slate-500'}`}
        >
          What's the status of my ticket?
        </button>
      </div>

      {tab === 'describe' && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500 dark:text-slate-400">Type roughly what's going on — Sona will clean it up into a clear description you can paste into a new ticket.</p>
          <form onSubmit={runDescribe} className="flex gap-2">
            <input className="input" placeholder="e.g. my laptop wifi keeps dropping since this morning…" value={rough} onChange={(e) => setRough(e.target.value)} />
            <button type="submit" disabled={describing} className="btn-primary shrink-0">
              {describing ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />}
            </button>
          </form>
          {describeError && <p className="text-xs text-red-600">{describeError}</p>}
          {described && (
            <div className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3 text-sm text-slate-700 dark:text-slate-200 relative">
              {described}
              <button onClick={copyDescribed} className="absolute top-2 right-2 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200" title="Copy">
                {copied ? <Check size={13} className="text-emerald-500" /> : <Copy size={13} />}
              </button>
            </div>
          )}
        </div>
      )}

      {tab === 'status' && (
        <div className="space-y-2">
          <div className="max-h-52 overflow-y-auto space-y-2 pr-1">
            {chat.length === 0 && <p className="text-xs text-slate-400">Try: "What's happening with my VPN ticket?" or "Is anything still open?"</p>}
            {chat.map((m, i) => (
              <div key={i} className={`text-sm rounded-lg px-3 py-2 max-w-[90%] whitespace-pre-line ${m.role === 'user' ? 'bg-brand-600 text-white ml-auto' : 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200'}`}>
                {m.text}
              </div>
            ))}
            {asking && (
              <div className="text-sm rounded-lg px-3 py-2 bg-slate-100 dark:bg-slate-800 text-slate-400 w-fit flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" /> checking…
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <form onSubmit={runAsk} className="flex gap-2">
            <input className="input" placeholder="Ask about your tickets…" value={question} onChange={(e) => setQuestion(e.target.value)} />
            <button type="submit" disabled={asking} className="btn-primary shrink-0"><Send size={14} /></button>
          </form>
        </div>
      )}
    </div>
  );
}

export default function PortalHome() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [tickets, setTickets] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      // Server already scopes this to the caller's own tickets for the
      // requester role — the client-side filter is just defense in depth.
      const { tickets } = await api.get('/tickets');
      setTickets(tickets.filter((t) => t.requester_id === user.id));
      setLoading(false);
    })();
  }, [user.id]);

  const open = tickets.filter((t) => !['resolved', 'closed'].includes(t.status));
  const closed = tickets.filter((t) => ['resolved', 'closed'].includes(t.status));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Hi {user.name.split(' ')[0]} 👋</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Submit requests, track tickets, and find answers — all in one place.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <button onClick={() => navigate('/catalog')} className="card p-5 text-left hover:shadow-md dark:hover:border-slate-700 transition-shadow">
          <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 flex items-center justify-center mb-3"><ShoppingBag size={18} /></div>
          <div className="font-medium text-slate-800 dark:text-slate-100">Browse Service Catalog</div>
          <div className="text-sm text-slate-500">Request hardware, software &amp; access</div>
        </button>
        <button onClick={() => navigate('/tickets')} className="card p-5 text-left hover:shadow-md dark:hover:border-slate-700 transition-shadow">
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400 flex items-center justify-center mb-3"><Plus size={18} /></div>
          <div className="font-medium text-slate-800 dark:text-slate-100">Report an issue</div>
          <div className="text-sm text-slate-500">Something broken? Log an incident</div>
        </button>
        <button onClick={() => navigate('/knowledge-base')} className="card p-5 text-left hover:shadow-md dark:hover:border-slate-700 transition-shadow">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400 flex items-center justify-center mb-3"><BookOpen size={18} /></div>
          <div className="font-medium text-slate-800 dark:text-slate-100">Search Knowledge Base</div>
          <div className="text-sm text-slate-500">Find a quick answer yourself</div>
        </button>
      </div>

      <SonaPanel />

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5"><Ticket size={15} /> My open tickets ({open.length})</h3>
        {loading && <SkeletonRows count={2} />}
        {!loading && open.length === 0 && <div className="text-sm text-slate-400 py-6 text-center">Nothing open right now.</div>}
        <div className="space-y-2">
          {open.map((t) => (
            <button key={t.id} onClick={() => navigate(`/tickets/${t.id}`)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60 text-left">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs text-slate-400">{t.number}</span>
                <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{t.title}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <TypeBadge type={t.type} />
                <PriorityBadge priority={t.priority} />
                <StatusBadge status={t.status} />
              </div>
            </button>
          ))}
        </div>
      </div>

      {closed.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Recently closed</h3>
          <div className="space-y-2">
            {closed.slice(0, 5).map((t) => (
              <button key={t.id} onClick={() => navigate(`/tickets/${t.id}`)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-slate-50 dark:hover:bg-slate-800/60 text-left">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono text-xs text-slate-400">{t.number}</span>
                  <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{t.title}</span>
                </div>
                <StatusBadge status={t.status} />
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
