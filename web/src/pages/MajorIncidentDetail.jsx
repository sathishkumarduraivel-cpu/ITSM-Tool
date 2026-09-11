import { useEffect, useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { ArrowLeft, Siren, AlertTriangle, Clock, Send, Loader2, X, Search, Save } from 'lucide-react';
import { api } from '../lib/api.js';
import { SeverityBadge, MiStatusBadge } from '../components/Badge.jsx';
import { useRealtimeEvent } from '../context/RealtimeContext.jsx';
import Select from '../components/Select.jsx';
import { usePageTitle } from '../hooks/usePageTitle.js';

export default function MajorIncidentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [mi, setMi] = useState(null);
  const [updates, setUpdates] = useState([]);
  const [related, setRelated] = useState([]);
  const [agents, setAgents] = useState([]);
  const [message, setMessage] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');
  const [pirDraft, setPirDraft] = useState({ pir_status: 'not_started', pir_document: '' });
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);

  const load = async () => {
    const data = await api.get(`/major-incidents/${id}`);
    setMi(data.majorIncident);
    setUpdates(data.updates);
    setRelated(data.relatedTickets);
    setPirDraft({ pir_status: data.majorIncident.pir_status, pir_document: data.majorIncident.pir_document || '' });
  };
  useEffect(() => { load(); }, [id]);
  useEffect(() => { api.get('/tickets/assignable-agents').then((d) => setAgents(d.agents)); }, []);

  // Another responder posting an update or changing status shows up live --
  // this is the war-room page, so seeing it the moment it happens matters.
  useRealtimeEvent('major_incident.updated', (p) => { if (p.majorIncidentId === id) load(); });

  const patch = async (body, key) => {
    setSaving(key);
    setError('');
    try {
      const { majorIncident } = await api.patch(`/major-incidents/${id}`, body);
      setMi(majorIncident);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving('');
    }
  };

  const postUpdate = async (e) => {
    e.preventDefault();
    if (!message.trim()) return;
    setPosting(true);
    setError('');
    try {
      await api.post(`/major-incidents/${id}/updates`, { message: message.trim() });
      setMessage('');
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setPosting(false);
    }
  };

  const savePir = async () => {
    setSaving('pir');
    setError('');
    try {
      const { majorIncident } = await api.patch(`/major-incidents/${id}/pir`, pirDraft);
      setMi(majorIncident);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving('');
    }
  };

  const runSearch = async () => {
    if (!searchQuery.trim()) return;
    const { tickets } = await api.get(`/tickets?q=${encodeURIComponent(searchQuery.trim())}`);
    setSearchResults(tickets.filter((t) => t.id !== mi.ticket_id && !related.some((r) => r.id === t.id)));
  };

  const linkRelated = async (ticketId) => {
    await api.post(`/major-incidents/${id}/related`, { ticket_id: ticketId });
    setSearchQuery('');
    setSearchResults(null);
    load();
  };

  const unlinkRelated = async (ticketId) => {
    await api.del(`/major-incidents/${id}/related/${ticketId}`);
    load();
  };

  usePageTitle(mi ? `${mi.number}${mi.title ? ` — ${mi.title}` : ''} · Major Incident` : null);

  if (!mi) return <div className="text-slate-400 text-sm py-20 text-center">Loading…</div>;

  return (
    <div className="space-y-4 max-w-4xl">
      <div className="flex items-center gap-2">
        <button onClick={() => navigate('/major-incidents')} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg p-1.5">
          <ArrowLeft size={18} />
        </button>
        <Siren size={20} className={mi.status === 'active' ? 'text-red-500' : 'text-slate-400'} />
        <h1 className="text-lg font-display font-semibold text-slate-800 dark:text-slate-100">{mi.number}</h1>
        <SeverityBadge severity={mi.severity} />
        <MiStatusBadge status={mi.status} />
      </div>

      {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

      {mi.updateOverdue && (
        <div className="card p-3 bg-red-50/70 dark:bg-red-500/10 border-red-200 dark:border-red-900 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
          <AlertTriangle size={15} /> A status update is overdue — stakeholders are waiting to hear what's happening.
        </div>
      )}
      {mi.pirOverdue && (
        <div className="card p-3 bg-amber-50/70 dark:bg-amber-500/10 border-amber-200 dark:border-amber-900 text-sm text-amber-700 dark:text-amber-400 flex items-center gap-2">
          <Clock size={15} /> The post-incident review is overdue.
        </div>
      )}

      <div className="card p-4 space-y-3">
        <div>
          <div className="text-sm text-slate-700 dark:text-slate-200 font-medium">{mi.summary}</div>
          {mi.impact_description && <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{mi.impact_description}</p>}
        </div>
        <div className="text-xs text-slate-400">
          Anchor ticket: {mi.ticket ? <Link to={`/tickets/${mi.ticket.id}`} className="text-brand-600 dark:text-brand-400 hover:underline font-medium">{mi.ticket.number} — {mi.ticket.title}</Link> : '—'}
          {' · '}Declared by {mi.declared_by_name || 'unknown'} on {new Date(mi.declared_at).toLocaleString()}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-slate-100 dark:border-slate-800">
          <div>
            <label className="label">Severity</label>
            <Select
              size="sm" value={mi.severity} onChange={(v) => patch({ severity: v }, 'severity')} disabled={saving === 'severity'}
              options={[{ value: 'sev1', label: 'SEV1' }, { value: 'sev2', label: 'SEV2' }, { value: 'sev3', label: 'SEV3' }]}
            />
          </div>
          <div>
            <label className="label">Status</label>
            <Select
              size="sm" value={mi.status} onChange={(v) => patch({ status: v }, 'status')} disabled={saving === 'status'}
              options={[
                { value: 'active', label: 'Active' },
                { value: 'monitoring', label: 'Monitoring' },
                { value: 'resolved', label: 'Resolved' },
                ...(mi.pir_status === 'completed' ? [{ value: 'closed', label: 'Closed' }] : []),
              ]}
            />
          </div>
          <div>
            <label className="label">Commander</label>
            <Select
              size="sm" value={mi.commander_id || ''} onChange={(v) => patch({ commander_id: v }, 'commander')} disabled={saving === 'commander'}
              options={[{ value: '', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]}
            />
          </div>
          <div>
            <label className="label">Update every</label>
            <Select
              size="sm" value={mi.update_interval_minutes} onChange={(v) => patch({ update_interval_minutes: v }, 'interval')} disabled={saving === 'interval'}
              options={[{ value: 15, label: '15 min' }, { value: 30, label: '30 min' }, { value: 60, label: '1 hr' }, { value: 120, label: '2 hrs' }]}
            />
          </div>
        </div>
        {mi.status !== 'closed' && mi.pir_status !== 'completed' && (
          <p className="text-xs text-slate-400">Closing requires the post-incident review below to be marked completed.</p>
        )}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Timeline</h3>
        <form onSubmit={postUpdate} className="flex items-start gap-2 mb-3">
          <textarea
            className="input flex-1 text-sm"
            rows={2}
            placeholder="Post a status update — this also appears as a comment on the anchor ticket…"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <button type="submit" disabled={posting || !message.trim()} className="btn-primary shrink-0">
            {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
          </button>
        </form>
        <div className="space-y-2">
          {updates.length === 0 && <p className="text-sm text-slate-400 text-center py-4">No updates posted yet.</p>}
          {updates.map((u) => (
            <div key={u.id} className="bg-slate-50 dark:bg-slate-800/60 rounded-lg p-3">
              <div className="flex items-center justify-between text-xs text-slate-400 mb-1">
                <span className="font-medium text-slate-600 dark:text-slate-300">{u.author_name}</span>
                <span>{new Date(u.created_at).toLocaleString()}</span>
              </div>
              <p className="text-sm text-slate-700 dark:text-slate-200 whitespace-pre-wrap">{u.message}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Related tickets</h3>
        <div className="space-y-1.5 mb-3">
          {related.length === 0 && <p className="text-xs text-slate-400">No related tickets linked.</p>}
          {related.map((t) => (
            <div key={t.id} className="flex items-center justify-between bg-slate-50 dark:bg-slate-800/60 rounded-md px-3 py-1.5">
              <Link to={`/tickets/${t.id}`} className="text-sm text-brand-600 dark:text-brand-400 hover:underline">{t.number} — {t.title}</Link>
              <button onClick={() => unlinkRelated(t.id)} className="text-slate-400 hover:text-red-500"><X size={14} /></button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <input className="input text-sm flex-1" placeholder="Search tickets by number or title…" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && runSearch()} />
          <button onClick={runSearch} className="btn-secondary text-xs shrink-0"><Search size={12} /></button>
        </div>
        {searchResults && (
          <div className="mt-2 space-y-1">
            {searchResults.length === 0 && <p className="text-xs text-slate-400">No matches.</p>}
            {searchResults.slice(0, 6).map((t) => (
              <button key={t.id} onClick={() => linkRelated(t.id)} className="w-full text-left text-sm px-2 py-1.5 rounded-md hover:bg-slate-50 dark:hover:bg-slate-800/60 flex items-center justify-between">
                <span>{t.number} — {t.title}</span>
                <span className="text-xs text-brand-600 dark:text-brand-400">Link</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card p-4">
        <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">Post-incident review</h3>
        <div className="flex items-center gap-2 mb-2">
          <label className="label mb-0">Status</label>
          <Select
            size="sm" className="w-auto" value={pirDraft.pir_status} onChange={(v) => setPirDraft({ ...pirDraft, pir_status: v })}
            options={[{ value: 'not_started', label: 'Not started' }, { value: 'in_progress', label: 'In progress' }, { value: 'completed', label: 'Completed' }]}
          />
        </div>
        <textarea
          className="input text-sm"
          rows={6}
          placeholder="Root cause, timeline, contributing factors, follow-up actions…"
          value={pirDraft.pir_document}
          onChange={(e) => setPirDraft({ ...pirDraft, pir_document: e.target.value })}
        />
        <div className="flex justify-end mt-2">
          <button onClick={savePir} disabled={saving === 'pir'} className="btn-secondary text-xs">
            {saving === 'pir' ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />} Save review
          </button>
        </div>
      </div>
    </div>
  );
}
