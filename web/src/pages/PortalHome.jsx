import { useEffect, useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Plus, ShoppingBag, BookOpen, Ticket, Bot, Wand2, Send, Loader2, Copy, Check, Search, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';
import { RevealGroup, RevealItem } from '../components/Reveal.jsx';
import ReportIssueModal from '../components/portal/ReportIssueModal.jsx';

// One search box spanning both self-service content types -- Knowledge Base
// articles (answers) and Service Catalog items (things to request) -- so a
// requester doesn't have to guess which page to search from. Mirrors
// GlobalSearch's debounce/click-through pattern (components/GlobalSearch.jsx)
// but scoped to just these two, since a requester has no legitimate use for
// the cross-workspace ticket/asset results that widget also returns.
function PortalSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    function onDocClick(e) { if (ref.current && !ref.current.contains(e.target)) setOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    const query = q.trim();
    if (!query) { setResults(null); return; }
    const handle = setTimeout(async () => {
      try {
        const data = await api.get(`/search?q=${encodeURIComponent(query)}`);
        setResults(data);
        setOpen(true);
      } catch {
        setResults(null);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [q]);

  const hasResults = results && (results.kb.length || results.catalog.length);

  return (
    <div className="relative" ref={ref}>
      <div className="relative">
        <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
        <input
          className="input rounded-full pl-11 pr-4 py-3 text-sm shadow-card dark:shadow-card-dark"
          placeholder="Search for an answer or something to request…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => q && setOpen(true)}
        />
      </div>
      {open && q.trim() && (
        <div className="absolute left-0 right-0 mt-1.5 card p-2 z-40 shadow-popover dark:shadow-popover-dark max-h-80 overflow-y-auto">
          {!hasResults && <div className="text-sm text-slate-400 px-2 py-3 text-center">No matches for "{q}"</div>}
          {results?.kb.length > 0 && (
            <div className="mb-2">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 mb-1">Knowledge Base</div>
              {results.kb.map((k) => (
                <button key={k.id} onClick={() => { navigate('/knowledge-base'); setOpen(false); setQ(''); }} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left">
                  <BookOpen size={14} className="text-emerald-500 shrink-0" />
                  <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{k.title}</span>
                </button>
              ))}
            </div>
          )}
          {results?.catalog.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 px-2 mb-1">Service Catalog</div>
              {results.catalog.map((c) => (
                <button key={c.id} onClick={() => { navigate('/catalog'); setOpen(false); setQ(''); }} className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800 text-left">
                  <ShoppingBag size={14} className="text-brand-500 shrink-0" />
                  <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{c.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  const [reportOpen, setReportOpen] = useState(false);
  const [justCreated, setJustCreated] = useState(null);

  const loadTickets = async () => {
    // Server already scopes this to the caller's own tickets for the
    // requester role — the client-side filter is just defense in depth.
    const { tickets } = await api.get('/tickets');
    setTickets(tickets.filter((t) => t.requester_id === user.id));
    setLoading(false);
  };

  useEffect(() => { loadTickets(); }, [user.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const open = tickets.filter((t) => !['resolved', 'closed'].includes(t.status));
  const closed = tickets.filter((t) => ['resolved', 'closed'].includes(t.status));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">Hi {user.name.split(' ')[0]} 👋</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Submit requests, track tickets, and find answers — all in one place.</p>
      </div>

      <PortalSearch />

      {justCreated && (
        <div className="card p-4 bg-emerald-50 dark:bg-emerald-500/10 border-emerald-200 dark:border-emerald-800 flex items-center justify-between">
          <span className="text-sm text-emerald-700 dark:text-emerald-400 flex items-center gap-2"><CheckCircle2 size={16} /> {justCreated.number} submitted.</span>
          <button onClick={() => navigate(`/tickets/${justCreated.id}`)} className="text-sm font-medium text-emerald-700 dark:text-emerald-400 hover:underline">View ticket</button>
        </div>
      )}

      <RevealGroup className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <RevealItem as={motion.button} whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} onClick={() => navigate('/catalog')} className="card p-5 text-left">
          <div className="w-10 h-10 rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400 flex items-center justify-center mb-3"><ShoppingBag size={18} /></div>
          <div className="font-medium text-slate-800 dark:text-slate-100">Browse Service Catalog</div>
          <div className="text-sm text-slate-500">Request hardware, software &amp; access</div>
        </RevealItem>
        <RevealItem as={motion.button} whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} onClick={() => setReportOpen(true)} className="card p-5 text-left">
          <div className="w-10 h-10 rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400 flex items-center justify-center mb-3"><Plus size={18} /></div>
          <div className="font-medium text-slate-800 dark:text-slate-100">Report an issue</div>
          <div className="text-sm text-slate-500">Something broken? Log an incident</div>
        </RevealItem>
        <RevealItem as={motion.button} whileHover={{ y: -3 }} whileTap={{ scale: 0.98 }} onClick={() => navigate('/knowledge-base')} className="card p-5 text-left">
          <div className="w-10 h-10 rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400 flex items-center justify-center mb-3"><BookOpen size={18} /></div>
          <div className="font-medium text-slate-800 dark:text-slate-100">Search Knowledge Base</div>
          <div className="text-sm text-slate-500">Find a quick answer yourself</div>
        </RevealItem>
      </RevealGroup>

      <SonaPanel />

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5"><Ticket size={15} /> My open tickets ({open.length})</h3>
        {loading && <SkeletonRows count={2} />}
        {!loading && open.length === 0 && <div className="text-sm text-slate-400 py-6 text-center">Nothing open right now.</div>}
        <RevealGroup className="space-y-2">
          {open.map((t) => (
            <RevealItem key={t.id} as={motion.button} whileHover={{ x: 2 }} onClick={() => navigate(`/tickets/${t.id}`)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg row-interactive text-left">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-xs text-slate-400">{t.number}</span>
                <span className="text-sm text-slate-700 dark:text-slate-200 truncate">{t.title}</span>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <TypeBadge type={t.type} />
                <PriorityBadge priority={t.priority} />
                <StatusBadge status={t.status} />
              </div>
            </RevealItem>
          ))}
        </RevealGroup>
      </div>

      {closed.length > 0 && (
        <div className="card p-4">
          <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Recently closed</h3>
          <div className="space-y-2">
            {closed.slice(0, 5).map((t) => (
              <button key={t.id} onClick={() => navigate(`/tickets/${t.id}`)} className="w-full flex items-center justify-between px-3 py-2 rounded-lg row-interactive text-left">
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

      {reportOpen && (
        <ReportIssueModal
          onClose={() => setReportOpen(false)}
          onCreated={(ticket) => { setReportOpen(false); setJustCreated(ticket); loadTickets(); }}
        />
      )}
    </div>
  );
}
