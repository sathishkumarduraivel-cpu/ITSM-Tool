import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Sparkles, Loader2, Send, Wand2, Tags, Lock, ShieldCheck, Check, X, Boxes, Star, Paperclip, Download, Trash2, UserCircle2, Radar } from 'lucide-react';
import { api, getStoredToken } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';
import { useFieldRules } from '../hooks/useFieldRules.js';

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
  const [attachments, setAttachments] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [groups, setGroups] = useState([]);
  const [blastRadius, setBlastRadius] = useState(null);

  const load = async () => {
    const data = await api.get(`/tickets/${id}`);
    setTicket(data.ticket);
    setComments(data.comments);
    setHistory(data.history);
    setApprovals(data.approvals || []);
    setLinkedAssets(data.linkedAssets || []);
    setCsat(data.csat);
    setAttachments(data.attachments || []);
    setBlastRadius(data.blastRadius || null);
  };

  const uploadFiles = async (fileList) => {
    if (!fileList || !fileList.length) return;
    setUploading(true);
    try {
      const formData = new FormData();
      for (const f of fileList) formData.append('files', f);
      await api.upload(`/tickets/${id}/attachments`, formData);
      await load();
    } finally {
      setUploading(false);
    }
  };

  const removeAttachment = async (attId) => {
    await api.del(`/tickets/${id}/attachments/${attId}`);
    load();
  };

  const downloadAttachment = async (att) => {
    const resp = await fetch(`/api/tickets/${id}/attachments/${att.id}/download`, {
      headers: { authorization: `Bearer ${getStoredToken()}` },
    });
    if (!resp.ok) return;
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = att.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const formatSize = (bytes) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  useEffect(() => {
    load();
    if (isAgent) {
      api.get('/assets').then(({ assets }) => setAllAssets(assets));
      api.get('/groups').then(({ groups }) => setGroups(groups));
    }
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

  const fieldRules = useFieldRules(ticket?.type, ticket?.category || null, ticket);

  if (!ticket) return <div className="text-slate-400 text-sm py-20 text-center">Loading ticket…</div>;

  const isChange = ticket.type === 'change';
  const showRisk = fieldRules.isVisible('risk', isChange);
  const showPlannedStart = fieldRules.isVisible('planned_start', isChange);
  const showPlannedEnd = fieldRules.isVisible('planned_end', isChange);
  const showRollbackPlan = fieldRules.isVisible('rollback_plan', isChange);
  const showChangeSection = showRisk || showPlannedStart || showPlannedEnd || showRollbackPlan;
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
              <span className={`badge ${ticket.cab_status === 'approved' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : ticket.cab_status === 'rejected' ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'}`}>
                <ShieldCheck size={11} /> CAB {ticket.cab_status?.replace('_', ' ')}
              </span>
            )}
          </div>
          <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">{ticket.title}</h1>
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

      {aiError && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{aiError}</div>}
      {fieldError && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{fieldError}</div>}

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
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">Description</h3>
            <p className="text-sm text-slate-600 dark:text-slate-300 whitespace-pre-line">{ticket.description || 'No description provided.'}</p>
          </div>

          {showChangeSection && (
            <div className="card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5"><ShieldCheck size={14} /> Change details</h3>
              <div className="grid grid-cols-2 gap-3">
                {showRisk && (
                  <div>
                    <label className="label">Risk</label>
                    <select className="input" disabled={!isAgent} value={ticket.risk || ''} onChange={(e) => updateField('risk', e.target.value)}>
                      <option value="">Not set</option>
                      {RISKS.map((r) => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>
                )}
                {showPlannedStart && (
                  <div>
                    <label className="label">Planned start</label>
                    <input type="datetime-local" className="input" disabled={!isAgent} defaultValue={ticket.planned_start?.slice(0, 16) || ''} onBlur={(e) => updateField('planned_start', e.target.value)} />
                  </div>
                )}
                {showPlannedEnd && (
                  <div>
                    <label className="label">Planned end</label>
                    <input type="datetime-local" className="input" disabled={!isAgent} defaultValue={ticket.planned_end?.slice(0, 16) || ''} onBlur={(e) => updateField('planned_end', e.target.value)} />
                  </div>
                )}
              </div>
              {showRollbackPlan && (
                <div>
                  <label className="label">Rollback plan</label>
                  <textarea className="input" rows={2} disabled={!isAgent} defaultValue={ticket.rollback_plan || ''} onBlur={(e) => updateField('rollback_plan', e.target.value)} />
                </div>
              )}
            </div>
          )}

          {ticket.ai_summary && (
            <div className="card p-4 border-brand-200 dark:border-brand-800 bg-brand-50/50 dark:bg-brand-500/5">
              <h3 className="text-sm font-semibold text-brand-700 dark:text-brand-400 mb-2 flex items-center gap-1.5"><Sparkles size={14} /> AI Summary</h3>
              <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line">{ticket.ai_summary}</p>
            </div>
          )}

          {suggestion && (
            <div className="card p-4 border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-500/5">
              <h3 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 mb-2 flex items-center gap-1.5"><Wand2 size={14} /> AI Suggested Resolution</h3>
              <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line">{suggestion}</p>
            </div>
          )}

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Activity</h3>
            <div className="space-y-3 mb-4 max-h-80 overflow-y-auto pr-1">
              {comments.length === 0 && <p className="text-sm text-slate-400">No comments yet.</p>}
              {comments.map((c) => (
                <div key={c.id} className={`rounded-lg p-3 text-sm ${c.is_ai ? 'bg-brand-50 dark:bg-brand-500/10' : 'bg-slate-50 dark:bg-slate-800/60'}`}>
                  <div className="flex items-center gap-2 mb-1 text-xs text-slate-500">
                    <span className="font-medium text-slate-700 dark:text-slate-200">{c.author_name || 'Unknown'}</span>
                    {!!c.is_ai && <span className="badge bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-400"><Sparkles size={10} /> AI</span>}
                    {!!c.is_private && <span className="badge bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300"><Lock size={10} /> private</span>}
                    <span>· {new Date(c.created_at).toLocaleString()}</span>
                  </div>
                  <p className="text-slate-700 dark:text-slate-200 whitespace-pre-line">{c.body}</p>
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

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3 flex items-center gap-1.5"><Paperclip size={14} /> Attachments</h3>
            <div className="space-y-1.5 mb-3">
              {attachments.length === 0 && <p className="text-sm text-slate-400">No files attached.</p>}
              {attachments.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-2 text-sm bg-slate-50 dark:bg-slate-800/60 rounded-lg px-3 py-2">
                  <button onClick={() => downloadAttachment(a)} className="flex items-center gap-2 min-w-0 text-left hover:text-brand-700 dark:hover:text-brand-400">
                    <Download size={13} className="shrink-0 text-slate-400" />
                    <span className="truncate">{a.filename}</span>
                    <span className="text-xs text-slate-400 shrink-0">{formatSize(a.size)}</span>
                  </button>
                  <button onClick={() => removeAttachment(a.id)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <label className="btn-secondary text-xs cursor-pointer inline-flex">
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <Paperclip size={13} />}
              {uploading ? 'Uploading…' : 'Attach files'}
              <input type="file" multiple className="hidden" onChange={(e) => uploadFiles(e.target.files)} disabled={uploading} />
            </label>
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5"><UserCircle2 size={14} /> Requester</h3>
            <div className="text-sm">
              <div className="text-slate-800 dark:text-slate-100 font-medium">{ticket.requester_name || 'Unknown'}</div>
              {ticket.requester_email && <div className="text-slate-500 dark:text-slate-400 text-xs">{ticket.requester_email}</div>}
            </div>
            {ticket.assignee_name && (
              <div className="text-sm pt-2 border-t border-slate-100 dark:border-slate-800">
                <div className="text-xs text-slate-400 mb-0.5">Assigned to</div>
                <div className="text-slate-800 dark:text-slate-100 font-medium">{ticket.assignee_name}</div>
                {ticket.assignee_email && <div className="text-slate-500 dark:text-slate-400 text-xs">{ticket.assignee_email}</div>}
              </div>
            )}
          </div>

          <div className="card p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Details</h3>
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
              <label className="label">Group</label>
              <select className="input" disabled={!isAgent} value={ticket.team || ''} onChange={(e) => updateField('team', e.target.value)}>
                <option value="">Unassigned</option>
                {groups.map((g) => <option key={g.id} value={g.name}>{g.name}</option>)}
                {ticket.team && !groups.some((g) => g.name === ticket.team) && (
                  <option value={ticket.team}>{ticket.team}</option>
                )}
              </select>
            </div>
            <div className="flex items-center gap-2 pt-1">
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
            </div>
          </div>

          <div className="card p-4 space-y-2 text-sm">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-1">SLA</h3>
            <div className="flex justify-between text-slate-500"><span>Response due</span><span className="text-slate-700 dark:text-slate-200">{ticket.response_due_at ? new Date(ticket.response_due_at).toLocaleString() : '—'}</span></div>
            <div className="flex justify-between text-slate-500"><span>Resolution due</span><span className="text-slate-700 dark:text-slate-200">{ticket.sla_due_at ? new Date(ticket.sla_due_at).toLocaleString() : '—'}</span></div>
            <div className="flex justify-between text-slate-500"><span>Source</span><span className="text-slate-700 dark:text-slate-200 capitalize">{ticket.source}</span></div>
            {ticket.ai_sentiment && (
              <div className="flex justify-between text-slate-500"><span>AI sentiment</span><span className="text-slate-700 dark:text-slate-200 capitalize">{ticket.ai_sentiment}</span></div>
            )}
          </div>

          {isAgent && (
            <div className="card p-4">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-1.5"><Boxes size={14} /> Linked assets (CMDB)</h3>
              <div className="space-y-1 mb-2">
                {linkedAssets.length === 0 && <p className="text-xs text-slate-400">No assets linked.</p>}
                {linkedAssets.map((a) => (
                  <div key={a.id} className="flex items-center justify-between text-sm bg-slate-50 dark:bg-slate-800/60 rounded-md px-2 py-1.5">
                    <span className="truncate">{a.name} <span className="text-xs text-slate-400 font-mono">{a.tag}</span></span>
                    <button onClick={() => unlinkAsset(a.id)} className="text-slate-400 hover:text-red-500"><X size={13} /></button>
                  </div>
                ))}
              </div>

              {blastRadius && blastRadius.affectedCount > 0 && (
                <div className="mb-3 p-2.5 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-900">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-700 dark:text-amber-400 mb-1">
                    <Radar size={13} /> Blast radius: {blastRadius.score}/100
                  </div>
                  <p className="text-xs text-amber-700/90 dark:text-amber-400/90 mb-1.5">
                    {blastRadius.affectedCount} other asset{blastRadius.affectedCount === 1 ? '' : 's'} would be affected if the linked asset{linkedAssets.length === 1 ? '' : 's'} went down.
                  </p>
                  <div className="space-y-0.5 max-h-32 overflow-y-auto">
                    {blastRadius.affected.map((a) => (
                      <div key={a.id} className="text-[11px] text-amber-800/80 dark:text-amber-300/80 truncate">
                        {a.name} <span className="text-amber-600/70 dark:text-amber-500/70">({a.relationship.replace('_', ' ')}, {a.depth} hop{a.depth === 1 ? '' : 's'} away)</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <select className="input text-sm" value="" onChange={(e) => linkAsset(e.target.value)}>
                <option value="">Link an asset…</option>
                {allAssets.filter((a) => !linkedAssets.some((la) => la.id === a.id)).map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.tag})</option>
                ))}
              </select>
            </div>
          )}

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2">History</h3>
            <div className="space-y-2 max-h-56 overflow-y-auto pr-1">
              {history.map((h) => (
                <div key={h.id} className="text-xs text-slate-500 border-l-2 border-slate-200 dark:border-slate-700 pl-2">
                  <span className="text-slate-700 dark:text-slate-200 font-medium">{h.event}</span> — {h.detail}
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
