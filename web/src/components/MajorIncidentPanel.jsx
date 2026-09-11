import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Siren, AlertTriangle, Loader2 } from 'lucide-react';
import { api } from '../lib/api.js';
import { SeverityBadge, MiStatusBadge } from './Badge.jsx';
import Modal from './Modal.jsx';
import Select from './Select.jsx';

function DeclareModal({ ticketId, onClose, onDeclared }) {
  const [severity, setSeverity] = useState('sev2');
  const [summary, setSummary] = useState('');
  const [impactDescription, setImpactDescription] = useState('');
  const [updateIntervalMinutes, setUpdateIntervalMinutes] = useState(30);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const { majorIncident } = await api.post('/major-incidents', {
        ticket_id: ticketId, severity, summary, impact_description: impactDescription, update_interval_minutes: Number(updateIntervalMinutes),
      });
      onDeclared(majorIncident);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Declare Major Incident" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <p className="text-xs text-slate-500 dark:text-slate-400">
          This raises the ticket to critical priority, opens a coordination timeline, and starts a recurring update cadence until it's resolved.
        </p>
        <div>
          <label className="label">Severity</label>
          <Select
            value={severity} onChange={setSeverity}
            options={[
              { value: 'sev1', label: 'SEV1 — critical, widespread impact' },
              { value: 'sev2', label: 'SEV2 — significant impact' },
              { value: 'sev3', label: 'SEV3 — limited impact' },
            ]}
          />
        </div>
        <div>
          <label className="label">Headline summary</label>
          <input className="input" required placeholder="e.g. Email delivery down for all EU users" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </div>
        <div>
          <label className="label">Impact (optional)</label>
          <textarea className="input" rows={2} value={impactDescription} onChange={(e) => setImpactDescription(e.target.value)} />
        </div>
        <div>
          <label className="label">Post an update every</label>
          <Select
            value={updateIntervalMinutes} onChange={(v) => setUpdateIntervalMinutes(Number(v))}
            options={[
              { value: 15, label: '15 minutes' },
              { value: 30, label: '30 minutes' },
              { value: 60, label: '1 hour' },
              { value: 120, label: '2 hours' },
            ]}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving || !summary.trim()} className="btn-danger">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Siren size={14} />} Declare
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function MajorIncidentPanel({ ticketId, ticketType, isAgent, majorIncident, relatedMajorIncidents, onChanged }) {
  const [declaring, setDeclaring] = useState(false);

  if (!isAgent && !majorIncident && (!relatedMajorIncidents || relatedMajorIncidents.length === 0)) return null;

  return (
    <>
      {majorIncident && (
        <div className={`card p-4 border ${majorIncident.updateOverdue ? 'border-red-300 dark:border-red-800' : 'border-slate-200 dark:border-slate-700'}`}>
          <Link to={`/major-incidents/${majorIncident.id}`} className="flex items-center gap-2 mb-1.5 hover:underline">
            <Siren size={15} className="text-red-500 shrink-0" />
            <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{majorIncident.number}</span>
            <SeverityBadge severity={majorIncident.severity} />
            <MiStatusBadge status={majorIncident.status} />
          </Link>
          <p className="text-sm text-slate-600 dark:text-slate-300">{majorIncident.summary}</p>
          {majorIncident.updateOverdue && (
            <p className="text-xs text-red-600 dark:text-red-400 flex items-center gap-1 mt-1.5"><AlertTriangle size={12} /> A status update is overdue.</p>
          )}
        </div>
      )}

      {relatedMajorIncidents?.map((mi) => (
        <div key={mi.id} className="card p-4">
          <Link to={`/major-incidents/${mi.id}`} className="flex items-center gap-2 hover:underline">
            <Siren size={14} className="text-amber-500 shrink-0" />
            <span className="text-sm text-slate-700 dark:text-slate-200">Related to <span className="font-semibold">{mi.number}</span></span>
            <MiStatusBadge status={mi.status} />
          </Link>
          <p className="text-xs text-slate-500 mt-1">{mi.summary}</p>
        </div>
      ))}

      {isAgent && ticketType === 'incident' && !majorIncident && (
        <button onClick={() => setDeclaring(true)} className="btn-secondary w-full justify-center text-red-600 dark:text-red-400 border-red-200 dark:border-red-900">
          <Siren size={14} /> Declare Major Incident
        </button>
      )}

      {declaring && (
        <DeclareModal ticketId={ticketId} onClose={() => setDeclaring(false)} onDeclared={() => { setDeclaring(false); onChanged(); }} />
      )}
    </>
  );
}
