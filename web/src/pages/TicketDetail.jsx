import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useParams, useNavigate, Link } from 'react-router-dom';
import {
  ArrowLeft, ArrowRight, Sparkles, Loader2, Send, Wand2, Tags, Lock, ShieldCheck, Check, X, Boxes, Star, Paperclip,
  Download, Trash2, UserCircle2, Radar, Milestone, Save, MessageSquare, ChevronDown, ChevronUp,
  UserPlus, CheckCircle2, MoreHorizontal, Ban, Link2, ShieldAlert, Pencil, GitMerge, RotateCcw, XCircle,
  Tag, Search, BookmarkPlus, ListChecks, Plus, Clock, CircleAlert, UserRoundCheck,
} from 'lucide-react';
import { api, getStoredToken } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { PriorityBadge, StatusBadge, TypeBadge } from '../components/Badge.jsx';
import { useBusinessRules } from '../hooks/useBusinessRules.js';
import ExternalLinksPanel from '../components/ExternalLinksPanel.jsx';
import MajorIncidentPanel from '../components/MajorIncidentPanel.jsx';
import Modal from '../components/Modal.jsx';
import { useRealtimeEvent } from '../context/RealtimeContext.jsx';
import Select from '../components/Select.jsx';
import TicketTaskRow from '../components/tickets/TicketTaskRow.jsx';
import AddTicketTaskForm from '../components/tickets/AddTicketTaskForm.jsx';
import { usePageTitle } from '../hooks/usePageTitle.js';

const STATUSES = ['open', 'in_progress', 'on_hold', 'resolved', 'closed'];
const PRIORITIES = ['low', 'medium', 'high', 'critical'];
const RISKS = ['low', 'medium', 'high'];
const TYPES = ['incident', 'request', 'problem', 'change'];

// Renders into document.body instead of inline -- `.card`'s backdrop-blur
// (like any filter/backdrop-filter) creates its own CSS stacking context, so
// a z-index on a menu nested inside one card can never out-rank a *later*
// sibling card's content, no matter how high the z-index goes; the whole
// first card's subtree just paints behind it. A portal sidesteps the whole
// nested-stacking-context problem instead of fighting it with more z-index.
// `menuRef` is a second ref (distinct from the trigger button) so outside-
// click detection can recognize clicks landing inside the portaled panel,
// which is no longer a DOM descendant of the trigger.
function DropdownMenu({ open, anchorRef, menuRef, align = 'left', width = 224, children }) {
  const [pos, setPos] = useState(null);

  useEffect(() => {
    if (!open || !anchorRef.current) { setPos(null); return; }
    const rect = anchorRef.current.getBoundingClientRect();
    setPos({
      top: rect.bottom + window.scrollY + 6,
      left: (align === 'right' ? rect.right - width : rect.left) + window.scrollX,
    });
  }, [open, anchorRef, align, width]);

  if (!open || !pos) return null;
  return createPortal(
    <div
      ref={menuRef}
      style={{ position: 'absolute', top: pos.top, left: pos.left, width }}
      className="card shadow-popover dark:shadow-popover-dark z-[100] p-1.5 animate-fade-in"
    >
      {children}
    </div>,
    document.body
  );
}

// The requester who filed the ticket can fix their own title/description --
// e.g. a typo, or more detail before an agent picks it up -- but nothing
// else (status, priority, assignment, ...) is theirs to touch. Only shown
// while the ticket is still open (the PATCH itself also enforces both of
// these server-side, this is just the matching UI gate).
function RequesterEditModal({ ticket, onClose, onSaved }) {
  const [title, setTitle] = useState(ticket.title);
  const [description, setDescription] = useState(ticket.description || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { ticket: updated } = await api.patch(`/tickets/${ticket.id}`, { title, description });
      onSaved(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit ticket details" onClose={onClose} maxWidth="max-w-lg">
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Title</label>
          <input className="input" required value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save changes
          </button>
        </div>
      </form>
    </Modal>
  );
}

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

// Replaces the plain status dropdown for any ticket type governed by a
// configured lifecycle (Admin Settings → Lifecycles). Only ever offers
// stages the server would actually accept — blocked ones still show, greyed
// out with the reason, so a gate like "requires CAB approval" is visible
// rather than silently missing from the list. Kept as an immediate action
// (its own "Move" click applies right away) rather than folded into the
// page's staged Update flow — a stage transition is a governed, validated
// step, not a plain field edit.
function LifecycleStageControl({ ticketId, lifecycle, isAgent, onTransitioned }) {
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = lifecycle.stages.find((s) => s.key === lifecycle.currentStage);

  const move = async () => {
    if (!target) return;
    setBusy(true);
    setError('');
    try {
      await api.post(`/tickets/${ticketId}/transition`, { to_stage: target });
      setTarget('');
      onTransitioned();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <Milestone size={13} className="text-brand-600 dark:text-brand-400" />
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200">{current?.label || lifecycle.currentStage}</span>
        {lifecycle.isTerminal && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">terminal</span>}
      </div>
      {error && <p className="text-xs text-red-600 dark:text-red-400">{error}</p>}
      {isAgent && !lifecycle.isTerminal && lifecycle.availableTransitions.length > 0 && (
        <div className="flex items-center gap-1.5">
          <Select
            className="min-w-[200px]" placeholder="Move to…"
            value={target} onChange={setTarget}
            options={lifecycle.availableTransitions.map((t) => ({
              value: t.stage.key,
              label: t.stage.label + (!t.allowed ? ` — ${t.reason}` : ''),
              disabled: !t.allowed,
            }))}
          />
          <button onClick={move} disabled={!target || busy} className="btn-secondary shrink-0" title="Move to selected stage">
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />}
          </button>
        </div>
      )}
    </div>
  );
}

// Lets an agent turn what they just typed into a reusable snippet without
// leaving the ticket -- the body is prefilled from the composer's current
// text; team defaults to this ticket's own team since that's the most
// likely scope for a reply written in the middle of handling one of its
// tickets, but stays editable (blank = every team).
function SaveCannedResponseModal({ defaultBody, defaultTeam, onClose, onSaved }) {
  const [title, setTitle] = useState('');
  const [team, setTeam] = useState(defaultTeam || '');
  const [body, setBody] = useState(defaultBody);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      await api.post('/canned-responses', { title, team: team || null, body_html: body });
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Save as canned response" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div>
          <label className="label">Title</label>
          <input className="input" required autoFocus placeholder="e.g. VPN troubleshooting steps" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div>
          <label className="label">Team <span className="text-slate-400 font-normal">— leave blank to share with every team</span></label>
          <input className="input" placeholder="All teams" value={team} onChange={(e) => setTeam(e.target.value)} />
        </div>
        <div>
          <label className="label">Response text</label>
          <textarea className="input" rows={5} required value={body} onChange={(e) => setBody(e.target.value)} />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <BookmarkPlus size={14} />} Save
          </button>
        </div>
      </form>
    </Modal>
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
  // 'reply' -- visible to the requester, emailed to them, and counts as the
  // agent's first response. 'note' -- agent/admin-only, never shown or sent
  // to the requester in any form. Requesters always post as 'reply'.
  const [replyMode, setReplyMode] = useState('reply');
  const [cannedResponses, setCannedResponses] = useState(null); // null = not loaded yet
  const [cannedMenuOpen, setCannedMenuOpen] = useState(false);
  const [cannedQuery, setCannedQuery] = useState('');
  const [saveCannedOpen, setSaveCannedOpen] = useState(false);
  const cannedTriggerRef = useRef(null);
  const cannedPanelRef = useRef(null);
  const commentRef = useRef(null);
  const [aiBusy, setAiBusy] = useState('');
  const [aiError, setAiError] = useState('');
  const [suggestion, setSuggestion] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [showAddTask, setShowAddTask] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [groups, setGroups] = useState([]);
  const [agents, setAgents] = useState([]);
  const [blastRadius, setBlastRadius] = useState(null);
  const [customValues, setCustomValues] = useState([]);
  const [customFieldDefs, setCustomFieldDefs] = useState([]);
  const [lifecycle, setLifecycle] = useState(null);
  const [externalLinks, setExternalLinks] = useState([]);
  const [mergedFrom, setMergedFrom] = useState([]);
  const [mergedInto, setMergedInto] = useState(null);
  const [majorIncident, setMajorIncident] = useState(null);
  const [relatedMajorIncidents, setRelatedMajorIncidents] = useState([]);
  const [activityOpen, setActivityOpen] = useState(false);

  // Every field edit below is staged here, not sent to the server, until the
  // agent explicitly clicks Update -- one PATCH applies everything at once
  // instead of a network call per keystroke/select. `draft` covers built-in
  // columns, `draftCustom` covers custom field values (a separate object
  // since it's PATCHed under its own `custom` key).
  const [draft, setDraft] = useState({});
  const [draftCustom, setDraftCustom] = useState({});
  const [saving, setSaving] = useState(false);
  const dirty = Object.keys(draft).length > 0 || Object.keys(draftCustom).length > 0;

  // Quick one-click actions (Assign to me, Resolve, spam moderation) apply
  // immediately rather than joining the staged draft -- each is a single,
  // deliberate action with an obvious result, the same reasoning that
  // already keeps the lifecycle "Move" control immediate.
  const [actionBusy, setActionBusy] = useState('');
  const [aiMenuOpen, setAiMenuOpen] = useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [linkCopied, setLinkCopied] = useState(false);
  // Each menu needs two refs -- the trigger button, and the portaled panel
  // itself (a DOM sibling of <body>, not a descendant of the trigger, so a
  // single ref can't cover "click landed on either part of this menu").
  const aiTriggerRef = useRef(null);
  const aiPanelRef = useRef(null);
  const moreTriggerRef = useRef(null);
  const morePanelRef = useRef(null);
  const [requesterCardOpen, setRequesterCardOpen] = useState(false);
  const requesterTriggerRef = useRef(null);
  const requesterPanelRef = useRef(null);
  const [requesterEditOpen, setRequesterEditOpen] = useState(false);

  useEffect(() => {
    const onClick = (e) => {
      if (aiMenuOpen && !aiTriggerRef.current?.contains(e.target) && !aiPanelRef.current?.contains(e.target)) setAiMenuOpen(false);
      if (moreMenuOpen && !moreTriggerRef.current?.contains(e.target) && !morePanelRef.current?.contains(e.target)) setMoreMenuOpen(false);
      if (requesterCardOpen && !requesterTriggerRef.current?.contains(e.target) && !requesterPanelRef.current?.contains(e.target)) setRequesterCardOpen(false);
      if (cannedMenuOpen && !cannedTriggerRef.current?.contains(e.target) && !cannedPanelRef.current?.contains(e.target)) setCannedMenuOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [aiMenuOpen, moreMenuOpen, requesterCardOpen, cannedMenuOpen]);

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
    setCustomValues(data.custom || []);
    setLifecycle(data.lifecycle || null);
    setExternalLinks(data.externalLinks || []);
    setMergedFrom(data.mergedFrom || []);
    setMergedInto(data.mergedInto || null);
    setMajorIncident(data.majorIncident || null);
    setRelatedMajorIncidents(data.relatedMajorIncidents || []);
    setTasks(data.tasks || []);
  };

  // Someone else editing/commenting on this same ticket right now (a second
  // agent, or the requester replying from their own session) shows up here
  // live instead of waiting for a manual refresh -- payloads only ever carry
  // an id (see server/src/services/realtime.js), so this always re-fetches
  // through the normal permission-checked GET rather than trusting pushed data.
  useRealtimeEvent('ticket.updated', (p) => { if (p.ticketId === id) load(); });
  useRealtimeEvent('ticket.comment', (p) => { if (p.ticketId === id) load(); });
  useRealtimeEvent('ticket.bulk_updated', (p) => { if (p.ticketIds?.includes(id)) load(); });

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
    setDraft({});
    setDraftCustom({});
    setReplyMode('reply');
    if (isAgent) {
      api.get('/assets').then(({ assets }) => setAllAssets(assets));
      api.get('/groups').then(({ groups }) => setGroups(groups));
      api.get('/tickets/assignable-agents').then(({ agents }) => setAgents(agents)).catch(() => setAgents([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Field definitions (type/options) for editing custom field values --
  // separate from `customValues`, which only carries the current label+value
  // pairs. Requesters never edit these, so this fetch is agent-only.
  useEffect(() => {
    if (!ticket?.type || !isAgent) return;
    api.get(`/custom-fields?ticket_type=${ticket.type}`).then(({ fields }) => setCustomFieldDefs(fields)).catch(() => setCustomFieldDefs([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket?.type, isAgent]);

  const setDraftField = (field, value) => setDraft((d) => ({ ...d, [field]: value }));
  const setDraftCustomField = (key, value) => setDraftCustom((d) => ({ ...d, [key]: value }));
  const val = (field) => (draft[field] !== undefined ? draft[field] : ticket?.[field]);

  const saveUpdate = async () => {
    if (!dirty) return;
    setFieldError('');
    setSaving(true);
    try {
      const payload = { ...draft };
      if (Object.keys(draftCustom).length) payload.custom = draftCustom;
      const { ticket: updated, custom } = await api.patch(`/tickets/${id}`, payload);
      setTicket(updated);
      if (custom) setCustomValues(custom);
      setDraft({});
      setDraftCustom({});
    } catch (e) {
      setFieldError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const assignToMe = async () => {
    setActionBusy('assign');
    setFieldError('');
    try {
      const { ticket: updated } = await api.patch(`/tickets/${id}`, { assignee_id: user.id });
      setTicket(updated);
      setDraft((d) => { const { assignee_id, ...rest } = d; return rest; });
    } catch (e) {
      setFieldError(e.message);
    } finally {
      setActionBusy('');
    }
  };

  const resolveNow = async () => {
    setActionBusy('resolve');
    setFieldError('');
    try {
      const { ticket: updated } = await api.patch(`/tickets/${id}`, { status: 'resolved' });
      setTicket(updated);
      setDraft((d) => { const { status, ...rest } = d; return rest; });
    } catch (e) {
      setFieldError(e.message);
    } finally {
      setActionBusy('');
    }
  };

  // Requester self-service: the general PATCH above stays locked to
  // title/description for them (see routes/tickets.js), so these are their
  // own narrow, server-validated routes instead of a widened PATCH allowlist.
  const reopenTicket = async () => {
    setActionBusy('reopen');
    setFieldError('');
    try {
      const { ticket: updated } = await api.post(`/tickets/${id}/reopen`, {});
      setTicket(updated);
    } catch (e) {
      setFieldError(e.message);
    } finally {
      setActionBusy('');
    }
  };

  const cancelRequest = async () => {
    if (!confirm('Cancel this request?')) return;
    setActionBusy('cancel');
    setFieldError('');
    try {
      const { ticket: updated } = await api.post(`/tickets/${id}/cancel`, {});
      setTicket(updated);
    } catch (e) {
      setFieldError(e.message);
    } finally {
      setActionBusy('');
    }
  };

  const markSpam = async () => {
    if (!confirm('Mark this ticket as spam? It will be closed and removed from the default queue — this can be undone.')) return;
    setActionBusy('spam');
    setMoreMenuOpen(false);
    try {
      await api.post(`/tickets/${id}/spam`, {});
      setDraft({});
      setDraftCustom({});
      await load();
    } catch (e) {
      setFieldError(e.message);
    } finally {
      setActionBusy('');
    }
  };

  const unmarkSpam = async () => {
    setActionBusy('unspam');
    setMoreMenuOpen(false);
    try {
      await api.post(`/tickets/${id}/unspam`, {});
      await load();
    } catch (e) {
      setFieldError(e.message);
    } finally {
      setActionBusy('');
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(window.location.href).then(() => {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 1500);
    });
    setMoreMenuOpen(false);
  };

  const addTask = async (form) => {
    const { tasks: next } = await api.post(`/tickets/${id}/tasks`, form);
    setTasks(next);
  };
  const updateTask = async (taskId, patch) => {
    const { tasks: next } = await api.patch(`/tickets/${id}/tasks/${taskId}`, patch);
    setTasks(next);
  };
  const deleteTask = async (taskId) => {
    const { tasks: next } = await api.del(`/tickets/${id}/tasks/${taskId}`);
    setTasks(next);
  };
  // Same two-parallel-PATCH sort_order swap already used for SLA Policies
  // and Lifecycle Stages -- one interaction pattern for "reorder a list" app-wide.
  const moveTask = async (task, dir) => {
    const idx = tasks.findIndex((t) => t.id === task.id);
    const swapWith = tasks[idx + dir];
    if (!swapWith) return;
    await Promise.all([
      api.patch(`/tickets/${id}/tasks/${task.id}`, { sort_order: swapWith.sort_order }),
      api.patch(`/tickets/${id}/tasks/${swapWith.id}`, { sort_order: task.sort_order }),
    ]);
    load();
  };

  const postComment = async (e) => {
    e.preventDefault();
    if (!comment.trim()) return;
    setPosting(true);
    try {
      await api.post(`/tickets/${id}/comments`, { body: comment, is_private: isAgent && replyMode === 'note' });
      setComment('');
      // Activity is collapsed by default -- without this, a just-posted
      // reply/note lands in the feed with no visible confirmation it
      // actually went through.
      setActivityOpen(true);
      await load();
    } finally {
      setPosting(false);
    }
  };

  const openCannedMenu = async () => {
    setCannedMenuOpen((o) => !o);
    if (cannedResponses === null) {
      const query = ticket?.team ? `?team=${encodeURIComponent(ticket.team)}` : '';
      const { responses } = await api.get(`/canned-responses${query}`);
      setCannedResponses(responses);
    }
  };

  // Inserts at the caret rather than replacing the whole draft -- an agent
  // who already typed a greeting can drop a canned snippet in after it
  // instead of losing what they'd written, same insert-at-cursor behavior
  // Email Configuration's template editor uses for its variable palette.
  const insertCanned = (response) => {
    const el = commentRef.current;
    const text = response.body_html;
    if (el) {
      const start = el.selectionStart ?? comment.length;
      const end = el.selectionEnd ?? comment.length;
      const next = comment.slice(0, start) + text + comment.slice(end);
      setComment(next);
      requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + text.length; });
    } else {
      setComment((c) => c + text);
    }
    setCannedMenuOpen(false);
    api.post(`/canned-responses/${response.id}/use`, {}).catch(() => {});
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

  // Reflects unsaved edits (draft + draftCustom) so conditional Business
  // Rules react live as an agent stages changes, before Update is clicked --
  // the same live-evaluation behavior the ticket creation form has.
  const liveTicketValues = {
    ...ticket,
    ...Object.fromEntries(customValues.map((c) => [c.field_key, c.value])),
    ...draft,
    ...draftCustom,
  };
  const fieldRules = useBusinessRules(ticket?.type, liveTicketValues);

  usePageTitle(ticket ? `${ticket.number} — ${ticket.title}` : null);

  if (!ticket) return <div className="text-slate-400 text-sm py-20 text-center">Loading ticket…</div>;

  // Reflects a staged (unsaved) type change immediately -- e.g. the Change
  // Details section appears in preview as soon as an agent switches Type to
  // "change" in Properties, before they've clicked Update.
  const isChange = val('type') === 'change';
  const showStatus = fieldRules.isVisible('status', true);
  const showPriority = fieldRules.isVisible('priority', true);
  const showCategory = fieldRules.isVisible('category', true);
  const showTeam = fieldRules.isVisible('team', true);
  const showRisk = fieldRules.isVisible('risk', isChange);
  const showPlannedStart = fieldRules.isVisible('planned_start', isChange);
  const showPlannedEnd = fieldRules.isVisible('planned_end', isChange);
  const showRollbackPlan = fieldRules.isVisible('rollback_plan', isChange);
  const showChangeSection = showRisk || showPlannedStart || showPlannedEnd || showRollbackPlan;
  const pendingApproval = approvals.find((a) => a.status === 'pending');
  const statusOptions = ticket.status === 'pending_approval' ? ['pending_approval', ...STATUSES] : STATUSES;

  // One merged, chronological feed -- Freshservice-style "conversation" +
  // activity log combined into a single timeline instead of two separate
  // panels, collapsed by default and expanded only via the Activity button.
  const activityFeed = [
    ...comments.map((c) => ({ ...c, kind: 'comment' })),
    ...history.map((h) => ({ ...h, kind: 'history' })),
  ].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

  const canAssignToMe = isAgent && val('assignee_id') !== user.id;
  const canResolveNow = isAgent && !lifecycle && !['resolved', 'closed'].includes(val('status')) && !ticket.is_spam;
  // Only the person who filed this ticket gets an Edit button, and only
  // while it's still open -- everyone else (including other requesters)
  // never sees it, matching the same rule PATCH /:id enforces server-side.
  const canRequesterEdit = user.id === ticket.requester_id && !['resolved', 'closed'].includes(ticket.status);
  const workBrief = (() => {
    const now = Date.now();
    const dueAt = ticket.sla_due_at ? new Date(ticket.sla_due_at).getTime() : null;
    const remainingMinutes = dueAt ? Math.round((dueAt - now) / 60000) : null;
    const isClosed = ['resolved', 'closed'].includes(ticket.status);
    const slaLabel = !dueAt ? 'No SLA target' : remainingMinutes < 0 ? `Breached ${Math.abs(remainingMinutes)}m ago` : remainingMinutes < 60 ? `Due in ${remainingMinutes}m` : `Due in ${Math.ceil(remainingMinutes / 60)}h`;
    const next = isClosed ? 'Ticket is complete — review the resolution or reopen if needed.' : !ticket.assignee_id ? 'Assign an owner so this ticket has a clear next step.' : ticket.status === 'on_hold' ? 'Awaiting customer or dependency — follow up when the hold is ready to clear.' : ticket.priority === 'critical' ? 'Critical priority — assess impact and update stakeholders now.' : 'Review the latest activity, respond to the requester, then update the ticket.';
    return { slaLabel, atRisk: remainingMinutes !== null && remainingMinutes < 60 && !isClosed, next };
  })();

  return (
    <div className="space-y-4">
      <Link to="/tickets" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Back to tickets
      </Link>

      <div className="card p-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <span className="font-mono text-sm text-slate-500">{ticket.number}</span>
              <TypeBadge type={val('type')} />
              {isChange && (
                <span className={`badge ${ticket.cab_status === 'approved' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : ticket.cab_status === 'rejected' ? 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400' : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400'}`}>
                  <ShieldCheck size={11} /> CAB {ticket.cab_status?.replace('_', ' ')}
                </span>
              )}
              {!!ticket.is_spam && (
                <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400">
                  <Ban size={11} /> Spam
                </span>
              )}
            </div>
            <h1 className="text-xl font-semibold text-slate-800 dark:text-slate-100">{ticket.title}</h1>
          </div>
        </div>

        {/* One toolbar, right-aligned -- every action this page can take,
            ordered by how often you'd reach for it (left to right: utility,
            insight, work, commit) with the catch-all "more" menu anchored
            at the very end, the same convention Gmail/Freshservice use so
            the primary actions never drift as the menu grows. */}
        <div className="flex items-center justify-end gap-1.5 flex-wrap pt-3 mt-3 border-t border-slate-100 dark:border-slate-800">
          <button onClick={copyLink} className="btn-ghost" title="Copy link to this ticket">
            {linkCopied ? <Check size={14} className="text-emerald-500" /> : <Link2 size={14} />}
          </button>

          {canRequesterEdit && (
            <button onClick={() => setRequesterEditOpen(true)} className="btn-secondary">
              <Pencil size={14} /> Edit
            </button>
          )}
          {!isAgent && user.id === ticket.requester_id && ticket.type === 'incident' && ['resolved', 'closed'].includes(ticket.status) && (
            <button onClick={reopenTicket} disabled={!!actionBusy} className="btn-secondary" title="Reopen within 7 days of resolution">
              {actionBusy === 'reopen' ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />} Reopen
            </button>
          )}
          {!isAgent && user.id === ticket.requester_id && ticket.type === 'request' && !['resolved', 'closed'].includes(ticket.status) && (
            <button onClick={cancelRequest} disabled={!!actionBusy} className="btn-secondary">
              {actionBusy === 'cancel' ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />} Cancel request
            </button>
          )}

          <button onClick={() => setActivityOpen((o) => !o)} className="btn-secondary">
            <MessageSquare size={14} /> Activity
            <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 ml-0.5">{activityFeed.length}</span>
            {activityOpen ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>

          {isAgent && (
            <>
              <button ref={aiTriggerRef} onClick={() => setAiMenuOpen((o) => !o)} disabled={!!aiBusy} className="btn-secondary">
                {aiBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} AI actions <ChevronDown size={12} />
              </button>
              <DropdownMenu open={aiMenuOpen} anchorRef={aiTriggerRef} menuRef={aiPanelRef} align="right" width={224}>
                <button onClick={() => { setAiMenuOpen(false); runAI('summarize'); }} className="w-full flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Sparkles size={14} className="text-brand-500" /> Summarize
                </button>
                <button onClick={() => { setAiMenuOpen(false); runAI('categorize'); }} className="w-full flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Tags size={14} className="text-brand-500" /> Auto-categorize
                </button>
                <button onClick={() => { setAiMenuOpen(false); runAI('suggest'); }} className="w-full flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Wand2 size={14} className="text-brand-500" /> Suggest resolution
                </button>
              </DropdownMenu>

              <span className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

              {canAssignToMe && (
                <button onClick={assignToMe} disabled={!!actionBusy} className="btn-secondary">
                  {actionBusy === 'assign' ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />} Assign to me
                </button>
              )}
              {canResolveNow && (
                <button onClick={resolveNow} disabled={!!actionBusy} className="btn-secondary">
                  {actionBusy === 'resolve' ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />} Resolve
                </button>
              )}

              <span className="w-px h-5 bg-slate-200 dark:bg-slate-700 mx-1" />

              <button onClick={saveUpdate} disabled={!dirty || saving} className="btn-primary">
                {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Update{dirty ? ' •' : ''}
              </button>

              <button ref={moreTriggerRef} onClick={() => setMoreMenuOpen((o) => !o)} className="btn-ghost" title="More actions">
                <MoreHorizontal size={16} />
              </button>
              <DropdownMenu open={moreMenuOpen} anchorRef={moreTriggerRef} menuRef={morePanelRef} align="right" width={208}>
                {ticket.is_spam ? (
                  <button onClick={unmarkSpam} disabled={!!actionBusy} className="w-full flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800">
                    {actionBusy === 'unspam' ? <Loader2 size={14} className="animate-spin" /> : <ShieldAlert size={14} />} Unmark as spam
                  </button>
                ) : (
                  <button onClick={markSpam} disabled={!!actionBusy} className="w-full flex items-center gap-2 text-sm px-2.5 py-2 rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-500/10">
                    {actionBusy === 'spam' ? <Loader2 size={14} className="animate-spin" /> : <Ban size={14} />} Mark as spam
                  </button>
                )}
              </DropdownMenu>
            </>
          )}
        </div>
      </div>

      <section className="sticky top-2 z-10 grid grid-cols-1 gap-px overflow-hidden rounded-2xl border border-slate-200 bg-slate-200 shadow-card dark:border-white/10 dark:bg-white/10 md:grid-cols-4">
        <div className="bg-white p-3.5 dark:bg-slate-900/95 md:col-span-2"><div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-brand-600 dark:text-brand-400"><CircleAlert size={14} /> Recommended next action</div><p className="mt-1.5 text-sm font-medium leading-5 text-slate-800 dark:text-slate-100">{workBrief.next}</p></div>
        <div className="bg-white p-3.5 dark:bg-slate-900/95"><div className="flex items-center gap-1.5 text-xs text-slate-400"><UserRoundCheck size={13} /> Owner</div><p className="mt-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">{ticket.assignee_name || 'Unassigned'}</p></div>
        <div className="bg-white p-3.5 dark:bg-slate-900/95"><div className="flex items-center gap-1.5 text-xs text-slate-400"><Clock size={13} /> SLA target</div><p className={`mt-1.5 text-sm font-semibold ${workBrief.atRisk ? 'text-red-600 dark:text-red-400' : 'text-slate-800 dark:text-slate-100'}`}>{workBrief.slaLabel}</p></div>
      </section>

      {aiError && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{aiError}</div>}
      {fieldError && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{fieldError}</div>}

      {!!ticket.is_spam && (
        <div className="card p-4 bg-red-50/70 dark:bg-red-500/10 border-red-200 dark:border-red-900 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm text-red-700 dark:text-red-400 flex items-center gap-1.5"><Ban size={15} /> This ticket is marked as spam and closed — it won't appear in the default queue.</span>
          <button onClick={unmarkSpam} disabled={!!actionBusy} className="btn-secondary text-xs">
            {actionBusy === 'unspam' ? <Loader2 size={13} className="animate-spin" /> : <ShieldAlert size={13} />} Unmark
          </button>
        </div>
      )}

      {mergedInto && (
        <div className="card p-4 bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700 flex items-center justify-between gap-3 flex-wrap">
          <span className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1.5">
            <GitMerge size={15} /> This ticket was merged into <button onClick={() => navigate(`/tickets/${mergedInto.id}`)} className="font-medium text-brand-600 dark:text-brand-400 hover:underline">{mergedInto.number}</button> and is now closed.
          </span>
        </div>
      )}

      {mergedFrom.length > 0 && (
        <div className="card p-4 bg-slate-50 dark:bg-slate-800/60 border-slate-200 dark:border-slate-700">
          <span className="text-sm text-slate-600 dark:text-slate-300 flex items-center gap-1.5 flex-wrap">
            <GitMerge size={15} className="shrink-0" /> Merged into this ticket:
            {mergedFrom.map((m) => (
              <button key={m.id} onClick={() => navigate(`/tickets/${m.id}`)} className="font-medium text-brand-600 dark:text-brand-400 hover:underline">{m.number}</button>
            ))}
          </span>
        </div>
      )}

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
                  <button onClick={() => removeAttachment(a.id)} className="text-slate-400 hover:text-red-500 shrink-0 p-1.5 -m-1.5"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
            <label className="btn-secondary text-xs cursor-pointer inline-flex">
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <Paperclip size={13} />}
              {uploading ? 'Uploading…' : 'Attach files'}
              <input type="file" multiple className="hidden" onChange={(e) => uploadFiles(e.target.files)} disabled={uploading} />
            </label>
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <ListChecks size={14} /> Tasks
                {tasks.length > 0 && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{tasks.filter((t) => t.status === 'done').length}/{tasks.length} done</span>}
              </h3>
              {isAgent && !showAddTask && (
                <button onClick={() => setShowAddTask(true)} className="btn-secondary text-xs"><Plus size={12} /> Add task</button>
              )}
            </div>
            {tasks.length > 0 && (
              <div className="h-1.5 rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden mb-3">
                <div
                  className="h-full bg-emerald-500 transition-all"
                  style={{ width: `${(tasks.filter((t) => t.status === 'done').length / tasks.length) * 100}%` }}
                />
              </div>
            )}
            {showAddTask && (
              <div className="mb-3">
                <AddTicketTaskForm agents={agents} existingTasks={tasks} onAdd={addTask} onClose={() => setShowAddTask(false)} />
              </div>
            )}
            {tasks.length === 0 && !showAddTask ? (
              <p className="text-sm text-slate-400">No tasks yet{isAgent ? ' — break this ticket into assignable work items.' : '.'}</p>
            ) : (
              <div className="rounded-lg border border-slate-100 dark:border-slate-800 divide-y divide-slate-100 dark:divide-slate-800">
                {tasks.map((t, i) => (
                  <TicketTaskRow
                    key={t.id} task={t} canManage={isAgent}
                    isFirst={i === 0} isLast={i === tasks.length - 1}
                    onUpdate={updateTask} onDelete={deleteTask} onMove={(dir) => moveTask(t, dir)}
                  />
                ))}
              </div>
            )}
          </div>

          <div className="card p-4">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-2 flex items-center gap-1.5"><MessageSquare size={14} /> {isAgent ? 'Reply / Add note' : 'Reply'}</h3>
            {isAgent && (
              <div className="flex items-center gap-1.5 mb-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => setReplyMode('reply')}
                  className={`text-xs font-medium px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${replyMode === 'reply' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <Send size={12} /> Reply to requester
                </button>
                <button
                  type="button"
                  onClick={() => setReplyMode('note')}
                  className={`text-xs font-medium px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 transition-colors ${replyMode === 'note' ? 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800'}`}
                >
                  <Lock size={12} /> Private note
                </button>
                <span className="w-px h-4 bg-slate-200 dark:bg-slate-700 mx-0.5" />
                <button ref={cannedTriggerRef} type="button" onClick={openCannedMenu} className="text-xs font-medium px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800">
                  <Tag size={12} /> Canned responses
                </button>
                <DropdownMenu open={cannedMenuOpen} anchorRef={cannedTriggerRef} menuRef={cannedPanelRef} align="left" width={320}>
                  <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1 border-b border-slate-100 dark:border-slate-800">
                    <Search size={12} className="text-slate-400 shrink-0" />
                    <input
                      autoFocus value={cannedQuery} onChange={(e) => setCannedQuery(e.target.value)}
                      placeholder="Search canned responses…"
                      className="flex-1 min-w-0 bg-transparent border-none outline-none text-xs text-slate-700 dark:text-slate-200 placeholder:text-slate-400"
                    />
                  </div>
                  <div className="max-h-64 overflow-y-auto space-y-0.5">
                    {cannedResponses === null && <div className="px-2.5 py-3 text-xs text-slate-400 text-center">Loading…</div>}
                    {cannedResponses?.length === 0 && (
                      <div className="px-2.5 py-3 text-xs text-slate-400 text-center">No canned responses yet — set some up in Admin Settings → Email Configuration.</div>
                    )}
                    {cannedResponses?.filter((r) => !cannedQuery.trim() || r.title.toLowerCase().includes(cannedQuery.trim().toLowerCase()) || r.body_html.toLowerCase().includes(cannedQuery.trim().toLowerCase()))
                      .map((r) => (
                        <button key={r.id} type="button" onClick={() => insertCanned(r)} className="w-full text-left px-2.5 py-2 rounded-lg hover:bg-slate-100 dark:hover:bg-slate-800">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-medium text-slate-700 dark:text-slate-200 truncate">{r.title}</span>
                            {r.team && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400 shrink-0">{r.team}</span>}
                          </div>
                          <p className="text-[11px] text-slate-400 truncate">{r.body_html}</p>
                        </button>
                      ))}
                  </div>
                </DropdownMenu>
                {comment.trim().length > 0 && (
                  <button type="button" onClick={() => setSaveCannedOpen(true)} className="text-xs font-medium px-2.5 py-1.5 rounded-lg flex items-center gap-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 ml-auto" title="Save what you've typed as a reusable canned response">
                    <BookmarkPlus size={12} /> Save as canned response
                  </button>
                )}
              </div>
            )}
            <form onSubmit={postComment} className="space-y-2">
              <textarea
                ref={commentRef}
                className="input"
                rows={3}
                placeholder={isAgent && replyMode === 'note' ? 'Add an internal note — only agents will see this…' : 'Reply to the requester…'}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); postComment(e); }
                }}
              />
              <div className="flex items-center justify-between gap-3">
                {isAgent ? (
                  <p className={`text-[11px] ${replyMode === 'note' ? 'text-amber-600 dark:text-amber-400' : 'text-slate-400'}`}>
                    {replyMode === 'note'
                      ? 'Only visible to agents and admins — never shown or sent to the requester.'
                      : 'Emailed to the requester and shown on their view of this ticket.'}
                  </p>
                ) : <span />}
                <button className={isAgent && replyMode === 'note' ? 'btn-secondary' : 'btn-primary'} disabled={posting}>
                  {posting ? <Loader2 size={14} className="animate-spin" /> : isAgent && replyMode === 'note' ? <Lock size={14} /> : <Send size={14} />}
                  {isAgent && replyMode === 'note' ? 'Add note' : 'Send'}
                </button>
              </div>
            </form>
            {saveCannedOpen && (
              <SaveCannedResponseModal
                defaultBody={comment}
                defaultTeam={ticket.team}
                onClose={() => setSaveCannedOpen(false)}
                onSaved={() => { setSaveCannedOpen(false); setCannedResponses(null); }}
              />
            )}
          </div>

          {showChangeSection && (
            <div className="card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5"><ShieldCheck size={14} /> Change details</h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {showRisk && (
                  <div>
                    <label className="label">Risk</label>
                    <Select
                      disabled={!isAgent} value={val('risk') || ''} onChange={(v) => setDraftField('risk', v)}
                      options={[{ value: '', label: 'Not set' }, ...RISKS]}
                    />
                  </div>
                )}
                {showPlannedStart && (
                  <div>
                    <label className="label">Planned start</label>
                    <input type="datetime-local" className="input" disabled={!isAgent} value={(val('planned_start') || '').slice(0, 16)} onChange={(e) => setDraftField('planned_start', e.target.value)} />
                  </div>
                )}
                {showPlannedEnd && (
                  <div>
                    <label className="label">Planned end</label>
                    <input type="datetime-local" className="input" disabled={!isAgent} value={(val('planned_end') || '').slice(0, 16)} onChange={(e) => setDraftField('planned_end', e.target.value)} />
                  </div>
                )}
              </div>
              {showRollbackPlan && (
                <div>
                  <label className="label">Rollback plan</label>
                  <textarea className="input" rows={2} disabled={!isAgent} value={val('rollback_plan') || ''} onChange={(e) => setDraftField('rollback_plan', e.target.value)} />
                </div>
              )}
            </div>
          )}

          {isAgent && ticket.ai_summary && (
            <div className="card p-4 border-brand-200 dark:border-brand-800 bg-brand-50/50 dark:bg-brand-500/5">
              <h3 className="text-sm font-semibold text-brand-700 dark:text-brand-400 mb-2 flex items-center gap-1.5"><Sparkles size={14} /> AI Summary</h3>
              <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line">{ticket.ai_summary}</p>
            </div>
          )}

          {isAgent && suggestion && (
            <div className="card p-4 border-emerald-200 dark:border-emerald-800 bg-emerald-50/50 dark:bg-emerald-500/5">
              <h3 className="text-sm font-semibold text-emerald-700 dark:text-emerald-400 mb-2 flex items-center gap-1.5"><Wand2 size={14} /> AI Suggested Resolution</h3>
              <p className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-line">{suggestion}</p>
            </div>
          )}

          <div className="card p-4">
            <button type="button" onClick={() => setActivityOpen((o) => !o)} className="w-full flex items-center justify-between text-left">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5">
                <MessageSquare size={14} /> Activity
                <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{activityFeed.length}</span>
              </h3>
              {activityOpen ? <ChevronUp size={16} className="text-slate-400" /> : <ChevronDown size={16} className="text-slate-400" />}
            </button>

            {activityOpen && (
              <div className="mt-3 animate-fade-in">
                <div className="space-y-3 mb-4 max-h-96 overflow-y-auto pr-1">
                  {activityFeed.length === 0 && <p className="text-sm text-slate-400">No activity yet.</p>}
                  {activityFeed.map((item) => item.kind === 'comment' ? (
                    <div
                      key={`c-${item.id}`}
                      className={`rounded-lg p-3 text-sm ${
                        item.is_private
                          ? 'bg-amber-50 dark:bg-amber-500/10 border border-amber-100 dark:border-amber-900'
                          : item.is_ai ? 'bg-brand-50 dark:bg-brand-500/10' : 'bg-slate-50 dark:bg-slate-800/60'
                      }`}
                    >
                      <div className="flex items-center gap-2 mb-1 text-xs text-slate-500">
                        <span className="font-medium text-slate-700 dark:text-slate-200">{item.author_name || 'Unknown'}</span>
                        {!!item.is_ai && <span className="badge bg-brand-100 text-brand-700 dark:bg-brand-500/20 dark:text-brand-400"><Sparkles size={10} /> AI</span>}
                        {!!item.is_private ? (
                          <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-400"><Lock size={10} /> Private note — agents only</span>
                        ) : (
                          <span className="badge bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400"><Send size={10} /> Reply</span>
                        )}
                        <span>· {new Date(item.created_at).toLocaleString()}</span>
                      </div>
                      <p className="text-slate-700 dark:text-slate-200 whitespace-pre-line">{item.body}</p>
                    </div>
                  ) : (
                    <div key={`h-${item.id}`} className="text-xs text-slate-500 border-l-2 border-slate-200 dark:border-slate-700 pl-2 py-0.5">
                      <span className="text-slate-700 dark:text-slate-200 font-medium">{item.event}</span> — {item.detail}
                      <div className="text-[10px] text-slate-400">{new Date(item.created_at).toLocaleString()}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card p-4 space-y-3">
            <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 flex items-center gap-1.5"><UserCircle2 size={14} /> Properties</h3>

            <div>
              <div className="label mb-0.5">Requester</div>
              {isAgent ? (
                <button
                  ref={requesterTriggerRef}
                  type="button"
                  onClick={() => setRequesterCardOpen((o) => !o)}
                  className="text-sm text-slate-800 dark:text-slate-100 font-medium hover:text-brand-600 dark:hover:text-brand-400 hover:underline underline-offset-2 transition-colors"
                >
                  {ticket.requester_name || 'Unknown'}
                </button>
              ) : (
                <div className="text-sm text-slate-800 dark:text-slate-100 font-medium">{ticket.requester_name || 'Unknown'}</div>
              )}
              {ticket.requester_email && <div className="text-xs text-slate-500 dark:text-slate-400">{ticket.requester_email}</div>}
              <DropdownMenu open={requesterCardOpen} anchorRef={requesterTriggerRef} menuRef={requesterPanelRef} align="left" width={260}>
                <div className="px-2.5 py-2 space-y-2">
                  <div className="flex items-center gap-2 pb-2 border-b border-slate-100 dark:border-slate-800">
                    <div
                      className="w-9 h-9 rounded-full flex items-center justify-center text-white text-sm font-semibold shrink-0"
                      style={{ backgroundColor: '#64748b' }}
                    >
                      {(ticket.requester_name || '?')[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">{ticket.requester_name || 'Unknown'}</div>
                      <div className="text-xs text-slate-500 truncate">{ticket.requester_email || '—'}</div>
                    </div>
                  </div>
                  <div className="text-xs space-y-1.5">
                    <div className="flex justify-between gap-3">
                      <span className="text-slate-400">Employee ID</span>
                      <span className="text-slate-700 dark:text-slate-200 font-medium">{ticket.requester_employee_id || 'Not set'}</span>
                    </div>
                    <div className="flex justify-between gap-3">
                      <span className="text-slate-400">Manager</span>
                      <span className="text-slate-700 dark:text-slate-200 font-medium">{ticket.requester_manager_name || 'Not set'}</span>
                    </div>
                  </div>
                </div>
              </DropdownMenu>
            </div>

            {isAgent ? (
              <div>
                <label className="label">Agent</label>
                <Select
                  value={val('assignee_id') || ''} onChange={(v) => setDraftField('assignee_id', v)}
                  options={[
                    { value: '', label: 'Unassigned' },
                    ...agents.map((a) => ({ value: a.id, label: a.name + (a.team ? ` · ${a.team}` : '') })),
                    ...(ticket.assignee_id && !agents.some((a) => a.id === ticket.assignee_id)
                      ? [{ value: ticket.assignee_id, label: ticket.assignee_name || 'Unknown' }] : []),
                  ]}
                />
              </div>
            ) : ticket.assignee_name && (
              <div>
                <div className="label mb-0.5">Assigned to</div>
                <div className="text-sm text-slate-800 dark:text-slate-100 font-medium">{ticket.assignee_name}</div>
              </div>
            )}

            <div className="pt-1 space-y-3 border-t border-slate-100 dark:border-slate-800">
              <div className="pt-2">
                <label className="label">Type</label>
                {isAgent ? (
                  <Select value={val('type')} onChange={(v) => setDraftField('type', v)} options={TYPES} />
                ) : (
                  <div className="text-sm text-slate-700 dark:text-slate-200 capitalize">{ticket.type}</div>
                )}
              </div>
              {showStatus && (
                <div className="pt-2">
                  <label className="label">Status</label>
                  {lifecycle ? (
                    <LifecycleStageControl ticketId={id} lifecycle={lifecycle} isAgent={isAgent} onTransitioned={load} />
                  ) : (
                    <Select
                      disabled={!isAgent} value={val('status')} onChange={(v) => setDraftField('status', v)}
                      options={statusOptions.map((s) => ({ value: s, label: s.replace('_', ' ') }))}
                    />
                  )}
                </div>
              )}
              {showPriority && (
                <div>
                  <label className="label">Priority</label>
                  <Select
                    disabled={!isAgent} value={val('priority')} onChange={(v) => setDraftField('priority', v)}
                    options={fieldRules.getOptions('priority', PRIORITIES)}
                  />
                </div>
              )}
              {showCategory && (
                <div>
                  <label className="label">Category</label>
                  <input className="input" disabled={!isAgent} value={val('category') || ''} onChange={(e) => setDraftField('category', e.target.value)} />
                </div>
              )}
              {showTeam && (
                <div>
                  <label className="label">Group</label>
                  <Select
                    disabled={!isAgent} value={val('team') || ''} onChange={(v) => setDraftField('team', v)}
                    options={[
                      { value: '', label: 'Unassigned' },
                      ...fieldRules.getOptions('team', groups.map((g) => g.name)),
                      ...(ticket.team && !groups.some((g) => g.name === ticket.team) ? [ticket.team] : []),
                    ]}
                  />
                </div>
              )}
              {ticket.catalog_item_name && (
                <div>
                  <label className="label">Service Item</label>
                  <div className="text-sm text-slate-700 dark:text-slate-200">{ticket.catalog_item_name}</div>
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 pt-1">
              <StatusBadge status={val('status')} />
              <PriorityBadge priority={val('priority')} />
            </div>
          </div>

          {isAgent && customFieldDefs.length > 0 && (
            <div className="card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Custom fields</h3>
              {customFieldDefs.map((f) => {
                const visible = fieldRules.isVisible(f.field_key, true);
                if (!visible) return null;
                const required = fieldRules.isRequired(f.field_key, !!f.required);
                const stored = customValues.find((c) => c.field_key === f.field_key)?.value;
                const value = draftCustom[f.field_key] !== undefined ? draftCustom[f.field_key] : stored;
                const options = fieldRules.getOptions(f.field_key, f.options);
                return (
                  <div key={f.id}>
                    <label className="label">{f.label}{required && <span className="text-red-500">*</span>}</label>
                    {f.field_type === 'text' && (
                      <input className="input" value={value || ''} onChange={(e) => setDraftCustomField(f.field_key, e.target.value)} />
                    )}
                    {f.field_type === 'textarea' && (
                      <textarea className="input" rows={2} value={value || ''} onChange={(e) => setDraftCustomField(f.field_key, e.target.value)} />
                    )}
                    {f.field_type === 'select' && (
                      <Select
                        value={value || ''} onChange={(v) => setDraftCustomField(f.field_key, v)}
                        options={[{ value: '', label: 'Choose…' }, ...options]}
                      />
                    )}
                    {f.field_type === 'multiselect' && (
                      <div className="input h-auto flex flex-wrap gap-x-4 gap-y-1.5 py-2.5">
                        {options.map((o) => {
                          const arr = Array.isArray(value) ? value : [];
                          return (
                            <label key={o} className="flex items-center gap-1.5 text-sm text-slate-600 dark:text-slate-300">
                              <input
                                type="checkbox"
                                checked={arr.includes(o)}
                                onChange={(e) => setDraftCustomField(f.field_key, e.target.checked ? [...arr, o] : arr.filter((v) => v !== o))}
                              />
                              {o}
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!isAgent && customValues.length > 0 && (
            <div className="card p-4 space-y-3">
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Custom fields</h3>
              {customValues.map((f) => (
                <div key={f.field_key}>
                  <div className="label">{f.label}</div>
                  <div className="text-sm text-slate-700 dark:text-slate-200">
                    {Array.isArray(f.value) ? (f.value.join(', ') || '—') : (f.value || '—')}
                  </div>
                </div>
              ))}
            </div>
          )}

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

              <Select
                size="sm" placeholder="Link an asset…" value="" onChange={linkAsset}
                options={allAssets.filter((a) => !linkedAssets.some((la) => la.id === a.id)).map((a) => ({ value: a.id, label: `${a.name} (${a.tag})` }))}
              />
            </div>
          )}

          <MajorIncidentPanel
            ticketId={id}
            ticketType={ticket.type}
            isAgent={isAgent}
            majorIncident={majorIncident}
            relatedMajorIncidents={relatedMajorIncidents}
            onChanged={load}
          />

          {isAgent && <ExternalLinksPanel ticketId={id} links={externalLinks} onChanged={load} />}
        </div>
      </div>

      {requesterEditOpen && (
        <RequesterEditModal
          ticket={ticket}
          onClose={() => setRequesterEditOpen(false)}
          onSaved={(updated) => { setTicket(updated); setRequesterEditOpen(false); }}
        />
      )}
    </div>
  );
}
