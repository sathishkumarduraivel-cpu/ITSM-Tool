import { useEffect, useState } from 'react';
import {
  Loader2, Plus, Trash2, Pencil, Users, Sparkles, FlaskConical, History,
  ToggleLeft, ToggleRight, CheckCircle2, XCircle, Gauge, CalendarOff, Target, Bot, Wifi,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import EmptyState from '../EmptyState.jsx';
import Select from '../Select.jsx';

const SUB_TABS = [
  { key: 'policies', label: 'Routing Policies', icon: Target },
  { key: 'roster', label: 'Agent Availability', icon: Users },
  { key: 'simulator', label: 'Dry-run Simulator', icon: FlaskConical },
  { key: 'log', label: 'Decision Log', icon: History },
];

const STRATEGIES = [
  { value: 'least_loaded', label: 'Least loaded — fewest open tickets wins' },
  { value: 'round_robin', label: 'Round robin — whoever waited longest' },
  { value: 'oncall_first', label: 'On-call first — prefer the rota holder' },
  { value: 'ai_sona', label: 'Sona (AI) — best fit for the ticket' },
];

const FALLBACKS = [
  { value: 'least_loaded', label: 'Least loaded' },
  { value: 'round_robin', label: 'Round robin' },
  { value: 'oncall_first', label: 'On-call first' },
];

const TICKET_TYPES = [
  { value: '', label: 'Any type' }, { value: 'incident', label: 'Incident' },
  { value: 'request', label: 'Request' }, { value: 'problem', label: 'Problem' }, { value: 'change', label: 'Change' },
];
const PRIORITIES = [
  { value: '', label: 'Any priority' }, { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' }, { value: 'high', label: 'High' }, { value: 'critical', label: 'Critical' },
];
const STATUS_META = {
  available: { label: 'Available', cls: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300' },
  busy: { label: 'Busy', cls: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' },
  dnd: { label: 'Do not disturb', cls: 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' },
};

function Toggle({ on, onClick, label, hint }) {
  return (
    <button type="button" onClick={onClick} className="flex w-full items-start gap-2 rounded-xl border border-slate-200 p-2.5 text-left transition-colors hover:bg-slate-50 dark:border-white/10 dark:hover:bg-slate-800/50">
      {on ? <ToggleRight size={18} className="mt-0.5 shrink-0 text-brand-600" /> : <ToggleLeft size={18} className="mt-0.5 shrink-0 text-slate-400" />}
      <span className="min-w-0">
        <span className="block text-sm font-medium text-slate-700 dark:text-slate-200">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">{hint}</span>}
      </span>
    </button>
  );
}

function PolicyModal({ initial, groups, schedules, agents, onClose, onSaved }) {
  const [f, setF] = useState(() => ({
    name: initial?.name || '',
    match_type: initial?.match_type || '',
    match_priority: initial?.match_priority || '',
    match_team: initial?.match_team || '',
    match_category: initial?.match_category || '',
    strategy: initial?.strategy || 'least_loaded',
    candidate_source: initial?.candidate_source || 'group',
    candidate_group_id: initial?.candidate_group_id || '',
    candidate_schedule_id: initial?.candidate_schedule_id || '',
    respect_presence: !!initial?.respect_presence,
    respect_oncall: !!initial?.respect_oncall,
    respect_status: initial ? !!initial.respect_status : true,
    respect_capacity: initial ? !!initial.respect_capacity : true,
    ai_enabled: !!initial?.ai_enabled,
    fallback_strategy: initial?.fallback_strategy || 'least_loaded',
  }));
  const [explicit, setExplicit] = useState(() => (initial?.explicit_candidates || []).map((c) => c.user_id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setF((cur) => ({ ...cur, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = { ...f, explicit_user_ids: f.candidate_source === 'explicit_list' ? explicit : undefined };
      if (initial) await api.patch(`/assignment/policies/${initial.id}`, body);
      else await api.post('/assignment/policies', body);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit routing policy' : 'New routing policy'} onClose={onClose} maxWidth="max-w-2xl">
      <form onSubmit={submit} className="space-y-4">
        <div>
          <label className="label">Policy name</label>
          <input className="input" value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Critical incidents to on-call" required />
        </div>

        <div>
          <h5 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Applies to</h5>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="label">Type</label>
              <Select value={f.match_type} onChange={(v) => set('match_type', v)} options={TICKET_TYPES} />
            </div>
            <div>
              <label className="label">Priority</label>
              <Select value={f.match_priority} onChange={(v) => set('match_priority', v)} options={PRIORITIES} />
            </div>
            <div>
              <label className="label">Group</label>
              <input className="input" value={f.match_team} onChange={(e) => set('match_team', e.target.value)} placeholder="Any" />
            </div>
            <div>
              <label className="label">Category</label>
              <input className="input" value={f.match_category} onChange={(e) => set('match_category', e.target.value)} placeholder="Any" />
            </div>
          </div>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Leave a field blank to match anything. The most specific matching policy wins, so a catch-all with everything blank is a safe default.
          </p>
        </div>

        <div>
          <h5 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Who can receive it</h5>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Candidate pool</label>
              <Select
                value={f.candidate_source}
                onChange={(v) => set('candidate_source', v)}
                options={[
                  { value: 'group', label: 'A group' },
                  { value: 'oncall_schedule', label: 'An on-call schedule' },
                  { value: 'explicit_list', label: 'A specific list of people' },
                ]}
              />
            </div>
            {f.candidate_source === 'group' && (
              <div>
                <label className="label">Group</label>
                <Select
                  value={f.candidate_group_id}
                  onChange={(v) => set('candidate_group_id', v)}
                  options={[{ value: '', label: 'Everyone in the workspace' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
                />
              </div>
            )}
            {f.candidate_source === 'oncall_schedule' && (
              <div>
                <label className="label">Schedule</label>
                <Select
                  value={f.candidate_schedule_id}
                  onChange={(v) => set('candidate_schedule_id', v)}
                  options={[{ value: '', label: 'Pick a schedule…' }, ...schedules.map((s) => ({ value: s.id, label: s.name }))]}
                />
              </div>
            )}
          </div>
          {f.candidate_source === 'explicit_list' && (
            <div className="mt-3 flex flex-wrap gap-1.5 rounded-xl border border-slate-200 p-2.5 dark:border-white/10">
              {agents.map((a) => {
                const on = explicit.includes(a.id);
                return (
                  <button
                    key={a.id} type="button"
                    onClick={() => setExplicit(on ? explicit.filter((x) => x !== a.id) : [...explicit, a.id])}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      on ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300'
                    }`}
                  >
                    {a.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div>
          <h5 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">Availability rules</h5>
          <div className="grid gap-2 sm:grid-cols-2">
            <Toggle on={f.respect_status} onClick={() => set('respect_status', !f.respect_status)}
              label="Respect do-not-disturb" hint="Someone on do-not-disturb is skipped entirely." />
            <Toggle on={f.respect_capacity} onClick={() => set('respect_capacity', !f.respect_capacity)}
              label="Respect ticket capacity" hint="Nobody is given work past their configured limit." />
            <Toggle on={f.respect_oncall} onClick={() => set('respect_oncall', !f.respect_oncall)}
              label="On-call only" hint="Only whoever currently holds a rotation may receive this." />
            <Toggle on={f.respect_presence} onClick={() => set('respect_presence', !f.respect_presence)}
              label="Favour people with the app open" hint="A weighting, not a block — someone working by email is still available." />
          </div>
          <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">
            Active time off always blocks assignment, whatever these are set to.
          </p>
        </div>

        <div>
          <h5 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-slate-500 dark:text-slate-400">How to choose</h5>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label">Strategy</label>
              <Select value={f.strategy} onChange={(v) => set('strategy', v)} options={STRATEGIES} />
            </div>
            {f.strategy === 'ai_sona' && (
              <div>
                <label className="label">If Sona is unavailable</label>
                <Select value={f.fallback_strategy} onChange={(v) => set('fallback_strategy', v)} options={FALLBACKS} />
              </div>
            )}
          </div>
          {f.strategy === 'ai_sona' && (
            <div className="mt-2 space-y-2">
              <Toggle on={f.ai_enabled} onClick={() => set('ai_enabled', !f.ai_enabled)}
                label="Let Sona make the call" hint="Sona only ever picks from candidates that already passed every rule above." />
              <div className="flex items-start gap-2 rounded-xl bg-brand-50 p-2.5 text-xs text-brand-800 dark:bg-brand-500/10 dark:text-brand-200">
                <Bot size={14} className="mt-0.5 shrink-0" />
                <span>
                  Sona reads the ticket text and each candidate&apos;s skills and current load, then picks the best fit and explains why.
                  It cannot override capacity, time off or do-not-disturb, and if no AI provider is configured it falls back automatically.
                </span>
              </div>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {initial ? 'Save policy' : 'Create policy'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function PoliciesPane({ policies, groups, schedules, agents, onChanged }) {
  const [modal, setModal] = useState(null);

  const toggle = async (p) => { await api.patch(`/assignment/policies/${p.id}`, { enabled: !p.enabled }); onChanged(); };
  const remove = async (p) => {
    if (!window.confirm(`Delete policy "${p.name}"?`)) return;
    await api.del(`/assignment/policies/${p.id}`);
    onChanged();
  };

  const describe = (p) => {
    const bits = [];
    if (p.match_type) bits.push(p.match_type);
    if (p.match_priority) bits.push(`${p.match_priority} priority`);
    if (p.match_team) bits.push(`group ${p.match_team}`);
    if (p.match_category) bits.push(p.match_category);
    return bits.length ? bits.join(' · ') : 'Any ticket';
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
          When a ticket is raised with no owner, the most specific matching policy decides who gets it — filtering on real availability first, then choosing.
        </p>
        <button onClick={() => setModal('new')} className="btn-primary shrink-0"><Plus size={14} /> New policy</button>
      </div>

      {policies.length === 0 ? (
        <EmptyState
          icon={Target}
          title="No routing policies yet"
          description="Without one, new tickets stay unassigned until someone picks them up. Start with a catch-all that routes to your service desk group."
          action={<button onClick={() => setModal('new')} className="btn-primary"><Plus size={14} /> New policy</button>}
        />
      ) : (
        <div className="space-y-2">
          {policies.map((p) => (
            <div key={p.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{p.name}</h4>
                    {!p.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">off</span>}
                    {p.strategy === 'ai_sona' && p.ai_enabled && (
                      <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><Sparkles size={10} /> Sona</span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">{describe(p)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => toggle(p)} className="btn-ghost p-1.5" aria-label={p.enabled ? 'Disable' : 'Enable'}>
                    {p.enabled ? <ToggleRight size={18} className="text-emerald-600" /> : <ToggleLeft size={18} className="text-slate-400" />}
                  </button>
                  <button onClick={() => setModal(p)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={14} /></button>
                  <button onClick={() => remove(p)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={14} /></button>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
                <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                  {STRATEGIES.find((s) => s.value === p.strategy)?.label.split(' — ')[0] || p.strategy}
                </span>
                {p.respect_status ? <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">respects DND</span> : null}
                {p.respect_capacity ? <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">respects capacity</span> : null}
                {p.respect_oncall ? <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">on-call only</span> : null}
                {p.respect_presence ? <span className="badge bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300">favours live presence</span> : null}
              </div>
            </div>
          ))}
        </div>
      )}

      {modal && (
        <PolicyModal
          initial={modal === 'new' ? null : modal}
          groups={groups} schedules={schedules} agents={agents}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); onChanged(); }}
        />
      )}
    </div>
  );
}

function TimeOffModal({ member, onClose, onSaved }) {
  const pad = (n) => String(n).padStart(2, '0');
  const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const [startAt, setStartAt] = useState(localInput(now));
  const [endAt, setEndAt] = useState(localInput(new Date(now.getTime() + 24 * 3600 * 1000)));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post(`/assignment/roster/${member.id}/time-off`, {
        start_at: new Date(startAt).toISOString(), end_at: new Date(endAt).toISOString(), reason,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Time off — ${member.name}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          While this is active, no policy will assign them a ticket, whatever its other settings.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">From</label>
            <input type="datetime-local" className="input" value={startAt} onChange={(e) => setStartAt(e.target.value)} required />
          </div>
          <div>
            <label className="label">Until</label>
            <input type="datetime-local" className="input" value={endAt} onChange={(e) => setEndAt(e.target.value)} required />
          </div>
        </div>
        <div>
          <label className="label">Reason</label>
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Annual leave" />
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Add time off
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RosterPane({ roster, onChanged }) {
  const [editing, setEditing] = useState(null);
  const [timeOffFor, setTimeOffFor] = useState(null);
  const [draft, setDraft] = useState({});

  const startEdit = (m) => {
    setEditing(m.id);
    setDraft({ status: m.status, max_concurrent_tickets: m.max_concurrent_tickets, skills: (m.skills || []).join(', ') });
  };

  const save = async (m) => {
    await api.patch(`/assignment/roster/${m.id}`, {
      status: draft.status,
      max_concurrent_tickets: Number(draft.max_concurrent_tickets) || 10,
      skills: String(draft.skills || '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    setEditing(null);
    onChanged();
  };

  const removeTimeOff = async (id) => { await api.del(`/assignment/time-off/${id}`); onChanged(); };

  return (
    <div className="space-y-3">
      <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
        Capacity and skills are what the routing engine reasons over. Agents can set their own status; capacity and skills are yours to set.
      </p>

      <div className="space-y-2">
        {roster.map((m) => {
          const meta = STATUS_META[m.status] || STATUS_META.available;
          const pct = m.max_concurrent_tickets > 0 ? Math.min(100, (m.open_tickets / m.max_concurrent_tickets) * 100) : 0;
          const atCap = m.open_tickets >= m.max_concurrent_tickets;
          return (
            <div key={m.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{m.name}</h4>
                    <span className={`badge ${meta.cls}`}>{meta.label}</span>
                    {m.role === 'admin' && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">admin</span>}
                    {m.time_off.length > 0 && (
                      <span className="badge bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300"><CalendarOff size={10} /> time off booked</span>
                    )}
                  </div>
                  {m.status_message && <p className="mt-0.5 text-xs italic text-slate-500 dark:text-slate-400">&ldquo;{m.status_message}&rdquo;</p>}
                  {m.skills.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {m.skills.map((s) => (
                        <span key={s} className="badge bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300">{s}</span>
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button onClick={() => setTimeOffFor(m)} className="btn-secondary text-xs"><CalendarOff size={12} /> Time off</button>
                  {editing === m.id
                    ? <button onClick={() => save(m)} className="btn-primary text-xs">Save</button>
                    : <button onClick={() => startEdit(m)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={14} /></button>}
                </div>
              </div>

              <div className="mt-3 flex items-center gap-3">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
                  <div className={`h-full rounded-full ${atCap ? 'bg-red-500' : pct > 70 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
                </div>
                <span className={`shrink-0 text-xs font-medium ${atCap ? 'text-red-600 dark:text-red-400' : 'text-slate-500 dark:text-slate-400'}`}>
                  <Gauge size={11} className="mr-1 inline" />{m.open_tickets} / {m.max_concurrent_tickets} open
                </span>
              </div>

              {editing === m.id && (
                <div className="mt-3 grid gap-3 rounded-xl border border-slate-200 p-3 sm:grid-cols-3 dark:border-white/10">
                  <div>
                    <label className="label">Status</label>
                    <Select
                      value={draft.status}
                      onChange={(v) => setDraft({ ...draft, status: v })}
                      options={Object.entries(STATUS_META).map(([value, m2]) => ({ value, label: m2.label }))}
                    />
                  </div>
                  <div>
                    <label className="label">Ticket capacity</label>
                    <input type="number" min="1" max="999" className="input" value={draft.max_concurrent_tickets}
                      onChange={(e) => setDraft({ ...draft, max_concurrent_tickets: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Skills (comma separated)</label>
                    <input className="input" value={draft.skills} onChange={(e) => setDraft({ ...draft, skills: e.target.value })}
                      placeholder="networking, VPN, Cisco" />
                  </div>
                </div>
              )}

              {m.time_off.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {m.time_off.map((t) => (
                    <li key={t.id} className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
                      <CalendarOff size={11} className="shrink-0" />
                      {new Date(t.start_at).toLocaleString()} → {new Date(t.end_at).toLocaleString()}
                      {t.reason ? ` · ${t.reason}` : ''}
                      <button onClick={() => removeTimeOff(t.id)} className="btn-ghost ml-auto p-0.5 text-red-500" aria-label="Remove time off"><Trash2 size={11} /></button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {timeOffFor && (
        <TimeOffModal member={timeOffFor} onClose={() => setTimeOffFor(null)} onSaved={() => { setTimeOffFor(null); onChanged(); }} />
      )}
    </div>
  );
}

function SimulatorPane() {
  const [f, setF] = useState({ type: 'incident', priority: 'high', team: '', category: '', title: '', description: '', use_ai: false });
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setF((cur) => ({ ...cur, [k]: v }));

  const run = async () => {
    setRunning(true);
    setError('');
    setResult(null);
    try {
      setResult(await api.post('/assignment/simulate', f));
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="max-w-2xl text-sm text-slate-500 dark:text-slate-400">
        Runs the real routing logic against a pretend ticket and shows exactly who it would pick — and who it ruled out, and why. Nothing is assigned.
      </p>

      <div className="card space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-4">
          <div>
            <label className="label">Type</label>
            <Select value={f.type} onChange={(v) => set('type', v)} options={TICKET_TYPES.filter((t) => t.value)} />
          </div>
          <div>
            <label className="label">Priority</label>
            <Select value={f.priority} onChange={(v) => set('priority', v)} options={PRIORITIES.filter((p) => p.value)} />
          </div>
          <div>
            <label className="label">Group</label>
            <input className="input" value={f.team} onChange={(e) => set('team', e.target.value)} placeholder="Optional" />
          </div>
          <div>
            <label className="label">Category</label>
            <input className="input" value={f.category} onChange={(e) => set('category', e.target.value)} placeholder="Optional" />
          </div>
        </div>
        <div>
          <label className="label">Ticket title</label>
          <input className="input" value={f.title} onChange={(e) => set('title', e.target.value)} placeholder="VPN keeps dropping on the Cisco concentrator" />
        </div>
        <div>
          <label className="label">Description</label>
          <textarea className="input min-h-[70px]" value={f.description} onChange={(e) => set('description', e.target.value)}
            placeholder="Give Sona something to reason about — the wording is what skill matching keys off." />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button type="button" onClick={() => set('use_ai', !f.use_ai)} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
            {f.use_ai ? <ToggleRight size={18} className="text-brand-600" /> : <ToggleLeft size={18} className="text-slate-400" />}
            Ask Sona too <span className="text-xs text-slate-400">(uses your AI provider — costs a call)</span>
          </button>
          <button onClick={run} disabled={running} className="btn-primary">
            {running ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} Run simulation
          </button>
        </div>
      </div>

      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}

      {result && (
        <div className="space-y-3">
          {!result.policy ? (
            <div className="card p-4 text-sm text-amber-700 dark:text-amber-300">
              {result.rationale} — a ticket like this would stay unassigned.
            </div>
          ) : (
            <>
              <div className="card p-4">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-slate-500 dark:text-slate-400">Matched policy</span>
                  <span className="font-semibold text-slate-800 dark:text-slate-100">{result.policy.name}</span>
                  {result.ai_used && <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><Sparkles size={10} /> decided by Sona</span>}
                  <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{result.strategy_used}</span>
                </div>
                <div className={`mt-2 flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${
                  result.chosen
                    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-300'
                }`}>
                  {result.chosen ? <CheckCircle2 size={15} className="mt-0.5 shrink-0" /> : <XCircle size={15} className="mt-0.5 shrink-0" />}
                  <span>
                    {result.chosen ? <><strong>{result.chosen.name}</strong> would get this ticket</> : 'Nobody would get this ticket'}
                    {result.rationale ? ` — ${result.rationale}` : ''}
                  </span>
                </div>
              </div>

              <div className="card overflow-hidden p-0">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500 dark:bg-slate-800/60 dark:text-slate-400">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium">Candidate</th>
                      <th className="px-4 py-2 text-left font-medium">Load</th>
                      <th className="px-4 py-2 text-left font-medium">Signals</th>
                      <th className="px-4 py-2 text-left font-medium">Score</th>
                      <th className="px-4 py-2 text-left font-medium">Verdict</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.candidates.map((c) => (
                      <tr key={c.user_id} className={`border-t border-slate-100 dark:border-white/5 ${
                        c.user_id === result.chosen?.user_id ? 'bg-emerald-50/60 dark:bg-emerald-500/5' : ''
                      }`}>
                        <td className="px-4 py-2">
                          <div className="font-medium text-slate-800 dark:text-slate-100">{c.name}</div>
                          {c.skills?.length > 0 && <div className="text-xs text-slate-400">{c.skills.join(', ')}</div>}
                        </td>
                        <td className="px-4 py-2 text-slate-600 dark:text-slate-300">{c.open_tickets}/{c.capacity}</td>
                        <td className="px-4 py-2">
                          <div className="flex flex-wrap gap-1">
                            {c.on_call && <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">on call</span>}
                            {c.online && <span className="badge bg-cyan-50 text-cyan-700 dark:bg-cyan-500/10 dark:text-cyan-300"><Wifi size={9} /> online</span>}
                            {c.status !== 'available' && <span className={`badge ${STATUS_META[c.status]?.cls || ''}`}>{STATUS_META[c.status]?.label}</span>}
                          </div>
                        </td>
                        <td className="px-4 py-2 font-mono text-xs text-slate-500 dark:text-slate-400">{c.score}</td>
                        <td className="px-4 py-2">
                          {c.eligible
                            ? <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400"><CheckCircle2 size={12} /> eligible</span>
                            : <span className="inline-flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400"><XCircle size={12} className="text-red-500" /> {c.blocked.join(', ')}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {result.candidates.length === 0 && (
                  <p className="p-4 text-center text-sm text-slate-400">This policy produced no candidates at all — check its candidate pool.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function LogPane() {
  const [log, setLog] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [error, setError] = useState('');

  const load = () => {
    setError('');
    api.get('/assignment/log?limit=50').then((d) => setLog(d.log)).catch((e) => { setError(e.message); setLog([]); });
  };
  useEffect(load, []);

  if (error) return <p className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!log) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading decisions…</p>;
  if (!log.length) {
    return <EmptyState icon={History} title="No routing decisions yet" description="Every automatic assignment lands here with the full candidate set it chose from." />;
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-500 dark:text-slate-400">
        Every automatic decision, including the ones that assigned nobody — with the scores as they were at the time.
      </p>
      {log.map((entry) => (
        <div key={entry.id} className="card p-3">
          <button onClick={() => setExpanded(expanded === entry.id ? null : entry.id)} className="w-full text-left">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {entry.assigned_name
                ? <><CheckCircle2 size={14} className="shrink-0 text-emerald-600" /><span className="font-medium text-slate-800 dark:text-slate-100">{entry.assigned_name}</span></>
                : <><XCircle size={14} className="shrink-0 text-amber-500" /><span className="font-medium text-slate-500 dark:text-slate-400">Nobody</span></>}
              {entry.ticket_number && <span className="text-slate-400">· {entry.ticket_number}</span>}
              {entry.ai_used ? <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300"><Sparkles size={10} /> Sona</span> : null}
              <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">{entry.strategy_used || 'n/a'}</span>
              <span className="ml-auto shrink-0 text-xs text-slate-400">{new Date(entry.created_at.replace(' ', 'T') + 'Z').toLocaleString()}</span>
            </div>
            {entry.rationale && <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{entry.rationale}</p>}
          </button>
          {expanded === entry.id && entry.candidates.length > 0 && (
            <ul className="mt-2 space-y-1 border-t border-slate-100 pt-2 text-xs dark:border-white/5">
              {entry.candidates.map((c) => (
                <li key={c.user_id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium text-slate-700 dark:text-slate-200">{c.name}</span>
                  <span className="text-slate-400">{c.open_tickets}/{c.capacity}</span>
                  <span className="font-mono text-slate-400">score {c.score}</span>
                  {c.eligible ? <span className="text-emerald-600 dark:text-emerald-400">eligible</span> : <span className="text-red-500">{c.blocked?.join(', ')}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

export default function AssignmentPolicyTab() {
  const [tab, setTab] = useState('policies');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = async () => {
    setError('');
    try {
      const [{ policies }, { roster }, groupsResp, schedulesResp] = await Promise.all([
        api.get('/assignment/policies'),
        api.get('/assignment/roster'),
        api.get('/groups').catch(() => ({ groups: [] })),
        api.get('/oncall/schedules').catch(() => ({ schedules: [] })),
      ]);
      setData({ policies, roster, groups: groupsResp.groups || [], schedules: schedulesResp.schedules || [] });
    } catch (e) {
      setError(e.message);
      setData(null);
    }
  };

  useEffect(() => { load(); }, []);

  if (error) {
    return (
      <div className="py-10 text-center text-sm">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <button onClick={load} className="btn-secondary mx-auto mt-2 text-xs">Retry</button>
      </div>
    );
  }
  if (!data) return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading routing configuration…</p>;

  const agents = data.roster.map((r) => ({ id: r.id, name: r.name }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1.5 border-b border-slate-200 pb-2 dark:border-white/10">
        {SUB_TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key} onClick={() => setTab(t.key)}
              className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                tab === t.key
                  ? 'bg-brand-600 text-white'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'
              }`}
            >
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'policies' && (
        <PoliciesPane policies={data.policies} groups={data.groups} schedules={data.schedules} agents={agents} onChanged={load} />
      )}
      {tab === 'roster' && <RosterPane roster={data.roster} onChanged={load} />}
      {tab === 'simulator' && <SimulatorPane />}
      {tab === 'log' && <LogPane />}
    </div>
  );
}
