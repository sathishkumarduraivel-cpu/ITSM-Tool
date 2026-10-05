import { useEffect, useState } from 'react';
import { Plus, Trash2, Loader2, Pencil, ToggleLeft, ToggleRight, FileStack } from 'lucide-react';
import { api } from '../../lib/api.js';
import Modal from '../Modal.jsx';
import EmptyState from '../EmptyState.jsx';
import Select from '../Select.jsx';
import { CASE_TYPES, TRACKS } from '../../lib/hrCaseConstants.js';

function emptyTask() {
  return { title: '', description: '', track: 'it', stage_key: '', due_offset_days: 0, requires_decision: false, depends_on_index: null, group_id: '' };
}

function TemplateModal({ initial, groups, stagesByType, onClose, onSaved }) {
  const [name, setName] = useState(initial?.name || '');
  const [caseType, setCaseType] = useState(initial?.case_type || 'onboarding');
  const [roleMatch, setRoleMatch] = useState(initial?.role_match || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [tasks, setTasks] = useState(initial?.tasks?.length ? initial.tasks.map((t) => ({ ...t, group_id: t.group_id || '' })) : [emptyTask()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const stages = stagesByType[caseType] || [];
  const updateTask = (i, patch) => setTasks((ts) => ts.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  const addTask = () => setTasks((ts) => [...ts, { ...emptyTask(), stage_key: stages[0]?.key || '' }]);
  const removeTask = (i) => setTasks((ts) => ts.filter((_, idx) => idx !== i).map((t) => (
    t.depends_on_index === i ? { ...t, depends_on_index: null } : t.depends_on_index > i ? { ...t, depends_on_index: t.depends_on_index - 1 } : t
  )));

  const submit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const cleanTasks = tasks.filter((t) => t.title.trim()).map((t) => ({
        title: t.title.trim(), description: t.description || '', track: t.track,
        stage_key: t.stage_key || stages[0]?.key, due_offset_days: Number(t.due_offset_days) || 0,
        requires_decision: !!t.requires_decision, depends_on_index: t.depends_on_index === '' ? null : t.depends_on_index,
        group_id: t.group_id || null,
      }));
      const payload = { name, case_type: caseType, role_match: roleMatch, description, tasks: cleanTasks };
      if (initial?.id) await api.patch(`/hr-cases/templates/${initial.id}`, payload);
      else await api.post('/hr-cases/templates', payload);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={initial?.id ? 'Edit template' : 'New checklist template'} onClose={onClose} maxWidth="max-w-3xl">
      <form onSubmit={submit} className="space-y-3">
        {error && <div className="text-sm text-red-600 bg-red-50 dark:bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" required value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div>
            <label className="label">Case type</label>
            <Select value={caseType} disabled={!!initial?.id} onChange={setCaseType} options={CASE_TYPES} />
          </div>
          <div>
            <label className="label">Role match (optional hint)</label>
            <input className="input" placeholder="e.g. Engineer" value={roleMatch} onChange={(e) => setRoleMatch(e.target.value)} />
          </div>
          <div>
            <label className="label">Description</label>
            <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <label className="label mb-0">Tasks ({tasks.filter((t) => t.title.trim()).length})</label>
            <button type="button" onClick={addTask} className="text-xs text-brand-600 hover:text-brand-700 font-medium">+ Add task</button>
          </div>
          <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
            {tasks.map((t, i) => (
              <div key={i} className="border border-slate-200 dark:border-slate-700 rounded-lg p-2 space-y-1.5">
                <div className="flex gap-2">
                  <input className="input flex-1" placeholder="Task title" value={t.title} onChange={(e) => updateTask(i, { title: e.target.value })} />
                  <button type="button" onClick={() => removeTask(i)} className="text-slate-400 hover:text-red-500 shrink-0"><Trash2 size={14} /></button>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-1.5">
                  <Select value={t.track} onChange={(v) => updateTask(i, { track: v })} options={TRACKS} />
                  <Select
                    value={t.stage_key} onChange={(v) => updateTask(i, { stage_key: v })}
                    options={stages.filter((s) => s.key !== 'complete').map((s) => ({ value: s.key, label: s.label }))}
                  />
                  <Select
                    value={t.group_id} onChange={(v) => updateTask(i, { group_id: v })}
                    options={[{ value: '', label: 'No group' }, ...groups.map((g) => ({ value: g.id, label: g.name }))]}
                  />
                  <input className="input" type="number" title="Days offset from start/last-day" value={t.due_offset_days} onChange={(e) => updateTask(i, { due_offset_days: e.target.value })} />
                  <Select
                    value={t.depends_on_index ?? ''} onChange={(v) => updateTask(i, { depends_on_index: v === '' ? null : Number(v) })}
                    options={[{ value: '', label: 'No dependency' }, ...tasks.map((other, j) => (j !== i && other.title.trim() ? { value: j, label: `After: ${other.title}` } : null)).filter(Boolean)]}
                  />
                </div>
                <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                  <input type="checkbox" checked={t.requires_decision} onChange={(e) => updateTask(i, { requires_decision: e.target.checked, track: e.target.checked ? 'approval' : t.track })} />
                  Needs approve/reject sign-off
                </label>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          <button type="submit" disabled={saving || !name.trim()} className="btn-primary">
            {saving ? <Loader2 size={14} className="animate-spin" /> : null} Save template
          </button>
        </div>
      </form>
    </Modal>
  );
}

export default function HrCaseTemplatesTab() {
  const [templates, setTemplates] = useState([]);
  const [groups, setGroups] = useState([]);
  const [stagesByType, setStagesByType] = useState({ onboarding: [], offboarding: [] });
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null); // null | 'new' | template

  const load = async () => {
    setLoading(true);
    try {
      const [t, g, s] = await Promise.all([api.get('/hr-cases/templates'), api.get('/groups'), api.get('/hr-cases/stages')]);
      setTemplates(t.templates);
      setGroups(g.groups);
      setStagesByType(s);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleEnabled = async (tpl) => {
    await api.patch(`/hr-cases/templates/${tpl.id}`, { enabled: !tpl.enabled });
    load();
  };
  const remove = async (tpl) => {
    if (!confirm(`Delete template "${tpl.name}"?`)) return;
    await api.del(`/hr-cases/templates/${tpl.id}`);
    load();
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-500 dark:text-slate-400">Reusable department checklists admins can apply when starting a new onboarding/offboarding case.</p>
        <button onClick={() => setModal('new')} className="btn-primary text-xs"><Plus size={13} /> New template</button>
      </div>

      {loading && <div className="text-sm text-slate-400">Loading…</div>}
      {!loading && templates.length === 0 && <EmptyState icon={FileStack} description="No templates yet — build one, or let cases start from a blank checklist / Sona draft." />}

      <div className="space-y-2">
        {templates.map((tpl) => (
          <div key={tpl.id} className="card p-3 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-medium text-slate-800 dark:text-slate-100">{tpl.name}</span>
                <span className="badge bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300 capitalize">{tpl.case_type}</span>
                {!tpl.enabled && <span className="badge bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500">disabled</span>}
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400 truncate">{tpl.description || 'No description'} · {tpl.tasks.length} tasks</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button onClick={() => toggleEnabled(tpl)} className="text-slate-400 hover:text-slate-600" title={tpl.enabled ? 'Disable' : 'Enable'}>
                {tpl.enabled ? <ToggleRight size={20} className="text-emerald-500" /> : <ToggleLeft size={20} />}
              </button>
              <button onClick={() => setModal(tpl)} className="btn-ghost text-xs"><Pencil size={13} /> Edit</button>
              <button onClick={() => remove(tpl)} className="text-slate-400 hover:text-red-500"><Trash2 size={15} /></button>
            </div>
          </div>
        ))}
      </div>

      {modal && (
        <TemplateModal
          initial={modal === 'new' ? null : modal}
          groups={groups}
          stagesByType={stagesByType}
          onClose={() => setModal(null)}
          onSaved={() => { setModal(null); load(); }}
        />
      )}
    </div>
  );
}
