import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Siren, AlertTriangle, Clock, Check, X, Loader2, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api.js';
import PageHeader from '../components/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import Modal from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import { SeverityBadge, MiStatusBadge } from '../components/Badge.jsx';
import SonaTextarea from '../components/SonaTextarea.jsx';

const STATUS_FILTERS = [
  { key: '', label: 'All' },
  { key: 'active', label: 'Active' },
  { key: 'monitoring', label: 'Monitoring' },
  { key: 'resolved', label: 'Resolved' },
  { key: 'closed', label: 'Closed' },
];

const SEVERITY_OPTIONS = [
  { value: 'sev1', label: 'SEV1 — critical service unavailable' },
  { value: 'sev2', label: 'SEV2 — major degradation' },
  { value: 'sev3', label: 'SEV3 — significant but contained' },
];

// Proposals waiting on a manager.
//
// This queue is the whole reason the gate exists: somebody close to the work
// raised a flag, and somebody with the authority has to look at it — promptly,
// which is why it sits above the list rather than behind a tab.
function ProposalQueue({ onPromoted }) {
  const [proposals, setProposals] = useState(null);
  const [deciding, setDeciding] = useState(null);
  const [severity, setSeverity] = useState('sev2');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = async () => {
    try { setProposals((await api.get('/major-incidents/proposals')).proposals); }
    catch { setProposals([]); }
  };
  useEffect(() => { load(); }, []);

  const decide = async () => {
    setBusy(true);
    setError('');
    try {
      if (deciding.mode === 'promote') {
        const { majorIncident } = await api.post(`/major-incidents/proposals/${deciding.proposal.id}/promote`, { severity, comment });
        setDeciding(null);
        setComment('');
        await load();
        onPromoted(majorIncident);
      } else {
        await api.post(`/major-incidents/proposals/${deciding.proposal.id}/reject`, { comment });
        setDeciding(null);
        setComment('');
        await load();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!proposals?.length) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="font-display text-sm font-semibold text-slate-700 dark:text-slate-200">Waiting on a decision</h2>
        <span className="badge bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">{proposals.length}</span>
      </div>

      {proposals.map((p) => (
        <div key={p.id} className="card border-l-2 border-l-amber-400 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-slate-400">{p.ticket_number}</span>
                <h3 className="font-display font-semibold text-slate-800 dark:text-slate-100">{p.ticket_title}</h3>
              </div>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{p.reason}</p>
              <p className="mt-1 text-[11px] text-slate-400">
                Proposed by {p.proposed_by_name || 'someone'}
                {p.affected_service ? ` · ${p.affected_service}` : ''}
                {p.users_affected ? ` · ${p.users_affected}` : ''}
              </p>
              {!!p.criteria?.length && (
                <ul className="mt-2 space-y-0.5">
                  {p.criteria.map((c) => (
                    <li key={c.key} className="flex items-start gap-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                      <CheckCircle2 size={11} className="mt-0.5 shrink-0 text-amber-500" /> {c.detail}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="flex shrink-0 gap-2">
              <button
                onClick={() => { setDeciding({ proposal: p, mode: 'reject' }); setComment(''); }}
                className="btn-secondary text-xs"
              >
                <X size={13} /> Not major
              </button>
              <button
                onClick={() => { setDeciding({ proposal: p, mode: 'promote' }); setSeverity(p.suggested_severity || 'sev2'); setComment(''); }}
                className="btn-primary text-xs"
              >
                <Check size={13} /> Promote
              </button>
            </div>
          </div>
        </div>
      ))}

      {deciding && (
        <Modal
          title={deciding.mode === 'promote' ? 'Promote to a Major Incident' : 'Decline this proposal'}
          onClose={() => setDeciding(null)}
        >
          <div className="space-y-3">
            {error && (
              <div className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</div>
            )}
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {deciding.mode === 'promote'
                ? 'The incident keeps its own number and history; the major incident is linked to it.'
                : 'The incident carries on as it is. Say why, so the next borderline one is judged the same way.'}
            </p>
            {deciding.mode === 'promote' && (
              <div>
                <label className="label">Severity</label>
                <Select value={severity} onChange={setSeverity} options={SEVERITY_OPTIONS} />
              </div>
            )}
            <div>
              <label className="label">
                {deciding.mode === 'promote' ? 'Note (optional)' : 'Why not'}
                {deciding.mode === 'reject' && <span className="text-red-500">*</span>}
              </label>
              <SonaTextarea purpose="Major incident decision note" className="input min-h-[60px]" autoFocus value={comment} onChange={(e) => setComment(e.target.value)} />
            </div>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeciding(null)} className="btn-secondary">Cancel</button>
              <button
                onClick={decide}
                disabled={busy || (deciding.mode === 'reject' && !comment.trim())}
                className="btn-primary disabled:opacity-40"
              >
                {busy && <Loader2 size={14} className="animate-spin" />}
                {deciding.mode === 'promote' ? 'Promote' : 'Decline'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

export default function MajorIncidents() {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [status, setStatus] = useState('');

  const load = async () => {
    const params = status ? `?status=${status}` : '';
    const { majorIncidents } = await api.get(`/major-incidents${params}`);
    setItems(majorIncidents);
  };
  useEffect(() => { load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-4">
      <PageHeader
        title="Major Incidents"
        description="Proposed, promoted and run — with a commander, a communication cadence, and a post-incident review"
      />

      <ProposalQueue onPromoted={(mi) => navigate(`/major-incidents/${mi.id}`)} />

      <div className="flex gap-1.5">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setStatus(f.key)}
            className={`text-xs px-3 py-1.5 rounded-full font-medium transition-colors ${status === f.key ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {items === null ? (
        <div className="text-slate-400 text-sm py-20 text-center">Loading…</div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={Siren}
          title="No major incidents"
          description="Propose one from an incident ticket when something breaks big — a manager decides whether it is promoted."
        />
      ) : (
        <div className="card divide-y divide-slate-100 dark:divide-slate-800">
          {items.map((mi) => (
            <Link key={mi.id} to={`/major-incidents/${mi.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 dark:hover:bg-slate-800/40">
              <Siren size={16} className={mi.status === 'active' ? 'text-red-500 shrink-0' : 'text-slate-400 shrink-0'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{mi.number}</span>
                  <SeverityBadge severity={mi.severity} />
                  <MiStatusBadge status={mi.status} />
                  {mi.updateOverdue && (
                    <span className="badge bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400 flex items-center gap-1"><AlertTriangle size={11} /> update overdue</span>
                  )}
                  {mi.pirOverdue && (
                    <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400 flex items-center gap-1"><Clock size={11} /> PIR overdue</span>
                  )}
                </div>
                <div className="text-sm text-slate-600 dark:text-slate-300 truncate">{mi.summary}</div>
                <div className="text-xs text-slate-400 mt-0.5">
                  {mi.ticket ? `${mi.ticket.number} · ` : ''}{mi.commander_name ? `Commander: ${mi.commander_name} · ` : ''}Declared {new Date(mi.declared_at).toLocaleString()}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
