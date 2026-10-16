import { useEffect, useState } from 'react';
import { Siren, Loader2, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';
import SonaTextarea from '../SonaTextarea.jsx';

const SEVERITIES = [
  { value: 'sev1', label: 'SEV1 — critical service unavailable' },
  { value: 'sev2', label: 'SEV2 — major degradation' },
  { value: 'sev3', label: 'SEV3 — significant but contained' },
];

/**
 * Proposing, not declaring.
 *
 * The incident is deliberately left alone until a manager decides. That is
 * the whole point of the gate: anyone close to the work can raise the flag
 * without the act of raising it having consequences of its own.
 */
export default function ProposeModal({ ticketId, onClose, onProposed }) {
  const [reason, setReason] = useState('');
  const [severity, setSeverity] = useState('sev2');
  const [service, setService] = useState('');
  const [usersAffected, setUsersAffected] = useState('');
  const [signals, setSignals] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // What the automated check makes of it, shown to the proposer so they can
  // see the evidence they are arguing from.
  useEffect(() => {
    api.get(`/major-incidents/criteria/${ticketId}`, { quiet: true })
      .then((d) => setSignals(d.signals || []))
      .catch(() => setSignals([]));
  }, [ticketId]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const { proposal } = await api.post('/major-incidents/proposals', {
        ticket_id: ticketId,
        reason,
        suggested_severity: severity,
        affected_service: service,
        users_affected: usersAffected,
      });
      onProposed(proposal);
    } catch (err) { setError(err.message); setSaving(false); }
  };

  return (
    <Modal title="Propose a Major Incident" onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={submit} className="space-y-4">
        {error && (
          <div className="flex items-start gap-2 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {error}
          </div>
        )}

        <p className="text-xs text-slate-500 dark:text-slate-400">
          This raises it for a manager to decide. The incident itself is not changed until somebody promotes it.
        </p>

        {signals !== null && (
          <div className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">What the system already notices</p>
            {!signals.length ? (
              <p className="text-xs text-slate-400">
                Nothing automatic stands out, which does not mean it is not major — the judgement is yours to make and explain.
              </p>
            ) : (
              <ul className="space-y-1">
                {signals.map((s) => (
                  <li key={s.key} className="flex items-start gap-1.5 text-xs text-slate-600 dark:text-slate-300">
                    <CheckCircle2 size={12} className="mt-0.5 shrink-0 text-amber-500" /> {s.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div>
          <label className="label">Why this is major<span className="text-red-500">*</span></label>
          <SonaTextarea purpose="Why this is a major incident"
            className="input min-h-[70px]" autoFocus value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="What is unavailable, who it affects, and what happens if it continues."
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label className="label">Suggested severity</label>
            <Select value={severity} onChange={setSeverity} options={SEVERITIES} />
          </div>
          <div>
            <label className="label">Affected service</label>
            <input className="input" value={service} onChange={(e) => setService(e.target.value)} placeholder="e.g. Payroll" />
          </div>
        </div>

        <div>
          <label className="label">Who is affected</label>
          <input
            className="input" value={usersAffected} onChange={(e) => setUsersAffected(e.target.value)}
            placeholder="e.g. around 400 staff across two sites"
          />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving || !reason.trim()} className="btn-primary disabled:opacity-40">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Siren size={14} />} Propose
          </button>
        </div>
      </form>
    </Modal>
  );
}
