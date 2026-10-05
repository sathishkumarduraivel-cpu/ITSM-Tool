import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Send, UserPlus } from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import Select from '../Select.jsx';

const URGENCY_OPTIONS = [
  { value: 'low', label: "Low — I can work around it" },
  { value: 'medium', label: 'Medium — slowing me down' },
  { value: 'high', label: "High — I'm blocked" },
  { value: 'critical', label: 'Critical — affects many people' },
];

// A short, guided "record producer" for requesters -- a few plain questions
// mapped straight onto the real incident fields, so they never see the full
// agent ticket form (type/impact/assignment/etc. — see NewTicketModal.jsx,
// which stays the agent-facing one). Always creates type: 'incident'; a
// requester who wants something provisioned/purchased belongs in the
// Service Catalog instead (see the other Portal home tile).
export default function ReportIssueModal({ onClose, onCreated }) {
  const [category, setCategory] = useState('');
  const [summary, setSummary] = useState('');
  const [details, setDetails] = useState('');
  const [urgency, setUrgency] = useState('medium');
  const [requestedFor, setRequestedFor] = useState('');
  const [people, setPeople] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  // Reporting something for a colleague is a normal thing to need -- someone
  // whose laptop will not start cannot file the ticket about it.
  useEffect(() => { api.get('/auth/users').then(({ users }) => setPeople(users || [])).catch(() => setPeople([])); }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!summary.trim()) return;
    setSaving(true);
    setError('');
    try {
      const { ticket } = await api.post('/tickets', {
        type: 'incident',
        title: summary.trim(),
        description: details.trim(),
        category: category.trim() || null,
        priority: urgency,
        requested_for_id: requestedFor || undefined,
      });
      onCreated(ticket);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Report an issue" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-sm text-slate-500 dark:text-slate-400">Tell us what's wrong — a support agent will pick this up.</p>
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}

        <div>
          <label className="label">What's the issue? *</label>
          <input className="input" required autoFocus placeholder="e.g. My laptop won't connect to VPN" value={summary} onChange={(e) => setSummary(e.target.value)} />
        </div>
        <div>
          <label className="label">More detail (optional)</label>
          <textarea className="input" rows={4} placeholder="What were you doing when it happened? Any error messages?" value={details} onChange={(e) => setDetails(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Category (optional)</label>
            <input className="input" placeholder="e.g. Network, Hardware" value={category} onChange={(e) => setCategory(e.target.value)} />
          </div>
          <div>
            <label className="label">How urgent is this?</label>
            <Select value={urgency} onChange={setUrgency} options={URGENCY_OPTIONS} />
          </div>
        </div>
        <div>
          <label className="label flex items-center gap-1.5"><UserPlus size={12} /> Who is this for?</label>
          <Select
            value={requestedFor} onChange={setRequestedFor} placeholder="Me"
            options={[
              { value: '', label: 'Me' },
              ...people.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
          {!!requestedFor && (
            <p className="mt-1 text-[11px] text-slate-400">
              They will see this ticket too. You stay recorded as the person who reported it.
            </p>
          )}
        </div>

        {urgency === 'critical' && (
          <p className="text-xs text-amber-600 bg-amber-50 dark:bg-amber-500/10 rounded-lg px-3 py-2 flex items-center gap-1.5">
            <AlertTriangle size={13} className="shrink-0" /> For a critical outage affecting many people, also let your team lead know directly.
          </p>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving || !summary.trim()} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Submit
          </button>
        </div>
      </form>
    </Modal>
  );
}
