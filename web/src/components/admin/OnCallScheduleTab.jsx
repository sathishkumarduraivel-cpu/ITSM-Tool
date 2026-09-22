import { useEffect, useMemo, useState } from 'react';
import {
  Loader2, Plus, Trash2, Pencil, CalendarClock, Users, ArrowUp, ArrowDown,
  ToggleLeft, ToggleRight, UserPlus, CalendarDays, Bell, Clock, ShieldAlert, X,
} from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import EmptyState from '../EmptyState.jsx';
import Select from '../Select.jsx';

// A short, curated zone list plus whatever the browser reports, so the
// common cases are one click while anything else is still reachable. The
// server validates the final value against Intl either way.
const COMMON_ZONES = [
  'UTC', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo',
  'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago',
  'America/Los_Angeles', 'Australia/Sydney',
];

const ROTATION_TYPES = [
  { value: 'daily', label: 'Daily — hands off every day' },
  { value: 'weekly', label: 'Weekly — hands off every N days' },
  { value: 'custom', label: 'Custom length' },
];

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
}

function ScheduleModal({ initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [timezone, setTimezone] = useState(initial?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const zoneOptions = useMemo(() => {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const set = [...new Set([local, ...COMMON_ZONES].filter(Boolean))];
    if (timezone && !set.includes(timezone)) set.unshift(timezone);
    return set.map((z) => ({ value: z, label: z === local ? `${z} (this browser)` : z }));
  }, [timezone]);

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = { name, description, timezone };
      if (initial) await api.patch(`/oncall/schedules/${initial.id}`, body);
      else await api.post('/oncall/schedules', body);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit schedule' : 'New on-call schedule'} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Infrastructure primary" required />
        </div>
        <div>
          <label className="label">Description</label>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who covers production out of hours" />
        </div>
        <div>
          <label className="label">Timezone</label>
          <Select value={timezone} onChange={setTimezone} options={zoneOptions} />
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Handoffs happen at a wall-clock time in this zone, so they stay put across daylight-saving changes.
          </p>
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {initial ? 'Save' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function LayerModal({ scheduleId, initial, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || 'Primary');
  const [rotationType, setRotationType] = useState(initial?.rotation_type || 'weekly');
  const [lengthDays, setLengthDays] = useState(initial?.rotation_length_days ?? 7);
  const [handoff, setHandoff] = useState(initial?.handoff_time || '09:00');
  const [startDate, setStartDate] = useState(initial?.start_date || todayIso());
  const [restricted, setRestricted] = useState(!!initial?.restriction);
  const [days, setDays] = useState(() => {
    try {
      const r = initial?.restriction ? JSON.parse(initial.restriction) : null;
      return Array.isArray(r?.days) ? r.days : [1, 2, 3, 4, 5];
    } catch { return [1, 2, 3, 4, 5]; }
  });
  const [startTime, setStartTime] = useState(() => {
    try { return (initial?.restriction ? JSON.parse(initial.restriction).start_time : null) || '09:00'; } catch { return '09:00'; }
  });
  const [endTime, setEndTime] = useState(() => {
    try { return (initial?.restriction ? JSON.parse(initial.restriction).end_time : null) || '17:00'; } catch { return '17:00'; }
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const toggleDay = (d) => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = {
        name,
        rotation_type: rotationType,
        rotation_length_days: rotationType === 'daily' ? 1 : Number(lengthDays) || 7,
        handoff_time: handoff,
        start_date: startDate,
        restriction: restricted ? { days, start_time: startTime, end_time: endTime } : null,
      };
      if (initial) await api.patch(`/oncall/layers/${initial.id}`, body);
      else await api.post(`/oncall/schedules/${scheduleId}/layers`, body);
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial ? 'Edit layer' : 'Add a rotation layer'} onClose={onClose} maxWidth="max-w-xl">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Layer name</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div>
            <label className="label">Rotation</label>
            <Select value={rotationType} onChange={setRotationType} options={ROTATION_TYPES} />
          </div>
        </div>
        <div className="grid grid-cols-3 gap-3">
          {rotationType !== 'daily' && (
            <div>
              <label className="label">Length (days)</label>
              <input type="number" min="1" max="365" className="input" value={lengthDays} onChange={(e) => setLengthDays(e.target.value)} />
            </div>
          )}
          <div>
            <label className="label">Handoff time</label>
            <input type="time" className="input" value={handoff} onChange={(e) => setHandoff(e.target.value)} required />
          </div>
          <div>
            <label className="label">Rotation starts</label>
            <input type="date" className="input" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
          <button type="button" onClick={() => setRestricted((v) => !v)} className="flex items-center gap-2 text-sm font-medium text-slate-700 dark:text-slate-200">
            {restricted ? <ToggleRight size={18} className="text-brand-600" /> : <ToggleLeft size={18} className="text-slate-400" />}
            Only active during certain hours
          </button>
          <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
            Use this for a business-hours layer stacked over a 24×7 one. Outside these hours the layer below takes over.
          </p>
          {restricted && (
            <div className="mt-3 space-y-3">
              <div className="flex flex-wrap gap-1.5">
                {DAY_LABELS.map((label, i) => (
                  <button
                    key={label} type="button" onClick={() => toggleDay(i)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${
                      days.includes(i)
                        ? 'bg-brand-600 text-white'
                        : 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">From</label>
                  <input type="time" className="input" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </div>
                <div>
                  <label className="label">To</label>
                  <input type="time" className="input" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                An end time earlier than the start wraps past midnight — e.g. 22:00 to 06:00 for a night shift.
              </p>
            </div>
          )}
        </div>

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} {initial ? 'Save' : 'Add layer'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function MembersModal({ layer, agents, onClose, onSaved }) {
  const [selected, setSelected] = useState(() => layer.members.map((m) => m.user_id));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const add = (userId) => { if (userId && !selected.includes(userId)) setSelected([...selected, userId]); };
  const remove = (userId) => setSelected(selected.filter((id) => id !== userId));
  const move = (index, delta) => {
    const next = [...selected];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setSelected(next);
  };

  const nameFor = (id) => agents.find((a) => a.id === id)?.name || id;

  const submit = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/oncall/layers/${layer.id}/members`, { user_ids: selected });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const unselected = agents.filter((a) => !selected.includes(a.id));

  return (
    <Modal title={`Rotation order — ${layer.name}`} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          People take the rotation in this order, one turn each per cycle. Reorder to change who is up next.
        </p>

        {selected.length === 0 ? (
          <p className="rounded-xl border border-dashed border-slate-300 p-4 text-center text-sm text-slate-400 dark:border-slate-700">
            Nobody in this rotation yet — it will put nobody on call.
          </p>
        ) : (
          <ol className="space-y-1.5">
            {selected.map((id, i) => (
              <li key={id} className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 dark:border-white/10">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-brand-50 text-xs font-bold text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">
                  {i + 1}
                </span>
                <span className="flex-1 truncate text-sm text-slate-700 dark:text-slate-200">{nameFor(id)}</span>
                <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="btn-ghost p-1 disabled:opacity-30" aria-label="Move up"><ArrowUp size={14} /></button>
                <button type="button" onClick={() => move(i, 1)} disabled={i === selected.length - 1} className="btn-ghost p-1 disabled:opacity-30" aria-label="Move down"><ArrowDown size={14} /></button>
                <button type="button" onClick={() => remove(id)} className="btn-ghost p-1 text-red-500" aria-label="Remove"><X size={14} /></button>
              </li>
            ))}
          </ol>
        )}

        {unselected.length > 0 && (
          <div>
            <label className="label">Add someone</label>
            <Select
              value=""
              onChange={add}
              options={[{ value: '', label: 'Pick an agent…' }, ...unselected.map((a) => ({ value: a.id, label: a.name }))]}
            />
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="button" onClick={submit} disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save rotation
          </button>
        </div>
      </div>
    </Modal>
  );
}

function OverrideModal({ schedule, agents, onClose, onSaved }) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const localInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

  const [userId, setUserId] = useState(agents[0]?.id || '');
  const [startAt, setStartAt] = useState(localInput(now));
  const [endAt, setEndAt] = useState(localInput(new Date(now.getTime() + 12 * 3600 * 1000)));
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      await api.post(`/oncall/schedules/${schedule.id}/overrides`, {
        user_id: userId,
        start_at: new Date(startAt).toISOString(),
        end_at: new Date(endAt).toISOString(),
        reason,
      });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Add an override" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <p className="text-xs text-slate-500 dark:text-slate-400">
          An override beats every layer for its window — the escape hatch for swaps and cover.
        </p>
        <div>
          <label className="label">Who is covering</label>
          <Select value={userId} onChange={setUserId} options={agents.map((a) => ({ value: a.id, label: a.name }))} />
        </div>
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
          <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Covering while Priya is at a wedding" />
        </div>
        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Add override
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EscalationEditor({ schedule, agents, groups, onSaved }) {
  const [steps, setSteps] = useState(() => schedule.escalation_steps.map((s) => ({ ...s })));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setSteps(schedule.escalation_steps.map((s) => ({ ...s }))); }, [schedule.id, schedule.escalation_steps]);

  const addStep = () => setSteps([...steps, { target_type: 'oncall_layer', target_id: null, delay_minutes: steps.length ? 15 : 0 }]);
  const update = (i, patch) => setSteps(steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  const remove = (i) => setSteps(steps.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await api.put(`/oncall/schedules/${schedule.id}/escalation`, { steps });
      onSaved();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const targetOptions = (type) => {
    if (type === 'user') return agents.map((a) => ({ value: a.id, label: a.name }));
    if (type === 'group') return groups.map((g) => ({ value: g.id, label: g.name }));
    if (type === 'role') return [{ value: 'admin', label: 'All admins' }, { value: 'agent', label: 'All agents' }];
    return [];
  };

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
            <Bell size={14} /> Escalation steps
          </h4>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Who gets paged if an alert on this schedule is not acknowledged. Delays are measured from when the alert first fired.
          </p>
        </div>
        <button onClick={addStep} className="btn-secondary shrink-0 text-xs"><Plus size={13} /> Step</button>
      </div>

      {steps.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-3 text-center text-xs text-slate-400 dark:border-slate-700">
          No escalation steps — an unacknowledged alert will not be chased.
        </p>
      ) : (
        <div className="space-y-1.5">
          {steps.map((step, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 dark:border-white/10">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-lg bg-amber-50 text-xs font-bold text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{i + 1}</span>
              <div className="flex items-center gap-1 text-xs text-slate-500 dark:text-slate-400">
                after
                <input
                  type="number" min="0" max="1440"
                  className="input w-16 px-2 py-1 text-xs"
                  value={step.delay_minutes}
                  onChange={(e) => update(i, { delay_minutes: Number(e.target.value) })}
                />
                min, page
              </div>
              <Select
                className="w-auto min-w-[150px]"
                value={step.target_type}
                onChange={(v) => update(i, { target_type: v, target_id: v === 'oncall_layer' ? null : '' })}
                options={[
                  { value: 'oncall_layer', label: 'Whoever is on call' },
                  { value: 'user', label: 'A specific person' },
                  { value: 'group', label: 'A group' },
                  { value: 'role', label: 'A role' },
                ]}
              />
              {step.target_type !== 'oncall_layer' && (
                <Select
                  className="w-auto min-w-[150px]"
                  value={step.target_id || ''}
                  onChange={(v) => update(i, { target_id: v })}
                  options={[{ value: '', label: 'Pick…' }, ...targetOptions(step.target_type)]}
                />
              )}
              <button onClick={() => remove(i)} className="btn-ghost ml-auto p-1 text-red-500" aria-label="Remove step"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      <button onClick={save} disabled={saving} className="btn-secondary text-xs">
        {saving ? <Loader2 size={13} className="animate-spin" /> : null} Save escalation
      </button>
    </div>
  );
}

// The calendar preview. Sampled server-side from the same resolver that
// decides paging, so what is shown here is exactly who would be paged.
function ShiftTimeline({ scheduleId }) {
  const [shifts, setShifts] = useState(null);
  const [days, setDays] = useState(14);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setShifts(null);
    setError('');
    api.get(`/oncall/schedules/${scheduleId}/shifts?days=${days}&step=60`)
      .then((d) => { if (!cancelled) setShifts(d.shifts); })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [scheduleId, days]);

  const palette = ['bg-brand-500', 'bg-cyan-500', 'bg-emerald-500', 'bg-amber-500', 'bg-violet-500', 'bg-rose-500'];
  const colorFor = useMemo(() => {
    const map = new Map();
    return (userId) => {
      if (!userId) return 'bg-slate-300 dark:bg-slate-700';
      if (!map.has(userId)) map.set(userId, palette[map.size % palette.length]);
      return map.get(userId);
    };
  }, [shifts]);

  if (error) return <p className="text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!shifts) return <p className="flex items-center gap-2 py-4 text-sm text-slate-400"><Loader2 size={14} className="animate-spin" /> Working out the rota…</p>;

  const total = shifts.length
    ? new Date(shifts[shifts.length - 1].end).getTime() - new Date(shifts[0].start).getTime()
    : 0;
  const origin = shifts.length ? new Date(shifts[0].start).getTime() : 0;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <CalendarDays size={14} /> Who is on call next
        </h4>
        <Select
          className="w-auto min-w-[110px]"
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          options={[{ value: '7', label: 'Next 7 days' }, { value: '14', label: 'Next 14 days' }, { value: '30', label: 'Next 30 days' }]}
        />
      </div>

      {shifts.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 p-3 text-center text-xs text-slate-400 dark:border-slate-700">
          Nothing to show — add a layer with at least one member.
        </p>
      ) : (
        <>
          <div className="flex h-8 w-full overflow-hidden rounded-lg border border-slate-200 dark:border-white/10">
            {shifts.map((s, i) => {
              const width = total > 0 ? ((new Date(s.end).getTime() - new Date(s.start).getTime()) / total) * 100 : 100 / shifts.length;
              return (
                <div
                  key={i}
                  className={`${colorFor(s.user?.id)} h-full`}
                  style={{ width: `${width}%` }}
                  title={`${s.user?.name || 'Nobody'} — ${fmtDateTime(s.start)} to ${fmtDateTime(s.end)}${s.reason ? ` (${s.reason})` : ''}`}
                />
              );
            })}
          </div>
          <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
            {shifts.map((s, i) => (
              <li key={i} className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${colorFor(s.user?.id)}`} />
                <span className="font-medium text-slate-700 dark:text-slate-200">{s.user?.name || 'Nobody on call'}</span>
                <span className="text-slate-400">{fmtDateTime(s.start)} → {fmtDateTime(s.end)}</span>
                {s.source === 'override' && <span className="badge bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">override</span>}
                {s.layerName && s.source === 'rotation' && <span className="text-slate-400">· {s.layerName}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default function OnCallScheduleTab() {
  const [schedules, setSchedules] = useState(null);
  const [agents, setAgents] = useState([]);
  const [groups, setGroups] = useState([]);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState(null);
  const [scheduleModal, setScheduleModal] = useState(null); // 'new' | schedule
  const [layerModal, setLayerModal] = useState(null);       // { scheduleId, layer? }
  const [membersModal, setMembersModal] = useState(null);   // layer
  const [overrideModal, setOverrideModal] = useState(null); // schedule

  const load = async () => {
    setError('');
    try {
      const [{ schedules: s }, { roster }, groupsResp] = await Promise.all([
        api.get('/oncall/schedules'),
        api.get('/assignment/roster').catch(() => ({ roster: [] })),
        api.get('/groups').catch(() => ({ groups: [] })),
      ]);
      setSchedules(s);
      setAgents(roster.map((r) => ({ id: r.id, name: r.name })));
      setGroups(groupsResp.groups || []);
      setOpenId((cur) => cur || s[0]?.id || null);
    } catch (e) {
      setError(e.message);
      setSchedules([]);
    }
  };

  useEffect(() => { load(); }, []);

  const removeSchedule = async (schedule) => {
    if (!window.confirm(`Delete "${schedule.name}"? Its layers, overrides and escalation steps go with it.`)) return;
    await api.del(`/oncall/schedules/${schedule.id}`);
    setOpenId(null);
    load();
  };

  const toggleSchedule = async (schedule) => {
    await api.patch(`/oncall/schedules/${schedule.id}`, { enabled: !schedule.enabled });
    load();
  };

  const removeLayer = async (layer) => {
    if (!window.confirm(`Delete layer "${layer.name}"?`)) return;
    await api.del(`/oncall/layers/${layer.id}`);
    load();
  };

  const removeOverride = async (override) => {
    await api.del(`/oncall/overrides/${override.id}`);
    load();
  };

  if (error && !schedules?.length) {
    return (
      <div className="py-10 text-center text-sm">
        <p className="text-red-600 dark:text-red-400">{error}</p>
        <button onClick={load} className="btn-secondary mx-auto mt-2 text-xs">Retry</button>
      </div>
    );
  }

  if (!schedules) {
    return <p className="flex items-center justify-center gap-2 py-10 text-sm text-slate-400"><Loader2 size={16} className="animate-spin" /> Loading schedules…</p>;
  }

  const open = schedules.find((s) => s.id === openId) || null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 font-display text-lg font-semibold text-slate-800 dark:text-slate-100">
            <CalendarClock size={18} className="text-brand-600" /> On-call schedules
          </h3>
          <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">
            Rotations are computed from their rules, never stored as fixed shifts — so editing a rotation updates the rota immediately, everywhere.
          </p>
        </div>
        <button onClick={() => setScheduleModal('new')} className="btn-primary shrink-0"><Plus size={14} /> New schedule</button>
      </div>

      {schedules.length === 0 ? (
        <EmptyState
          icon={CalendarClock}
          title="No on-call schedules yet"
          description="Create one to define who is responsible out of hours, then point an alert rule at it so unacknowledged alerts get chased."
          action={<button onClick={() => setScheduleModal('new')} className="btn-primary"><Plus size={14} /> New schedule</button>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,280px)_minmax(0,1fr)]">
          {/* schedule list */}
          <div className="space-y-2">
            {schedules.map((s) => (
              <button
                key={s.id}
                onClick={() => setOpenId(s.id)}
                className={`w-full rounded-2xl border p-3 text-left transition-colors ${
                  s.id === openId
                    ? 'border-brand-400 bg-brand-50/60 dark:border-brand-500/40 dark:bg-brand-500/10'
                    : 'border-slate-200 hover:bg-slate-50 dark:border-white/10 dark:hover:bg-slate-800/50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">{s.name}</span>
                  {!s.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">off</span>}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <Clock size={11} /> {s.timezone}
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 text-xs">
                  <span className={`h-2 w-2 rounded-full ${s.current_oncall ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-600'}`} />
                  <span className="truncate text-slate-600 dark:text-slate-300">
                    {s.current_oncall ? s.current_oncall.name : 'Nobody on call'}
                  </span>
                </div>
              </button>
            ))}
          </div>

          {/* detail */}
          {open && (
            <div className="space-y-4">
              <div className="card space-y-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="truncate font-display text-base font-semibold text-slate-800 dark:text-slate-100">{open.name}</h4>
                    {open.description && <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{open.description}</p>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button onClick={() => toggleSchedule(open)} className="btn-ghost p-1.5" aria-label={open.enabled ? 'Disable' : 'Enable'}>
                      {open.enabled ? <ToggleRight size={18} className="text-emerald-600" /> : <ToggleLeft size={18} className="text-slate-400" />}
                    </button>
                    <button onClick={() => setScheduleModal(open)} className="btn-ghost p-1.5" aria-label="Edit"><Pencil size={14} /></button>
                    <button onClick={() => removeSchedule(open)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete"><Trash2 size={14} /></button>
                  </div>
                </div>

                <div className={`flex items-center gap-2 rounded-xl px-3 py-2 text-sm ${
                  open.current_oncall
                    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300'
                    : 'bg-slate-50 text-slate-500 dark:bg-slate-800/60 dark:text-slate-400'
                }`}>
                  <ShieldAlert size={15} className="shrink-0" />
                  <span>
                    <strong>{open.current_oncall ? open.current_oncall.name : 'Nobody'}</strong> is on call right now
                    {open.current_reason ? ` — ${open.current_reason}` : ''}
                  </span>
                </div>
              </div>

              {/* layers */}
              <div className="card space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="flex items-center gap-1.5 text-sm font-semibold text-slate-700 dark:text-slate-200">
                      <Users size={14} /> Rotation layers
                    </h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Higher layers win while they are active.</p>
                  </div>
                  <button onClick={() => setLayerModal({ scheduleId: open.id })} className="btn-secondary shrink-0 text-xs"><Plus size={13} /> Layer</button>
                </div>

                {open.layers.length === 0 ? (
                  <p className="rounded-xl border border-dashed border-slate-300 p-3 text-center text-xs text-slate-400 dark:border-slate-700">
                    No layers yet — nobody is on call until you add one.
                  </p>
                ) : (
                  <div className="space-y-2">
                    {[...open.layers].reverse().map((layer) => {
                      let restriction = null;
                      try { restriction = layer.restriction ? JSON.parse(layer.restriction) : null; } catch { restriction = null; }
                      return (
                        <div key={layer.id} className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="badge bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300">L{layer.layer_order}</span>
                              <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{layer.name}</span>
                              {!layer.enabled && <span className="badge bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400">off</span>}
                            </div>
                            <div className="flex items-center gap-1">
                              <button onClick={() => setMembersModal(layer)} className="btn-secondary text-xs"><UserPlus size={12} /> {layer.members.length} in rotation</button>
                              <button onClick={() => setLayerModal({ scheduleId: open.id, layer })} className="btn-ghost p-1.5" aria-label="Edit layer"><Pencil size={13} /></button>
                              <button onClick={() => removeLayer(layer)} className="btn-ghost p-1.5 text-red-500" aria-label="Delete layer"><Trash2 size={13} /></button>
                            </div>
                          </div>
                          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
                            <span>
                              {layer.rotation_type === 'daily' ? 'Daily' : `Every ${layer.rotation_length_days} days`} at {layer.handoff_time}
                            </span>
                            <span>Since {layer.start_date}</span>
                            {restriction && (
                              <span>
                                Only {(restriction.days || []).map((d) => DAY_LABELS[d]).join(', ') || 'any day'}
                                {restriction.start_time ? ` ${restriction.start_time}–${restriction.end_time}` : ''}
                              </span>
                            )}
                          </div>
                          {layer.members.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {layer.members.map((m, i) => (
                                <span key={m.id} className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                                  {i + 1}. {m.name}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="card p-4"><ShiftTimeline scheduleId={open.id} /></div>

              {/* overrides */}
              <div className="card space-y-3 p-4">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-200">Overrides</h4>
                    <p className="text-xs text-slate-500 dark:text-slate-400">Temporary cover that beats the rotation.</p>
                  </div>
                  <button onClick={() => setOverrideModal(open)} className="btn-secondary shrink-0 text-xs"><Plus size={13} /> Override</button>
                </div>
                {open.overrides.length === 0 ? (
                  <p className="text-xs text-slate-400">None scheduled.</p>
                ) : (
                  <ul className="space-y-1.5">
                    {open.overrides.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-xs dark:border-white/10">
                        <span className="font-medium text-slate-800 dark:text-slate-100">{o.user_name}</span>
                        <span className="text-slate-400">{fmtDateTime(o.start_at)} → {fmtDateTime(o.end_at)}</span>
                        {o.reason && <span className="text-slate-500 dark:text-slate-400">· {o.reason}</span>}
                        <button onClick={() => removeOverride(o)} className="btn-ghost ml-auto p-1 text-red-500" aria-label="Remove override"><Trash2 size={12} /></button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div className="card p-4">
                <EscalationEditor schedule={open} agents={agents} groups={groups} onSaved={load} />
              </div>
            </div>
          )}
        </div>
      )}

      {scheduleModal && (
        <ScheduleModal
          initial={scheduleModal === 'new' ? null : scheduleModal}
          onClose={() => setScheduleModal(null)}
          onSaved={() => { setScheduleModal(null); load(); }}
        />
      )}
      {layerModal && (
        <LayerModal
          scheduleId={layerModal.scheduleId}
          initial={layerModal.layer || null}
          onClose={() => setLayerModal(null)}
          onSaved={() => { setLayerModal(null); load(); }}
        />
      )}
      {membersModal && (
        <MembersModal
          layer={membersModal}
          agents={agents}
          onClose={() => setMembersModal(null)}
          onSaved={() => { setMembersModal(null); load(); }}
        />
      )}
      {overrideModal && (
        <OverrideModal
          schedule={overrideModal}
          agents={agents}
          onClose={() => setOverrideModal(null)}
          onSaved={() => { setOverrideModal(null); load(); }}
        />
      )}
    </div>
  );
}
