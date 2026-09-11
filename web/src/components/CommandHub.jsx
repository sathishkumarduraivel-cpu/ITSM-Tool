import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import { Bot, Send, X, Loader2, Sparkles, FileText, Wand2, Radar, Tags, BookOpen, Ticket } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

const QUICK_ACTIONS = [
  { key: 'summarize', label: 'Summarize', icon: FileText, endpoint: 'summarize', busyLabel: 'Summarizing ticket…', extract: (r) => r.summary },
  { key: 'suggest', label: 'Suggest fix', icon: Wand2, endpoint: 'suggest-resolution', busyLabel: 'Drafting a suggested resolution…', extract: (r) => r.suggestion },
  { key: 'root_cause', label: 'Root cause', icon: Radar, endpoint: 'root-cause', busyLabel: 'Analyzing root cause…', extract: (r) => r.analysis },
  { key: 'categorize', label: 'Categorize', icon: Tags, endpoint: 'categorize', busyLabel: 'Auto-categorizing…', extract: (r) => `Category: ${r.result.category}${r.result.subcategory ? ' / ' + r.result.subcategory : ''}\nSentiment: ${r.result.sentiment || '—'}` },
];

// Reveals `text` a chunk at a time while `active`, so a fresh AI response
// reads as streamed-in rather than dumped on screen all at once. Chunk size
// scales with length so a long analysis doesn't take forever to finish, and
// a short one doesn't blink past too fast to feel intentional.
function useStreamingText(text, active) {
  const [shown, setShown] = useState(active ? '' : text);
  useEffect(() => {
    if (!active) { setShown(text); return undefined; }
    setShown('');
    let i = 0;
    const step = Math.max(1, Math.round(text.length / 90));
    const id = setInterval(() => {
      i += step;
      setShown(text.slice(0, i));
      if (i >= text.length) clearInterval(id);
    }, 14);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, active]);
  return shown;
}

function MessageBubble({ message, streaming, onStreamDone }) {
  const shown = useStreamingText(message.text, streaming);
  useEffect(() => {
    if (streaming && shown.length >= message.text.length) onStreamDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  if (message.role === 'action') {
    return <div className="text-xs text-slate-400 dark:text-slate-500 italic px-1">{message.text}</div>;
  }
  if (message.role === 'error') {
    return <div className="text-sm rounded-2xl px-3.5 py-2.5 bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-400 max-w-[88%]">{message.text}</div>;
  }
  const isUser = message.role === 'user';
  return (
    <div
      className={`text-sm rounded-2xl px-3.5 py-2.5 max-w-[88%] whitespace-pre-line leading-relaxed ${
        isUser
          ? 'bg-gradient-to-br from-brand-500 to-brand-600 text-white ml-auto shadow-glow-brand'
          : 'card-flat text-slate-700 dark:text-slate-200'
      }`}
    >
      {shown}
      {streaming && shown.length < message.text.length && (
        <span className="inline-block w-1 h-3.5 bg-current ml-0.5 align-middle animate-pulse" />
      )}
    </div>
  );
}

const listVariants = { hidden: {}, show: { transition: { staggerChildren: 0.06 } } };
const itemVariants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 320, damping: 28 } },
};

// Global, context-aware AI hub: mounted once in AppShell so it's reachable
// from every page via Ctrl/Cmd+J or the floating trigger. On a ticket page
// it scopes to that ticket (quick actions + a chat that knows what you're
// looking at); everywhere else it's the workspace-wide "ask Sona anything"
// experience already backed by /ai/ask (agent/admin) or /ai/my-tickets-ask
// (requester, server-enforced to only ever see their own tickets).
export default function CommandHub() {
  const { user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const shouldReduceMotion = useReducedMotion();
  const isAgent = user.role === 'admin' || user.role === 'agent';

  const [open, setOpen] = useState(false);
  const [ticketMeta, setTicketMeta] = useState(null);
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [quickBusy, setQuickBusy] = useState('');
  const [streamingIndex, setStreamingIndex] = useState(null);
  const endRef = useRef(null);
  // Requesters get a choice between two different jobs this same panel does:
  // triage a brand-new problem (Knowledge Base first, ticket only if it
  // can't be resolved that way) versus ask about tickets they already have.
  // Agents/admins never see this toggle -- their experience is unchanged.
  const [mode, setMode] = useState('new_issue');
  const [ssSessionId, setSsSessionId] = useState(null);
  const [escalating, setEscalating] = useState(false);

  const ticketMatch = useMemo(() => location.pathname.match(/^\/tickets\/([^/]+)$/), [location.pathname]);
  const ticketId = ticketMatch ? ticketMatch[1] : null;
  // Read inside the async callback below (a ref, not the `ticketId` above,
  // since that would be captured at its stale value from when the effect
  // was scheduled -- a ref's `.current` always reflects the latest render).
  const ticketIdRef = useRef(ticketId);
  ticketIdRef.current = ticketId;

  // Auto-open when arriving via a "?copilot=1" deep link (e.g. the
  // dashboard's Predictive Triage Queue "Open in Sona" button), then strip
  // the param so refreshing/sharing the URL doesn't keep re-opening it.
  useEffect(() => {
    if (new URLSearchParams(location.search).get('copilot') === '1') {
      setOpen(true);
      navigate(location.pathname, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  useEffect(() => {
    setMessages([]);
    setTicketMeta(null);
    setSsSessionId(null);
    if (ticketId && open) {
      const requestedId = ticketId;
      api.get(`/tickets/${requestedId}`).then((d) => {
        // Ignore a response for a ticket the user has already navigated away
        // from (e.g. clicked a "merged into" link while this was in flight)
        // -- without this, a slower response for the earlier ticket can
        // resolve after a faster one and overwrite the panel with the wrong
        // ticket's context while the header still names the new one.
        if (ticketIdRef.current !== requestedId) return;
        setTicketMeta(d.ticket);
      }).catch(() => setTicketMeta(null));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, open, mode]);

  useEffect(() => {
    function onKeyDown(e) {
      const isShortcut = (isMac ? e.metaKey : e.ctrlKey) && e.key.toLowerCase() === 'j';
      if (isShortcut) {
        e.preventDefault();
        setOpen((o) => !o);
      }
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, asking]);

  const pushAndStream = (text) => {
    setMessages((m) => {
      setStreamingIndex(m.length);
      return [...m, { role: 'ai', text }];
    });
  };

  const runQuickAction = async (action) => {
    setQuickBusy(action.key);
    setMessages((m) => [...m, { role: 'action', text: action.busyLabel }]);
    try {
      const res = await api.post(`/tickets/${ticketId}/ai/${action.endpoint}`, {});
      pushAndStream(action.extract(res));
    } catch (e) {
      setMessages((m) => [...m, { role: 'error', text: e.message }]);
    } finally {
      setQuickBusy('');
    }
  };

  const pushAndStreamRich = (text, extra) => {
    setMessages((m) => {
      setStreamingIndex(m.length);
      return [...m, { role: 'ai', text, ...extra }];
    });
  };

  const sendNewIssueMessage = async (q) => {
    try {
      let sessionId = ssSessionId;
      if (!sessionId) {
        const { session } = await api.post('/self-service/sessions', {});
        sessionId = session.id;
        setSsSessionId(sessionId);
      }
      const res = await api.post(`/self-service/sessions/${sessionId}/messages`, { message: q });
      pushAndStreamRich(res.reply, {
        kbArticles: res.kbArticles,
        suggestTicket: res.suggestTicket,
        ticketDraft: res.ticketDraft,
        sessionId,
      });
    } catch (e) {
      setMessages((m) => [...m, { role: 'error', text: e.message }]);
    }
  };

  const askFreeform = async (e) => {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    setMessages((m) => [...m, { role: 'user', text: q }]);
    setQuestion('');
    setAsking(true);
    try {
      if (!isAgent && !ticketId && mode === 'new_issue') {
        await sendNewIssueMessage(q);
      } else {
        const endpoint = isAgent ? '/ai/ask' : '/ai/my-tickets-ask';
        const { answer } = await api.post(endpoint, { question: q });
        pushAndStream(answer);
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'error', text: e.message }]);
    } finally {
      setAsking(false);
    }
  };

  const createTicketFromDraft = async (message, index) => {
    setEscalating(true);
    try {
      const { ticket } = await api.post(`/self-service/sessions/${message.sessionId}/escalate`, message.ticketDraft);
      setMessages((m) => m.map((msg, i) => (i === index ? { ...msg, ticketCreated: ticket } : msg)));
      setOpen(false);
      navigate(`/tickets/${ticket.id}`);
    } catch (e) {
      setMessages((m) => [...m, { role: 'error', text: e.message }]);
    } finally {
      setEscalating(false);
    }
  };

  const panelTransition = shouldReduceMotion
    ? { duration: 0 }
    : { type: 'spring', stiffness: 340, damping: 32 };

  return (
    <>
      <AnimatePresence>
        {!open && (
          <motion.button
            key="trigger"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0, opacity: 0 }}
            whileHover={shouldReduceMotion ? undefined : { scale: 1.08 }}
            whileTap={{ scale: 0.94 }}
            transition={{ type: 'spring', stiffness: 420, damping: 24 }}
            onClick={() => setOpen(true)}
            className="fixed bottom-6 right-6 z-40 w-14 h-14 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 shadow-glow-brand flex items-center justify-center text-white"
            title={`Open Sona (${isMac ? '⌘' : 'Ctrl'}+J)`}
          >
            <Bot size={22} />
            {!shouldReduceMotion && <span className="absolute inset-0 rounded-full border-2 border-brand-400/60 animate-ping" />}
          </motion.button>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div
            key="panel"
            initial={{ x: '105%' }}
            animate={{ x: 0 }}
            exit={{ x: '105%' }}
            transition={panelTransition}
            className="fixed inset-y-0 right-0 w-full sm:w-[420px] z-50 sm:p-3"
          >
            <div className="h-full glass-panel sm:rounded-3xl border-l sm:border border-white/60 dark:border-white/[0.07] flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3.5 border-b border-slate-100 dark:border-slate-800 shrink-0">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="relative w-8 h-8 rounded-full bg-gradient-to-br from-brand-500 to-brand-700 flex items-center justify-center shrink-0">
                    <Bot size={15} className="text-white" />
                    <span className="absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-400 ring-2 ring-white dark:ring-slate-900" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800 dark:text-slate-100">Sona</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {ticketId && ticketMeta ? <>Focused on <span className="font-mono">{ticketMeta.number}</span></> : 'Workspace command hub'}
                    </div>
                  </div>
                </div>
                <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 shrink-0">
                  <X size={17} />
                </button>
              </div>

              {ticketId && isAgent && (
                <div className="flex gap-1.5 px-3 py-2.5 border-b border-slate-100 dark:border-slate-800 overflow-x-auto shrink-0">
                  {QUICK_ACTIONS.map((a) => (
                    <motion.button
                      key={a.key}
                      whileTap={{ scale: 0.95 }}
                      disabled={!!quickBusy}
                      onClick={() => runQuickAction(a)}
                      className="btn-secondary text-xs shrink-0"
                    >
                      {quickBusy === a.key ? <Loader2 size={12} className="animate-spin" /> : <a.icon size={12} />} {a.label}
                    </motion.button>
                  ))}
                </div>
              )}

              {!isAgent && !ticketId && (
                <div className="flex gap-1 p-1.5 mx-3 mt-3 mb-0 rounded-full bg-slate-100 dark:bg-slate-800 shrink-0">
                  {[{ key: 'new_issue', label: 'New issue' }, { key: 'my_tickets', label: 'My tickets' }].map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setMode(t.key)}
                      className={`flex-1 text-xs font-medium py-1.5 rounded-full transition-colors ${mode === t.key ? 'bg-white dark:bg-slate-700 text-slate-800 dark:text-slate-100 shadow-sm' : 'text-slate-500 dark:text-slate-400'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
              )}

              <motion.div variants={listVariants} initial="hidden" animate="show" className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
                {messages.length === 0 && (
                  <div className="h-full flex flex-col items-center justify-center text-center text-slate-400 dark:text-slate-500 gap-2 py-10">
                    <Sparkles size={22} className="opacity-50" />
                    <p className="text-sm max-w-[220px]">
                      {ticketId
                        ? 'Ask about this ticket, or run a quick action above.'
                        : !isAgent && mode === 'new_issue'
                          ? "Describe what's going wrong — I'll check the Knowledge Base first, and offer to log a ticket if I can't resolve it."
                          : !isAgent
                            ? 'Ask about any of your own tickets.'
                            : 'Ask Sona anything about your service desk.'}
                    </p>
                  </div>
                )}
                {messages.map((m, i) => (
                  <motion.div key={i} variants={itemVariants}>
                    <MessageBubble message={m} streaming={i === streamingIndex} onStreamDone={() => setStreamingIndex(null)} />
                    {m.kbArticles?.length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mt-1.5 ml-1">
                        {m.kbArticles.map((a) => (
                          <span key={a.id} className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 flex items-center gap-1">
                            <BookOpen size={10} /> {a.title}
                          </span>
                        ))}
                      </div>
                    )}
                    {m.suggestTicket && m.ticketDraft && !m.ticketCreated && (
                      <div className="card-flat mt-2 p-3 space-y-1.5">
                        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400"><Ticket size={12} /> Suggested ticket</div>
                        <div className="text-sm font-medium text-slate-800 dark:text-slate-100">{m.ticketDraft.title}</div>
                        <p className="text-xs text-slate-500 dark:text-slate-400 line-clamp-3">{m.ticketDraft.description}</p>
                        <div className="flex gap-1.5">
                          <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{m.ticketDraft.type}</span>
                          <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{m.ticketDraft.priority}</span>
                        </div>
                        <button onClick={() => createTicketFromDraft(m, i)} disabled={escalating} className="btn-primary text-xs w-full justify-center mt-1">
                          {escalating ? <Loader2 size={12} className="animate-spin" /> : <Ticket size={12} />} Create this ticket
                        </button>
                      </div>
                    )}
                    {m.ticketCreated && (
                      <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-1.5 ml-1">Created {m.ticketCreated.number} ✓</div>
                    )}
                  </motion.div>
                ))}
                {asking && (
                  <motion.div variants={itemVariants} className="text-sm rounded-2xl px-3.5 py-2.5 card-flat text-slate-400 w-fit flex items-center gap-1.5">
                    <Loader2 size={12} className="animate-spin" /> thinking…
                  </motion.div>
                )}
                <div ref={endRef} />
              </motion.div>

              <form onSubmit={askFreeform} className="p-3 border-t border-slate-100 dark:border-slate-800 shrink-0">
                <div className="command-glow rounded-full">
                  <div className="flex items-center gap-2 card !rounded-full px-3 py-1">
                    <input
                      autoFocus
                      className="flex-1 bg-transparent border-none outline-none text-sm py-2 text-slate-800 dark:text-slate-100 placeholder:text-slate-400"
                      placeholder={
                        ticketId
                          ? 'Ask about this ticket…'
                          : !isAgent && mode === 'new_issue'
                            ? "Describe what's happening…"
                            : !isAgent
                              ? 'Ask about your tickets…'
                              : 'Ask about your whole service desk…'
                      }
                      value={question}
                      onChange={(e) => setQuestion(e.target.value)}
                    />
                    <button type="submit" disabled={asking || !question.trim()} className="btn-primary !rounded-full !p-2 shrink-0">
                      {asking ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
                    </button>
                  </div>
                </div>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
