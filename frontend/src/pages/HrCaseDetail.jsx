import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Loader2, Plus, Bot, X, Ban } from 'lucide-react';
import { api } from '../lib/api.js';
import StageProgress from '../components/hr-cases/StageProgress.jsx';
import TrackSection from '../components/hr-cases/TrackSection.jsx';
import RiskBadge from '../components/hr-cases/RiskBadge.jsx';
import { TRACKS, CASE_STATUS_STYLE } from '../lib/hrCaseConstants.js';
import Select from '../components/Select.jsx';
import { usePageTitle } from '../hooks/usePageTitle.js';

function AddTaskForm({ caseType, currentStage, stages, groups, agents, onAdd, onClose }) {
  // Defaults to the case's current stage (not always the first one) --
  // otherwise an ad-hoc task added later in a case would silently regress
  // the stepper backward to whatever stage it was defaulted into.
  const defaultStage = stages.find((s) => s.key === currentStage && s.key !== 'complete') || stages[0];
  const [form, setForm] = useState({ title: '', track: 'it', stage_key: defaultStage?.key || '', group_id: '', assignee_id: '', due_at: '', requires_decision: false });
  const [saving, setSaving] = useState(false);
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.title.trim()) return;
    setSaving(true);
    try {
      await onAdd({ ...form, group_id: form.group_id || null, assignee_id: form.assignee_id || null, due_at: form.due_at || null });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit} className="card-flat p-3 space-y-2">
      <div className="flex gap-2">
        <input className="input flex-1" autoFocus placeholder="Task title" value={form.title} onChange={(e) => set({ title: e.target.value })} />
        <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-600"><X size={16} /></button>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Select value={form.track} onChange={(v) => set({ track: v })} options={TRACKS} />
        <Select
          value={form.stage_key} onChange={(v) => set({ stage_key: v })}
          options={stages.filter((s) => s.key !== 'complete').map((s) => ({ value: s.key, label: s.label }))}
        />
        <Select value={form.group_id} onChange={(v) => set({ group_id: v })} options={[{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]} />
        <Select value={form.assignee_id} onChange={(v) => set({ assignee_id: v })} options={[{ value: '', label: 'Unassigned' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />
      </div>
      <div className="flex items-center gap-3">
        <input className="input w-auto" type="date" value={form.due_at} onChange={(e) => set({ due_at: e.target.value })} />
        <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
          <input type="checkbox" checked={form.requires_decision} onChange={(e) => set({ requires_decision: e.target.checked, track: e.target.checked ? 'approval' : form.track })} />
          Needs approve/reject sign-off
        </label>
        <button type="submit" disabled={saving || !form.title.trim()} className="btn-primary text-xs ml-auto">
          {saving ? <Loader2 size={13} className="animate-spin" /> : null} Add task
        </button>
      </div>
    </form>
  );
}

export default function HrCaseDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [kase, setKase] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [stages, setStages] = useState([]);
  const [agents, setAgents] = useState([]);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const load = async () => {
    setLoadError('');
    try {
      const [detail, u, g] = await Promise.all([
        api.get(`/hr-cases/${id}`),
        api.get('/auth/users'),
        api.get('/groups'),
      ]);
      setKase(detail.case);
      setTasks(detail.tasks);
      setStages(detail.stages);
      setAgents(u.users.filter((a) => a.role === 'agent' || a.role === 'admin'));
      setGroups(g.groups);
    } catch (e) {
      // Without this catch, a failed fetch (404 on a deleted case, a
      // permission change, a transient network blip) left `loading` stuck
      // true forever -- the page (including the back-arrow, gated below)
      // never rendered at all, a permanent dead end with no way out.
      setLoadError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateTask = async (taskId, patch) => {
    await api.patch(`/hr-cases/${id}/tasks/${taskId}`, patch);
    load();
  };
  const deleteTask = async (taskId) => {
    await api.del(`/hr-cases/${id}/tasks/${taskId}`);
    load();
  };
  const decideTask = async (taskId, approve) => {
    await api.post(`/hr-cases/${id}/tasks/${taskId}/decide`, { approve });
    load();
  };
  const addTask = async (form) => {
    await api.post(`/hr-cases/${id}/tasks`, form);
    load();
  };
  const cancelCase = async () => {
    if (!confirm(`Mark ${kase.employee_name}'s ${kase.case_type} case as cancelled?`)) return;
    await api.patch(`/hr-cases/${id}`, { status: 'cancelled' });
    load();
  };
  const setRisk = async (risk_level) => {
    await api.patch(`/hr-cases/${id}`, { risk_level });
    load();
  };

  usePageTitle(kase ? `${kase.employee_name} — ${kase.case_type === 'offboarding' ? 'Offboarding' : 'Onboarding'}` : null);

  if (loading || !kase) {
    if (loadError) {
      return (
        <div className="h-64 flex flex-col items-center justify-center gap-3 text-center">
          <p className="text-sm text-red-600 dark:text-red-400">{loadError}</p>
          <div className="flex items-center gap-2">
            <button onClick={() => navigate('/hr-cases')} className="btn-secondary text-xs"><ArrowLeft size={13} /> Back</button>
            <button onClick={load} className="btn-primary text-xs">Retry</button>
          </div>
        </div>
      );
    }
    return <div className="h-64 flex items-center justify-center text-slate-400 text-sm"><Loader2 size={18} className="animate-spin mr-2" /> Loading case…</div>;
  }

  const hasAiTasks = tasks.some((t) => t.source === 'ai');
  const tracksPresent = TRACKS.filter((t) => tasks.some((task) => task.track === t.value));

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3">
        <button onClick={() => navigate('/hr-cases')} className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 rounded-lg p-1.5 transition-colors shrink-0 mt-0.5" title="Back">
          <ArrowLeft size={18} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-display font-bold text-slate-800 dark:text-slate-100">{kase.employee_name}</h1>
            <span className={`badge ${CASE_STATUS_STYLE[kase.status]}`}>{kase.status.replace('_', ' ')}</span>
            {kase.case_type === 'offboarding' && <RiskBadge level={kase.risk_level} />}
          </div>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            {kase.job_title || 'No title set'}{kase.department ? ` · ${kase.department}` : ''}{kase.location ? ` · ${kase.location}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {kase.case_type === 'offboarding' && kase.status === 'in_progress' && (
            <Select
              size="sm" className="w-auto" value={kase.risk_level} onChange={setRisk}
              options={[{ value: 'standard', label: 'Standard risk' }, { value: 'elevated', label: 'Elevated risk' }]}
            />
          )}
          {kase.status === 'in_progress' && (
            <button onClick={cancelCase} className="btn-secondary text-xs"><Ban size={13} /> Cancel case</button>
          )}
        </div>
      </div>

      {hasAiTasks && !bannerDismissed && (
        <div className="text-sm text-brand-700 dark:text-brand-400 bg-brand-50 dark:bg-brand-500/10 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <Bot size={14} className="shrink-0" /> Sona drafted part of this checklist — review each task before your team starts on it.
          <button onClick={() => setBannerDismissed(true)} className="ml-auto text-brand-400 hover:text-brand-600"><X size={14} /></button>
        </div>
      )}

      <div className="card p-4">
        <StageProgress stages={stages} currentStage={kase.stage} />
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-600 dark:text-slate-300">Checklist</h2>
        <button onClick={() => setShowAdd((s) => !s)} className="btn-secondary text-xs"><Plus size={13} /> Add task</button>
      </div>

      {showAdd && (
        <AddTaskForm caseType={kase.case_type} currentStage={kase.stage} stages={stages} groups={groups} agents={agents} onAdd={addTask} onClose={() => setShowAdd(false)} />
      )}

      {tasks.length === 0 && !showAdd && (
        <div className="card p-8 text-center text-sm text-slate-400">No tasks yet — add one, or go back and apply a template.</div>
      )}

      <div className="space-y-2">
        {tracksPresent.map((t) => (
          <TrackSection
            key={t.value}
            track={t.value}
            tasks={tasks.filter((task) => task.track === t.value)}
            agents={agents}
            groups={groups}
            onUpdate={updateTask}
            onDelete={deleteTask}
            onDecide={decideTask}
          />
        ))}
      </div>
    </div>
  );
}
