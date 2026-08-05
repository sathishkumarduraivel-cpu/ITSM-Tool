import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Sparkles, Loader2, Send, Wand2, Tags, Lock, ShieldCheck, Check, X, Boxes, Star } from 'lucide-react';
import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';

const STATUSES = ['open', 'in_progress', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const RISKS = ['low', 'medium', 'high'];

function CsatPrompt({ ticketId, existing, onSubmitted }) {
  const [rating, setRating] = useState(existing?.rating || 0);
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);

  if (existing) {
    return (
      <div className="card p-4 bg-amber-50/60 border-amber-100">
        <h3 className="text-sm font-semibold text-slate-700 mb-1">Your feedback</h3>
        <div className="flex gap-0.5 mb-1">
          {[1, 2, 3, 4, 5].map((n) => <Star key={n} size={16} className={n <= existing.rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />)}
        </div>
        {existing.comment && <p className="text-sm text-slate-600">{existing.comment}</p>}
      </div>
    );
  }

  const submit = async () => {
    if (!rating) return;
    setSaving(true);
    try {
      await api.post(`/tickets/${ticketId}/csat`, { rating, comment });
      onSubmitted();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card p-4 bg-amber-50/60 border-amber-100">
      <h3 className="text-sm font-semibold text-slate-700 mb-2">How did we do?</h3>
      <div className="flex gap-1 mb-2">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} onClick={() => setRating(n)}>
            <Star size={20} className={n <= rating ? 'fill-amber-400 text-amber-400' : 'text-slate-300'} />
          </button>
        ))}
      </div>
      <textarea className="input mb-2" rows={2} placeholder="Optional comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
      <button onClick={submit} disabled={!rating || saving} className="btn-primary text-xs">
        {saving ? <Loader2 size={13} className="animate-spin" /> : null} Submit feedback
      </button>
    </div>
  );
}

export default function TicketDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAgent = user.role === 'admin' || user.role === 'agent';
  const [ticket, setTicket] = useState(null);
  const [comments, setComments] = useState([]);
  const [history, setHistory] = useState([]);
  const [approvals, setApprovals] = useState([]);
  const [linkedAssets, setLinkedAssets] = useState([]);
  const [csat, setCsat] = useState(null);
  const [allAssets, setAllAssets] = useState([]);
  const [comment, setComment] = useState('');
  const [posting, setPosting] = useState(false);
  const [aiBusy, setAiBusy] = useState('');
  const [aiError, setAiError] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [fieldError, setFieldError] = useState('');

  const load = async () => {
    const data = await api.get(`/tickets/${id}`);
    setTicket(data.ticket);
    setComments(data.comments);
    setHistory(data.history);
    setApprovals(data.approvals || []);
    setLinkedAssets(data.linkedAssets || []);
    setCsat(data.csat);
  };

  useEffect(() => {
    load();
    if (isAgent) api.get('/assets').then(({ assets }) => setAllAssets(assets));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const updateField = async (field, value) => {
    setFieldError('');
    try {
      const { ticket: updated } = await api.patch(`/tickets/${id}`, { [field]: value });
      setTicket(updated);
    } catch (e) {
      setFieldError(e.message);
    }
  };

  const postComment = async (e) => {
    e.preventDefault();
    if (!comment.trim()) return;
    setPosting(true);
    try {
      await api.post(`/tickets/${id}/comments`, { body: comment });
      setComment('');
      await load();
    } finally {
      setPosting(false);
    }
  };

  const runAI = async (action) => {
    setAiBusy(action);
    setAiError('');
    try {
      if (action === 'summarize') {
        const { summary } = await api.post(`/tickets/${id}/ai/summarize`, {});
        setTicket((t) => ({ ...t, ai_summary: summary }));
      } else if (action === 'suggest') {
        const { suggestion } = await api.post(`/tickets/${id}/ai/suggest-resolution`, {});
        setSuggestion(suggestion);
      } else if (action === 'categorize') {
        await api.post(`/tickets/${id}/ai/categorize`, {});
        await load();
      }
    } catch (e) {
      setAiError(e.message);
    } finally {
      setAiBusy('');
    }
  };

  const decideApproval = async (approvalId, status) => {
    await api.post(`/approvals/${approvalId}/decide`, { status });
    load();
  };

  const linkAsset = async (assetId) => {
    if (!assetId) return;
    await api.post(`/tickets/${id}/assets`, { asset_id: assetId });
    load();
  };

  const unlinkAsset = async (assetId) => {
    await api.del(`/tickets/${id}/assets/${assetId}`);
    load();
  };

  if (!ticket) return <div className="text-slate-400 text-sm py-20 text-center">Loading ticket…</div>;

  const isChange = ticket.type === 'change';
  const pendingApproval = approvals.find((a) => a.status === 'pending');
  const statusOptions = ticket.status === 'pending_approval' ? ['pending_approval', ...STATUSES] : STATUSES;

  return (
    <div className="space-y-4">
      <Link to="/tickets" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Back to tickets
      </Link>

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-sm text-slate-500">{ticket.number}</span>
            <TypeBadge type={ticket.type} />
            {isChange && (
              <span className={`badge ${ticket.cab_status === 'approved' ? 'bg-emerald-50 text-emerald-700' : ticket.cab_status === 'rejected' ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-700'}`}>
                <ShieldCheck size={11} /> CAB {ticket.cab_status?.replace('_', ' ')}
              </span>
            )}
          </div>
          <h1 className="text-xl font-semibold text-slate-800">{ticket.title}</h1>
        </div>
        {isAgent && (
          <div className="flex gap-2">
            <button onClick={() => runAI('summarize')} disabled={aiBusy} className="btn-secondary">
              {aiBusy === 'summarize' ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} Summarize
            </button>
            <button onClick={() => runAI('categorize')} disabled={aiBusy} className="btn-secondary">
              {aiBusy === 'categorize' ? <Loader2 size={14} className="animate-spin" /> : <Tags size={14} />} Auto-categorize
            </button>
            <button onClick={() => runAI('suggest')} disabled={aiBusy} className="btn-primary">
              {aiBusy === 'suggest' ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Suggest resolution
            </button>
          </div>
        )}
      </div>

      {aiError && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{aiError}</div>}
      {fieldError && <div className="text-sm text-red-600 bg-red-50 rounded-lg px-3 py-2">{fieldError}</div>}

      {pendingApproval && user.role === 'admin' && (
        <div className="card p-4 bg-amber-50/70 border-amber-200 flex items-center justify-between">
          <span className="text-sm text-amber-800">{isChange ? 'This change is awaiting CAB approval.' : 'This request is awaiting your approval.'}</span>
          <div className="flex gap-2">
            <button onClick={() => decideApproval(pendingApproval.id, 'rejected')} className="btn-danger text-xs"><X size={13} /> Reject</button>
            <button onClick={() => decideApproval(pendingApproval.id, 'approved')} className="btn-primary text-xs"><Check size={13} /> Approve</button>
          </div>
        </div>
      )}

      {ticket.status === 'resolved' && !isAgent && (
        <CsatPrompt ticketId={id} existing={csat} onSubmitted={load} />
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-2">Description</h3>
            <p className="text-sm text-slate-600 whitespace-pre-line">{ticket.description || 'No description provided.'}</p>
          </div>

          {isChange && (
            <div className="card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5"><ShieldCheck size={14} /> Change details</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">Risk</label>
                  <select className="input" disabled={!isAgent} value={ticket.risk || ''} onChange={(e) => updateField('risk', e.target.value)}>
                    <option value="">Not set</option>
                    {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <div />
                <div>
                  <label className="label">Planned start</label>
                  <input type="datetime-local" className="input" disabled={!isAgent} defaultValue={ticket.planned_start?.slice(0, 16) || ''} onBlur={(e) => updateField('planned_start', e.target.value)} />
                </div>
                <div>
                  <label className="label">Planned end</label>
                  <input type="datetime-local" className="input" disabled={!isAgent} defaultValue={ticket.planned_end?.slice(0, 16) || ''} onBlur={(e) => updateField('planned_end', e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label">Rollback plan</label>
                <textarea className="input" rows={2} disabled={!isAgent} defaultValue={ticket.rollback_plan || ''} onBlur={(e) => updateField('rollback_plan', e.target.value)} />
              </div>
            </div>
          )}

          {ticket.ai_summary && (
            <div className="card p-4 border-brand-200 bg-brand-50/50">
              <h3 className="text-sm font-semibold text-brand-700 mb-2 flex items-center gap-1.5"><Sparkles size={14} /> AI Summary</h3>
              <p className="text-sm text-slate-700 whitespace-pre-line">{ticket.ai_summary}</p>
            </div>
          )}

          {suggestion && (
            <div className="card p-4 border-emerald-200 bg-emerald-50/50">
              <h3 className="text-sm font-semibold text-emerald-700 mb-2 flex items-center gap-1.5"><Wand2 size={14} /> AI Suggested Resolution</h3>
              <p className="text-sm text-slate-700 whitespace-pre-line">{suggestion}</p>
            </div>
          )}

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-3">Activity</h3>
            <div className="space-y-3 mb-4 max-h-80 overflow-y-auto pr-1">
              {comments.length === 0 && <p className="text-sm text-slate-400">No comments yet.</p>}
              {comments.map((c) => (
                <div key={c.id} className={`rounded-lg p-3 text-sm ${c.is_ai ? 'bg-brand-50' : 'bg-slate-50'}`}>
                  <div className="flex items-center gap-2 mb-1 text-xs text-slate-500">
                    <span className="font-medium text-slate-700">{c.author_name || 'Unknown'}</span>
                    {!!c.is_ai && <span className="badge bg-brand-100 text-brand-700"><Sparkles size={10} /> AI</span>}
                    {!!c.is_private && <span className="badge bg-slate-200 text-slate-600"><Lock size={10} /> private</span>}
                    <span>· {new Date(c.created_at).toLocaleString()}</span>
                  </div>
                  <p className="text-slate-700 whitespace-pre-line">{c.body}</p>
                </div>
              ))}
            </div>
            <form onSubmit={postComment} className="flex gap-2">
              <input className="input" placeholder="Add a comment…" value={comment} onChange={(e) => setComment(e.target.value)} />
              <button className="btn-primary" disabled={posting}>
                {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              </button>
            </form>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-700">Details</h3>
            <div>
              <label className="label">Status</label>
              <select className="input" disabled={!isAgent} value={ticket.status} onChange={(e) => updateField('status', e.target.value)}>
                {statusOptions.map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Priority</label>
              <select className="input" disabled={!isAgent} value={ticket.priority} onChange={(e) => updateField('priority', e.target.value)}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Category</label>
              <input className="input" disabled={!isAgent} defaultValue={ticket.category || ''} onBlur={(e) => updateField('category', e.target.value)} />
            </div>
            <div>
              <label className="label">Team</label>
              <input className="input" disabled={!isAgent} defaultValue={ticket.team || ''} onBlur={(e) => updateField('team', e.target.value)} />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
            </div>
          </div>

          <div className="card p-4 space-y-2 text-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-1">SLA</h3>
            <div className="flex justify-between text-slate-500"><span>Response due</span><span className="text-slate-700">{ticket.response_due_at ? new Date(ticket.response_due_at).toLocaleString() : '—'}</span></div>
            <div className="flex justify-between text-slate-500"><span>Resolution due</span><span className="text-slate-700">{ticket.sla_due_at ? new Date(ticket.sla_due_at).toLocaleString() : '—'}</span></div>
            <div className="flex justify-between text-slate-500"><span>Source</span><span className="text-slate-700 capitalize">{ticket.source}</span></div>
            {ticket.ai_sentiment && (
              <div className="flex justify-between text-slate-500"><span>AI sentiment</span><span className="text-slate-700 capitalize">{ticket.ai_sentiment}</span></div>
            )}
          </div>

          {isAgent && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-700 mb-2 flex items-center gap-1.5"><Boxes size={14} /> Linked assets (CMDB)</h3>
              <div className="space-y-1 mb-2">
                {linkedAssets.length === 0 && <p className="text-xs text-slate-400">No assets linked.</p>}
                {linkedAssets.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-sm bg-slate-50 rounded-md px-2 py-1.5">
                    <span className="truncate">{a.name} <span className="text-xs text-slate-400 font-mono">{a.tag}</span></span>
                    <button onClick={() => unlinkAsset(a.id)} className="text-slate-400 hover:text-red-500"><X size={13} /></button>
                  </div>
                ))}
              </div>
              <select className="input text-sm" value="" onChange={(e) => linkAsset(e.target.value)}>
                <option value="">Link an asset…</option>
                {allAssets.filter((a) => !linkedAssets.some((la) => la.id === a.id)).map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.tag})</option>
                ))}
              </select>
            </div>
          )}

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-700 mb-2">History</h3>
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {history.map((h) => (
                <div key={h.id} className="text-xs text-slate-500 border-l-2 border-slate-200 pl-2">
                  <span className="text-slate-700 font-medium">{h.event}</span> — {h.detail}
                  <div className="text-[10px] text-slate-400">{new Date(h.created_at).toLocaleString()}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
