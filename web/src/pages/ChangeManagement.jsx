import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus, Search, LayoutList, CalendarDays, Users, BarChart3, Loader2, Snowflake,
  AlertTriangle, Gauge, ShieldCheck, ClipboardCheck, ChevronRight, CheckCircle2,
  XCircle, Clock, GitBranch,
} from 'lucide-react';
import { api } from '../lib/api.js';
import { fmtDateTime, fmtRelative, fmtDate } from '../lib/dates.js';
import PageHeader from '../components/PageHeader.jsx';
import NewTicketModal from '../components/NewTicketModal.jsx';
import Modal from '../components/Modal.jsx';
import Select from '../components/Select.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { SkeletonRows } from '../components/Skeleton.jsx';

const VIEWS = [
  { key: 'pipeline', label: 'Pipeline', icon: LayoutList },
  { key: 'calendar', label: 'Calendar', icon: CalendarDays },
  { key: 'cab', label: 'CAB', icon: Users },
  { key: 'metrics', label: 'Metrics', icon: BarChart3 },
];

const COLUMNS = [
  { key: 'new', label: 'New' },
  { key: 'in_review', label: 'In Review' },
  { key: 'pending_approval', label: 'Pending Approval' },
  { key: 'approved', label: 'Approved' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'in_progress', label: 'In Progress' },
  { key: 'implemented', label: 'Implemented' },
  { key: 'rolled_back', label: 'Rolled Back' },
  { key: 'reopened', label: 'Reopened' },
  { key: 'closed', label: 'Closed' },
];

const BAND_STYLES = {
  low: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  medium: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300',
  high: 'bg-orange-50 text-orange-700 dark:bg-orange-500/10 dark:text-orange-300',
  critical: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
};
const TYPE_STYLES = {
  standard: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300',
  normal: 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300',
  emergency: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300',
  expedite: 'bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300',
};

function ChangeCard({ change, onOpen }) {
  return (
    <button onClick={onOpen} className="w-full rounded-xl border border-slate-200 bg-white p-2.5 text-left transition-shadow hover:shadow-card-hover dark:border-white/10 dark:bg-slate-900/60">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-semibold text-slate-800 dark:text-slate-100">{change.number}</span>
        {change.risk_band && <span className={`badge ${BAND_STYLES[change.risk_band]}`}>{change.risk_score}</span>}
      </div>
      <p className="mt-0.5 line-clamp-2 text-xs text-slate-600 dark:text-slate-300">{change.title}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {change.change_type && <span className={`badge ${TYPE_STYLES[change.change_type] || ''}`}>{change.change_type}</span>}
        {change.pending_approvals > 0 && (
          <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{change.pending_approvals} to approve</span>
        )}
        {change.freeze_override_reason && <span className="badge bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300"><Snowflake size={9} /> override</span>}
      </div>
      {change.scheduled_start && (
        <p className="mt-1 flex items-center gap-1 text-[10px] text-slate-400"><Clock size={9} /> {fmtDateTime(change.scheduled_start)}</p>
      )}
    </button>
  );
}

function PipelineView({ changes, counts, onOpen }) {
  const byState = useMemo(() => {
    const map = {};
    for (const c of changes) {
      const key = c.change_state || 'new';
      (map[key] ||= []).push(c);
    }
    return map;
  }, [changes]);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {COLUMNS.map((col) => {
        const items = byState[col.key] || [];
        return (
          <div key={col.key} className="w-[220px] shrink-0">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">{col.label}</span>
              <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{counts[col.key] || 0}</span>
            </div>
            <div className="space-y-2">
              {items.length === 0 ? (
                <p className="rounded-xl border border-dashed border-slate-200 p-3 text-center text-[11px] text-slate-400 dark:border-slate-700">Nothing here</p>
              ) : items.map((c) => <ChangeCard key={c.id} change={c} onOpen={() => onOpen(c.id)} />)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function CalendarView({ onOpen }) {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null); setError('');
    api.get(`/changes/calendar?days=${days}`).then(setData).catch((e) => setError(e.message));
  }, [days]);

  if (error) return <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Loading the change calendar…</p>;

  // Group reserved slots by local day so the list reads like a calendar.
  const byDay = {};
  for (const slot of data.slots) {
    const key = fmtDate(slot.start_at);
    (byDay[key] ||= []).push(slot);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Reserved implementation windows. Freeze periods are listed separately — a change cannot be scheduled inside one unless its type permits an override.
        </p>
        <Select
          className="w-auto min-w-[130px]" value={String(days)} onChange={(v) => setDays(Number(v))}
          options={[{ value: '7', label: 'Next 7 days' }, { value: '30', label: 'Next 30 days' }, { value: '90', label: 'Next 90 days' }]}
        />
      </div>

      {data.freezes.length > 0 && (
        <div className="card p-3">
          <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <Snowflake size={14} className="text-sky-500" /> Change freezes in this period
          </h4>
          <ul className="space-y-1">
            {data.freezes.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-slate-800 dark:text-slate-100">{f.name}</span>
                <span className="text-slate-500 dark:text-slate-400">{fmtDateTime(f.start_at)} → {fmtDateTime(f.end_at)}</span>
                <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{f.scope}{f.scope_value ? `: ${f.scope_value}` : ''}</span>
                {f.allow_emergency
                  ? <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">emergencies may override</span>
                  : <span className="badge bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300">hard freeze</span>}
                {f.reason && <span className="w-full text-slate-400">{f.reason}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {Object.keys(byDay).length === 0 ? (
        <EmptyState icon={CalendarDays} title="Nothing scheduled" description="Approved changes with a reserved implementation window appear here." />
      ) : (
        <div className="space-y-3">
          {Object.entries(byDay).map(([day, slots]) => (
            <div key={day} className="card p-3">
              <h4 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">{day}</h4>
              <ul className="space-y-1.5">
                {slots.map((s) => (
                  <li key={s.id}>
                    <button onClick={() => onOpen(s.ticket_id)} className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-slate-50 dark:border-white/10 dark:hover:bg-slate-800/50">
                      <span className="font-medium text-slate-800 dark:text-slate-100">{s.number}</span>
                      <span className="flex-1 truncate text-slate-600 dark:text-slate-300">{s.title}</span>
                      {s.change_type && <span className={`badge ${TYPE_STYLES[s.change_type] || ''}`}>{s.change_type}</span>}
                      {s.risk_band && <span className={`badge ${BAND_STYLES[s.risk_band]}`}>{s.risk_band}</span>}
                      <span className="text-slate-400">{fmtDateTime(s.start_at)} → {fmtDateTime(s.end_at)}</span>
                      {s.assignee_name && <span className="text-slate-400">· {s.assignee_name}</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function DecisionModal({ item, onClose, onDecided }) {
  const [decision, setDecision] = useState('approved');
  const [conditions, setConditions] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await api.post(`/cab/agenda/${item.id}/decide`, { decision, conditions: conditions || undefined, notes: notes || undefined });
      onDecided();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  };

  return (
    <Modal title={`Decision — ${item.number}`} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600 dark:text-slate-300">{item.title}</p>
        <div className="flex flex-wrap gap-1.5 text-xs">
          {item.change_type && <span className={`badge ${TYPE_STYLES[item.change_type] || ''}`}>{item.change_type}</span>}
          {item.risk_band && <span className={`badge ${BAND_STYLES[item.risk_band]}`}><Gauge size={9} /> {item.risk_band} · {item.risk_score}</span>}
        </div>
        <div>
          <label className="label">Decision</label>
          <Select
            value={decision} onChange={setDecision}
            options={[
              { value: 'approved', label: 'Approve' },
              { value: 'approved_with_conditions', label: 'Approve with conditions' },
              { value: 'rejected', label: 'Reject' },
              { value: 'deferred', label: 'Defer to the next sitting' },
            ]}
          />
        </div>
        {decision === 'approved_with_conditions' && (
          <div>
            <label className="label">Conditions <span className="text-red-500">*</span></label>
            <input className="input" value={conditions} onChange={(e) => setConditions(e.target.value)} placeholder="The DBA must be on the call" />
          </div>
        )}
        <div>
          <label className="label">Notes for the minutes</label>
          <textarea className="input min-h-[60px]" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="btn-secondary">Cancel</button>
          <button
            onClick={submit}
            disabled={busy || (decision === 'approved_with_conditions' && !conditions.trim())}
            className="btn-primary"
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} Record decision
          </button>
        </div>
      </div>
    </Modal>
  );
}

function MeetingModal({ onClose, onCreated }) {
  const pad = (n) => String(n).padStart(2, '0');
  const local = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const soon = new Date(Date.now() + 86400000);
  const [title, setTitle] = useState('Weekly CAB');
  const [kind, setKind] = useState('cab');
  const [start, setStart] = useState(local(soon));
  const [end, setEnd] = useState(local(new Date(soon.getTime() + 3600000)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api.post('/cab/meetings', { title, kind, start_at: new Date(start).toISOString(), end_at: new Date(end).toISOString() });
      onCreated();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };

  return (
    <Modal title="Schedule a board meeting" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Title</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} required />
        </div>
        <div>
          <label className="label">Board</label>
          <Select value={kind} onChange={setKind} options={[
            { value: 'cab', label: 'CAB — Change Advisory Board' },
            { value: 'ecab', label: 'ECAB — Emergency board' },
          ]} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Starts</label>
            <input type="datetime-local" className="input" value={start} onChange={(e) => setStart(e.target.value)} required />
          </div>
          <div>
            <label className="label">Ends</label>
            <input type="datetime-local" className="input" value={end} onChange={(e) => setEnd(e.target.value)} required />
          </div>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={busy} className="btn-primary">
            {busy ? <Loader2 size={14} className="animate-spin" /> : null} Schedule
          </button>
        </div>
      </form>
    </Modal>
  );
}

function CabView({ onOpen }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [showMeeting, setShowMeeting] = useState(false);
  const [deciding, setDeciding] = useState(null);
  const [busy, setBusy] = useState('');

  const load = async () => {
    setError('');
    try {
      const [meetings, backlog, boards] = await Promise.all([
        api.get('/cab/meetings'),
        api.get('/cab/backlog'),
        api.get('/cab/boards'),
      ]);
      setData({ meetings: meetings.meetings, backlog: backlog.backlog, boards });
    } catch (e) { setError(e.message); }
  };
  useEffect(() => { load(); }, []);

  const addToAgenda = async (meetingId, ticketId) => {
    setBusy(ticketId);
    try { await api.post(`/cab/meetings/${meetingId}/agenda`, { ticket_id: ticketId }); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const setStatus = async (meetingId, status) => {
    setBusy(meetingId);
    try { await api.patch(`/cab/meetings/${meetingId}/status`, { status }); await load(); }
    catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  if (error && !data) return <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Loading the CAB…</p>;

  const openMeetings = data.meetings.filter((m) => ['scheduled', 'in_session'].includes(m.status));

  return (
    <div className="space-y-4">
      {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,320px)]">
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Board meetings</h4>
            <button onClick={() => setShowMeeting(true)} className="btn-primary text-xs"><Plus size={12} /> Schedule</button>
          </div>

          {data.meetings.length === 0 ? (
            <EmptyState icon={Users} title="No meetings yet" description="Schedule a CAB sitting, then build its agenda from the approval backlog." />
          ) : data.meetings.map((m) => (
            <div key={m.id} className="card p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{m.title}</span>
                    <span className={`badge ${m.kind === 'ecab' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' : 'bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300'}`}>
                      {m.kind.toUpperCase()}
                    </span>
                    <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{m.status.replace('_', ' ')}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
                    {fmtDateTime(m.start_at)} → {fmtDateTime(m.end_at)} · {m.attendance.filter((a) => a.present).length}/{m.attendance.length} present
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {m.status === 'scheduled' && (
                    <button onClick={() => setStatus(m.id, 'in_session')} disabled={busy === m.id} className="btn-secondary text-xs">Open session</button>
                  )}
                  {m.status === 'in_session' && (
                    <button onClick={() => setStatus(m.id, 'closed')} disabled={busy === m.id} className="btn-secondary text-xs">Close meeting</button>
                  )}
                </div>
              </div>

              {m.agenda.length === 0 ? (
                <p className="mt-2 text-xs text-slate-400">No items on the agenda yet.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {m.agenda.map((item) => (
                    <li key={item.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-2.5 py-1.5 text-xs dark:border-white/10">
                      <button onClick={() => onOpen(item.ticket_id)} className="font-medium text-slate-800 hover:underline dark:text-slate-100">{item.number}</button>
                      <span className="flex-1 truncate text-slate-600 dark:text-slate-300">{item.title}</span>
                      {item.risk_band && <span className={`badge ${BAND_STYLES[item.risk_band]}`}>{item.risk_band}</span>}
                      {item.decision ? (
                        <span className={`badge ${
                          item.decision === 'approved' ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300'
                            : item.decision === 'rejected' ? 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300'
                              : 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300'
                        }`}>{item.decision.replace(/_/g, ' ')}</span>
                      ) : (
                        <button onClick={() => setDeciding(item)} className="btn-primary text-xs">Decide</button>
                      )}
                      {item.conditions && <span className="w-full text-amber-700 dark:text-amber-300">Conditions: {item.conditions}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {m.minutes && <p className="mt-2 rounded-lg bg-slate-50 px-2.5 py-1.5 text-xs text-slate-600 dark:bg-slate-800/50 dark:text-slate-300">{m.minutes}</p>}
            </div>
          ))}
        </div>

        <div className="space-y-3">
          <div className="card p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
              <AlertTriangle size={14} className="text-amber-500" /> Awaiting the board
              <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">{data.backlog.length}</span>
            </h4>
            {data.backlog.length === 0 ? (
              <p className="text-xs text-slate-400">Nothing waiting. Changes appear here when they are submitted for approval.</p>
            ) : (
              <ul className="space-y-1.5">
                {data.backlog.map((b) => (
                  <li key={b.id} className="rounded-xl border border-slate-200 p-2 text-xs dark:border-white/10">
                    <div className="flex items-center gap-2">
                      <button onClick={() => onOpen(b.id)} className="font-medium text-slate-800 hover:underline dark:text-slate-100">{b.number}</button>
                      {b.risk_band && <span className={`badge ${BAND_STYLES[b.risk_band]}`}>{b.risk_band}</span>}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-slate-600 dark:text-slate-300">{b.title}</p>
                    {openMeetings.length > 0 && (
                      <Select
                        className="mt-1.5" size="sm" value="" placeholder="Add to a meeting…"
                        onChange={(meetingId) => meetingId && addToAgenda(meetingId, b.id)}
                        options={[{ value: '', label: 'Add to a meeting…' }, ...openMeetings.map((m) => ({ value: m.id, label: m.title }))]}
                        disabled={busy === b.id}
                      />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="card p-3">
            <h4 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Boards</h4>
            {['cab', 'ecab'].map((kind) => (
              <div key={kind} className="mb-2">
                <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{kind}</p>
                {data.boards[kind].members.length === 0 ? (
                  <p className="text-xs text-red-600 dark:text-red-400">
                    Nobody seated — approvals for this board cannot be routed. Add members under Admin Settings → Groups.
                  </p>
                ) : (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {data.boards[kind].members.map((u) => (
                      <span key={u.id} className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{u.name}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {showMeeting && <MeetingModal onClose={() => setShowMeeting(false)} onCreated={() => { setShowMeeting(false); load(); }} />}
      {deciding && <DecisionModal item={deciding} onClose={() => setDeciding(null)} onDecided={() => { setDeciding(null); load(); }} />}
    </div>
  );
}

function Stat({ label, value, suffix = '', tone = 'slate', hint }) {
  const tones = {
    slate: 'text-slate-800 dark:text-slate-100',
    emerald: 'text-emerald-600 dark:text-emerald-400',
    amber: 'text-amber-600 dark:text-amber-400',
    red: 'text-red-600 dark:text-red-400',
  };
  return (
    <div className="card p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 font-display text-2xl font-bold ${tones[tone]}`}>
        {value === null || value === undefined ? '—' : value}{value !== null && value !== undefined ? suffix : ''}
      </p>
      {hint && <p className="mt-0.5 text-[11px] text-slate-400">{hint}</p>}
    </div>
  );
}

function MetricsView({ onOpen }) {
  const [data, setData] = useState(null);
  const [days, setDays] = useState(90);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null); setError('');
    api.get(`/changes/metrics?days=${days}`).then(setData).catch((e) => setError(e.message));
  }, [days]);

  if (error) return <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!data) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={15} className="animate-spin" /> Computing metrics…</p>;

  const m = data.metrics;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500 dark:text-slate-400">Computed live from the change records — nothing here is a stored counter that can drift.</p>
        <Select
          className="w-auto min-w-[130px]" value={String(days)} onChange={(v) => setDays(Number(v))}
          options={[{ value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }, { value: '365', label: 'Last year' }]}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Change success rate" value={m.success_rate_pct} suffix="%" tone={m.success_rate_pct >= 95 ? 'emerald' : m.success_rate_pct >= 85 ? 'amber' : 'red'} hint="Implemented without rollback or a failed PIR" />
        <Stat label="Rollback rate" value={m.rollback_rate_pct} suffix="%" tone={m.rollback_rate_pct > 10 ? 'red' : 'slate'} hint="Backouts as a share of implementations" />
        <Stat label="Emergency ratio" value={m.emergency_ratio_pct} suffix="%" tone={m.emergency_ratio_pct > 20 ? 'amber' : 'slate'} hint="High means change control is being bypassed" />
        <Stat label="Standard ratio" value={m.standard_ratio_pct} suffix="%" tone="emerald" hint="Higher is better — less CAB time per change" />
        <Stat label="Avg lead time" value={m.avg_lead_time_hours} suffix="h" hint="Raised to implementation start" />
        <Stat label="Approval SLA attainment" value={m.approval_sla.attainment_pct} suffix="%" tone={m.approval_sla.attainment_pct >= 90 ? 'emerald' : 'amber'} hint={`${m.approval_sla.breached} of ${m.approval_sla.total} breached`} />
        <Stat label="Freeze overrides" value={m.freeze_overrides} tone={m.freeze_overrides > 0 ? 'amber' : 'slate'} hint="Changes that pierced a freeze" />
        <Stat label="Outstanding PIRs" value={m.pir.outstanding} tone={m.pir.outstanding > 0 ? 'amber' : 'emerald'} hint="Required reviews not yet complete" />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h4 className="mb-2 text-sm font-semibold text-slate-700 dark:text-slate-200">Monthly volume</h4>
          {data.trend.length === 0 ? (
            <p className="text-xs text-slate-400">Not enough history yet.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.trend.map((t) => {
                const max = Math.max(...data.trend.map((x) => x.raised)) || 1;
                return (
                  <li key={t.month} className="flex items-center gap-2 text-xs">
                    <span className="w-16 shrink-0 text-slate-500 dark:text-slate-400">{t.month}</span>
                    <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                      <div className="h-full rounded-full bg-brand-500" style={{ width: `${(t.raised / max) * 100}%` }} />
                    </div>
                    <span className="w-24 shrink-0 text-right text-slate-500 dark:text-slate-400">
                      {t.raised} raised{t.rolled_back > 0 ? `, ${t.rolled_back} back` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card p-4">
          <h4 className="mb-2 flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <ClipboardCheck size={14} /> Reviews outstanding
          </h4>
          {data.outstanding_pirs.length === 0 ? (
            <p className="text-xs text-slate-400">Every required review is complete.</p>
          ) : (
            <ul className="space-y-1.5">
              {data.outstanding_pirs.map((p) => (
                <li key={p.id}>
                  <button onClick={() => onOpen(p.id)} className="flex w-full flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-2.5 py-1.5 text-left text-xs hover:bg-slate-50 dark:border-white/10 dark:hover:bg-slate-800/50">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{p.number}</span>
                    <span className="flex-1 truncate text-slate-600 dark:text-slate-300">{p.title}</span>
                    {p.risk_band && <span className={`badge ${BAND_STYLES[p.risk_band]}`}>{p.risk_band}</span>}
                    <span className="text-slate-400">{fmtRelative(p.actual_end)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ChangeManagement() {
  const [view, setView] = useState('pipeline');
  const [data, setData] = useState(null);
  const [filters, setFilters] = useState({ change_type: '', risk_band: '', q: '' });
  const [showNew, setShowNew] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();

  const load = async () => {
    setError('');
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      setData(await api.get(`/changes?${params.toString()}`));
    } catch (e) { setError(e.message); }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [filters.change_type, filters.risk_band]);

  const open = (id) => navigate(`/tickets/${id}`);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Change Management"
        description="The full change pipeline — classification, risk, CAB approval, scheduling, implementation and review"
        actions={<button onClick={() => setShowNew(true)} className="btn-primary"><Plus size={14} /> New change</button>}
      />

      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-white/10">
        {VIEWS.map((v) => {
          const Icon = v.icon;
          return (
            <button
              key={v.key} onClick={() => setView(v.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                view === v.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <Icon size={14} /> {v.label}
            </button>
          );
        })}
      </div>

      {view === 'pipeline' && (
        <>
          <div className="card flex flex-wrap items-center gap-2 p-3">
            <form onSubmit={(e) => { e.preventDefault(); load(); }} className="relative min-w-[200px] flex-1">
              <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <input className="input pl-9" placeholder="Search changes…" value={filters.q} onChange={(e) => setFilters({ ...filters, q: e.target.value })} />
            </form>
            <Select
              className="w-auto" value={filters.change_type} onChange={(v) => setFilters({ ...filters, change_type: v })}
              options={[{ value: '', label: 'All types' }, { value: 'standard', label: 'Standard' }, { value: 'normal', label: 'Normal' },
                { value: 'emergency', label: 'Emergency' }, { value: 'expedite', label: 'Expedite' }]}
            />
            <Select
              className="w-auto" value={filters.risk_band} onChange={(v) => setFilters({ ...filters, risk_band: v })}
              options={[{ value: '', label: 'All risk' }, { value: 'low', label: 'Low' }, { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' }]}
            />
          </div>

          {error && <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-500/10 dark:text-red-300">{error}</p>}
          {!data ? <SkeletonRows count={4} /> : <PipelineView changes={data.changes} counts={data.counts} onOpen={open} />}
        </>
      )}

      {view === 'calendar' && <CalendarView onOpen={open} />}
      {view === 'cab' && <CabView onOpen={open} />}
      {view === 'metrics' && <MetricsView onOpen={open} />}

      {showNew && (
        <NewTicketModal
          availableTypes={['change']}
          onClose={() => setShowNew(false)}
          onCreated={(ticket) => { setShowNew(false); navigate(`/tickets/${ticket.id}`); }}
        />
      )}
    </div>
  );
}
